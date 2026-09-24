import { timingSafeEqual } from 'node:crypto'
import {
    OFFICIAL_PROVIDER_BASE_URL,
    PI_OFFICIAL_BASE_URL,
    PI_PROTOCOL_BY_PROVIDER,
    builtInBaseUrlForProtocol,
    isPiProvider,
    lookupBuiltIn,
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
    if (input.framework === 'codex') {
        key = credentials.openaiApiKey
        baseUrl = credentials.openaiBaseUrl
        protocol = 'openai_responses'
        defaultUrl = OFFICIAL_PROVIDER_BASE_URL.openai
    } else if (input.framework === 'gemini-cli') {
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
