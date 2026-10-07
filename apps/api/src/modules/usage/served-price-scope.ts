import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
    OFFICIAL_PROVIDER_BASE_URL,
    PI_OFFICIAL_BASE_URL,
    PI_PROTOCOL_BY_PROVIDER,
    builtInBaseUrlForProtocol,
    isPiProvider,
    isRouteNonce,
    lookupBuiltIn,
    routeAttestationMessage,
    type AgentFramework,
    type InferenceProtocol
} from '@manyfold/shared'
import type { UserModelProviderRow } from '@manyfold/db'
import type { ModelPriceScopeContext } from './usage-pricing.service'

export interface ServedPriceScope extends ModelPriceScopeContext {
    modelProviderId: string | null
    modelProviderBuiltInId: string | null
    modelProviderManagedBrand: string | null
}

export const UNKNOWN_PRICE_SCOPE: Readonly<ServedPriceScope> = Object.freeze({
    modelProviderId: null,
    modelProviderBuiltInId: null,
    modelProviderManagedBrand: null
})

const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null

export const priceScopeFromMetadata = (metadata: unknown): ServedPriceScope => {
    const scope = record(record(metadata)?.pricingScope)
    if (!scope || scope.version !== 1) return { ...UNKNOWN_PRICE_SCOPE }
    for (const key of Object.keys(UNKNOWN_PRICE_SCOPE)) {
        const value = scope[key]
        if (value !== null && (typeof value !== 'string' || !value.trim()))
            return { ...UNKNOWN_PRICE_SCOPE }
    }
    if (
        !scope.modelProviderId &&
        (scope.modelProviderBuiltInId || scope.modelProviderManagedBrand)
    )
        return { ...UNKNOWN_PRICE_SCOPE }
    return {
        modelProviderId: scope.modelProviderId as string | null,
        modelProviderBuiltInId: scope.modelProviderBuiltInId as string | null,
        modelProviderManagedBrand: scope.modelProviderManagedBrand as
            string | null
    }
}

const endpoint = (value: string): string | null => {
    try {
        const url = new URL(value)
        if (
            url.username ||
            url.password ||
            !['http:', 'https:'].includes(url.protocol)
        )
            return null
        url.pathname = url.pathname.replace(/\/+$/, '')
        url.hash = ''
        return url.toString()
    } catch {
        return null
    }
}

// The caller must dispatch this exact credential snapshot. Matching an endpoint
// alone never establishes a brand; a changed or unverifiable key stays unknown.
export const verifiedCodingPriceScope = (input: {
    framework: AgentFramework
    credentials: unknown
    provider: UserModelProviderRow | null
    providerApiKey: string | null
}): ServedPriceScope => {
    const { provider, providerApiKey } = input
    const credentials = record(input.credentials)
    if (!provider || !credentials || !providerApiKey)
        return { ...UNKNOWN_PRICE_SCOPE }
    let key: unknown
    let baseUrl: unknown
    let protocol: InferenceProtocol
    let defaultUrl: string
    if (input.framework === 'claude-code') {
        key = credentials.anthropicAuthToken
        baseUrl = credentials.anthropicBaseUrl
        protocol = 'anthropic_messages'
        defaultUrl = OFFICIAL_PROVIDER_BASE_URL.anthropic
    } else if (input.framework === 'codex') {
        key = credentials.openaiApiKey
        baseUrl = credentials.openaiBaseUrl
        protocol = 'openai_responses'
        defaultUrl = OFFICIAL_PROVIDER_BASE_URL.openai
    } else if (
        input.framework === 'gemini-cli' ||
        input.framework === 'antigravity-cli'
    ) {
        key = credentials.googleApiKey
        baseUrl = credentials.googleGeminiBaseUrl
        protocol = 'google_generate_content'
        defaultUrl = OFFICIAL_PROVIDER_BASE_URL.google
    } else if (input.framework === 'pi' && isPiProvider(credentials.provider)) {
        key = credentials.apiKey
        baseUrl = credentials.baseUrl
        protocol = PI_PROTOCOL_BY_PROVIDER[credentials.provider]
        defaultUrl = PI_OFFICIAL_BASE_URL[credentials.provider]
    } else return { ...UNKNOWN_PRICE_SCOPE }
    if (typeof key !== 'string' || !key) return { ...UNKNOWN_PRICE_SCOPE }
    const left = Buffer.from(key)
    const right = Buffer.from(providerApiKey)
    if (left.length !== right.length || !timingSafeEqual(left, right))
        return { ...UNKNOWN_PRICE_SCOPE }
    if (
        credentials.inferenceProtocol &&
        credentials.inferenceProtocol !== protocol
    )
        return { ...UNKNOWN_PRICE_SCOPE }
    const builtIn = provider.builtInId
        ? lookupBuiltIn(provider.builtInId)
        : null
    const providerUrl = builtIn
        ? builtInBaseUrlForProtocol(builtIn, protocol)
        : provider.inferenceProtocol === protocol
          ? (provider.baseUrl ?? defaultUrl)
          : null
    const dispatchedUrl = endpoint(
        typeof baseUrl === 'string' && baseUrl.trim()
            ? baseUrl.trim()
            : defaultUrl
    )
    if (
        !providerUrl ||
        !dispatchedUrl ||
        endpoint(providerUrl) !== dispatchedUrl
    )
        return { ...UNKNOWN_PRICE_SCOPE }
    return {
        modelProviderId: provider.id,
        modelProviderBuiltInId: provider.builtInId,
        modelProviderManagedBrand:
            provider.source === 'managed' ? provider.managedBrand : null
    }
}

// A runtime that picks its provider from its own config (an OpenClaw gateway,
// a Hermes ACP child) proves the route that served a turn instead: the daemon
// answers a nonce minted at dispatch with an HMAC keyed by the served
// provider's key (DAEMON_FEATURE_TURN_ROUTE_ATTESTATION). The receipt is what
// the API expected at dispatch — the bound row's scope and the answers its
// key would give on each endpoint that row can be reached at — so a binding
// that moves later, or an API restart before the answer, cannot change what
// the answer is checked against. It carries no key, only HMACs of the nonce.
export interface RouteReceipt {
    version: 1
    nonce: string
    scope: ServedPriceScope | null
    expected: string[]
}

export type RouteAttestationOutcome =
    // The answer matches the bound row's key on one of its endpoints.
    | 'verified'
    // An answer for some other key or endpoint.
    | 'mismatch'
    // The daemon could not resolve the route (it says why) or sent nothing.
    | 'missing'
    // Nothing was bound that a receipt could name.
    | 'no_candidate'
    // No receipt: a daemon without the feature, or a turn from before it.
    | 'unsupported'

export const createRouteNonce = (): string => randomBytes(32).toString('base64url')

const OPENAI_WIRE: readonly InferenceProtocol[] = [
    'openai_chat_completions',
    'openai_responses',
    'mistral_chat_completions'
]
// A runtime may speak another wire of the same family to a row's endpoint
// (OpenClaw always speaks chat completions to an OpenAI-compatible one).
const PROTOCOL_FAMILY: Record<InferenceProtocol, readonly InferenceProtocol[]> = {
    openai_chat_completions: OPENAI_WIRE,
    openai_responses: OPENAI_WIRE,
    mistral_chat_completions: OPENAI_WIRE,
    anthropic_messages: ['anthropic_messages'],
    google_generate_content: ['google_generate_content']
}
const OFFICIAL_ENDPOINT: Partial<Record<InferenceProtocol, string>> = {
    openai_chat_completions: OFFICIAL_PROVIDER_BASE_URL.openai,
    openai_responses: OFFICIAL_PROVIDER_BASE_URL.openai,
    anthropic_messages: OFFICIAL_PROVIDER_BASE_URL.anthropic,
    google_generate_content: OFFICIAL_PROVIDER_BASE_URL.google
}

// Every (protocol, endpoint) the row can be reached at: a built-in's own
// table, else the row's endpoint (the official one when it names none).
const rowRoutes = (
    provider: UserModelProviderRow
): Array<{ protocol: InferenceProtocol; baseUrl: string }> => {
    const declared: Array<{ protocol: InferenceProtocol; baseUrl: string }> = []
    if (provider.builtInId) {
        for (const entry of lookupBuiltIn(provider.builtInId)?.protocols ?? [])
            declared.push({ protocol: entry.protocol, baseUrl: entry.baseUrl })
    } else if (provider.inferenceProtocol) {
        const baseUrl =
            provider.baseUrl ?? OFFICIAL_ENDPOINT[provider.inferenceProtocol]
        if (baseUrl)
            declared.push({ protocol: provider.inferenceProtocol, baseUrl })
    }
    return declared.flatMap(({ protocol, baseUrl }) =>
        PROTOCOL_FAMILY[protocol].map((member) => ({
            protocol: member,
            baseUrl
        }))
    )
}

const routeAttestationFor = (input: {
    nonce: string
    apiKey: string
    protocol: InferenceProtocol
    baseUrl: string
}): string | null => {
    const message = routeAttestationMessage(input)
    return message && input.apiKey
        ? createHmac('sha256', input.apiKey).update(message).digest('hex')
        : null
}

// The receipt of the row bound at dispatch, decrypted in this process only.
export const routeReceiptFor = (input: {
    nonce: string
    provider: UserModelProviderRow | null
    providerApiKey: string | null
}): RouteReceipt => {
    const { nonce, provider, providerApiKey } = input
    const expected = new Set<string>()
    if (provider && providerApiKey)
        for (const route of rowRoutes(provider)) {
            const answer = routeAttestationFor({
                nonce,
                apiKey: providerApiKey,
                ...route
            })
            if (answer) expected.add(answer)
        }
    return {
        version: 1,
        nonce,
        scope:
            provider && expected.size > 0
                ? {
                      modelProviderId: provider.id,
                      modelProviderBuiltInId: provider.builtInId,
                      modelProviderManagedBrand:
                          provider.source === 'managed'
                              ? provider.managedBrand
                              : null
                  }
                : null,
        expected: [...expected]
    }
}

export const routeReceiptFromMetadata = (
    metadata: unknown
): RouteReceipt | null => {
    const receipt = record(record(metadata)?.routeReceipt)
    if (
        !receipt ||
        receipt.version !== 1 ||
        !isRouteNonce(receipt.nonce) ||
        !Array.isArray(receipt.expected) ||
        !receipt.expected.every(
            (answer) => typeof answer === 'string' && /^[0-9a-f]{64}$/.test(answer)
        )
    )
        return null
    const scope =
        receipt.scope === null
            ? null
            : priceScopeFromMetadata({
                  pricingScope: { version: 1, ...record(receipt.scope) }
              })
    return {
        version: 1,
        nonce: receipt.nonce,
        scope: scope && scope.modelProviderId ? scope : null,
        expected: receipt.expected as string[]
    }
}

const sameAnswer = (left: string, right: string): boolean => {
    const a = Buffer.from(left, 'hex')
    const b = Buffer.from(right, 'hex')
    return a.length === 32 && a.length === b.length && timingSafeEqual(a, b)
}

export const attestedPriceScope = (
    receipt: RouteReceipt | null,
    attestation: unknown
): { scope: ServedPriceScope; outcome: RouteAttestationOutcome } => {
    if (!receipt) return { scope: { ...UNKNOWN_PRICE_SCOPE }, outcome: 'unsupported' }
    if (typeof attestation !== 'string' || !/^[0-9a-f]{64}$/.test(attestation))
        return { scope: { ...UNKNOWN_PRICE_SCOPE }, outcome: 'missing' }
    if (!receipt.scope)
        return { scope: { ...UNKNOWN_PRICE_SCOPE }, outcome: 'no_candidate' }
    const matched = receipt.expected.reduce(
        (found, answer) => sameAnswer(answer, attestation) || found,
        false
    )
    return matched
        ? { scope: { ...receipt.scope }, outcome: 'verified' }
        : { scope: { ...UNKNOWN_PRICE_SCOPE }, outcome: 'mismatch' }
}
