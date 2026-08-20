import {
    BuiltInProviderEntry,
    InferenceProtocol,
    ProviderTestModel,
    ProviderTestResult,
    ProviderTestStatus
} from '@manyfold/shared'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { redactSensitiveUrlQuery } from '@/common/telemetry/redact-url'

const TIMEOUT_MS = 5000

type ModelFamily = 'claude'

interface RunTestInput {
    inferenceProtocol: InferenceProtocol
    apiKey: string
    baseUrl: string | null | undefined
    modelsListUrl?: string | null | undefined
    // Set when the caller knows the listing is shared by several model families
    // and wants only one of them. Opt-in per call, never inferred from the
    // protocol: see parseModels.
    modelFamily?: ModelFamily | null
}

interface RunBuiltInTestInput {
    entry: BuiltInProviderEntry
    apiKey: string
}

export interface BuiltInTestResult {
    ok: boolean
    status: ProviderTestStatus
    message?: string
    latencyMs: number
    modelsByProtocol: Record<string, ProviderTestModel[]>
}

const builtInAuthHeaders = (
    entry: BuiltInProviderEntry,
    apiKey: string
): Record<string, string> => {
    if (entry.modelsListAuth === 'anthropic') {
        return {
            authorization: `Bearer ${apiKey}`,
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        }
    }
    return { authorization: `Bearer ${apiKey}` }
}

const builtInModelsUrl = (
    entry: BuiltInProviderEntry,
    apiKey: string
): string => {
    if (entry.modelsListAuth === 'google_query') {
        const sep = entry.modelsListUrl.includes('?') ? '&' : '?'
        return `${entry.modelsListUrl}${sep}key=${encodeURIComponent(apiKey)}`
    }
    return entry.modelsListUrl
}

interface ParsedModelsResponse {
    data?: Array<{ id?: unknown; owned_by?: unknown }>
    models?: Array<{
        name?: unknown
        model_name?: unknown
        model_type?: unknown
        model_exhibition_config?: {
            model_owner?: unknown
            anthropic?: unknown
            api_style?: unknown
        }
    }>
}

const netmindMatchesProtocol = (
    cfg: Record<string, unknown> | null,
    protocol: InferenceProtocol,
    modelName: string,
    modelType: string | null
): boolean => {
    if (!cfg) return false
    if (protocol === 'anthropic_messages') return cfg.anthropic === true
    if (
        protocol === 'openai_chat_completions' ||
        protocol === 'openai_responses'
    )
        return cfg.api_style === 'openai'
    // NetMind marks Gemini chat models api_style=openai (no gemini flag), so
    // detect them by owner + name; model_type guards out google image models.
    if (protocol === 'google_generate_content')
        return (
            modelType === 'Chat' &&
            cfg.model_owner === 'google' &&
            /gemini/i.test(modelName)
        )
    return false
}

const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, '')

const stripCompatSubpath = (base: string): string | null => {
    const trimmed = stripTrailingSlash(base)
    const m = trimmed.match(/^(.*)\/(anthropic|openai|gemini|google)$/i)
    return m ? m[1] : null
}

const versionedBase = /\/v\d+$/

const modelsPath = (base: string): string =>
    versionedBase.test(base) ? `${base}/models` : `${base}/v1/models`

type CandidateAuth = 'protocol_headers' | 'goog_header' | 'key_query'

const buildCandidateUrls = (
    protocol: InferenceProtocol,
    base: string,
    apiKey: string
): Array<{ url: string; auth: CandidateAuth }> => {
    const trimmed = stripTrailingSlash(base)
    const out: Array<{ url: string; auth: CandidateAuth }> = []
    if (protocol === 'google_generate_content') {
        // Header-authed native endpoint first: official Google and the managed gateway
        // both accept x-goog-api-key, while the managed gateway 400s any ?key= query
        // ("deprecated") — so the query variant can never be the only
        // candidate that reaches a gateway. Header must be x-goog-api-key
        // ONLY: official Google 401s when Authorization carries an API key.
        out.push({ url: `${trimmed}/v1beta/models`, auth: 'goog_header' })
        out.push({
            url: `${trimmed}/v1beta/models?key=${encodeURIComponent(apiKey)}`,
            auth: 'key_query'
        })
        const stripped = stripCompatSubpath(trimmed)
        if (stripped) {
            out.push({
                url: `${stripped}/v1beta/models`,
                auth: 'goog_header'
            })
            out.push({
                url: `${stripped}/v1beta/models?key=${encodeURIComponent(apiKey)}`,
                auth: 'key_query'
            })
        }
        // OpenAI-compatible fallback for proxies that gate or omit the native
        // Google endpoint (NetMind 503s /v1beta/models but serves the same
        // catalog on Bearer-authed /v1/models).
        out.push({ url: modelsPath(trimmed), auth: 'protocol_headers' })
        if (stripped)
            out.push({ url: modelsPath(stripped), auth: 'protocol_headers' })
        return out
    }
    out.push({ url: modelsPath(trimmed), auth: 'protocol_headers' })
    const stripped = stripCompatSubpath(trimmed)
    if (stripped)
        out.push({ url: modelsPath(stripped), auth: 'protocol_headers' })
    return out
}

const authHeaders = (
    protocol: InferenceProtocol,
    apiKey: string
): Record<string, string> => {
    if (protocol === 'anthropic_messages') {
        return {
            authorization: `Bearer ${apiKey}`,
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        }
    }
    return { authorization: `Bearer ${apiKey}` }
}

const candidateHeaders = (
    auth: CandidateAuth,
    protocol: InferenceProtocol,
    apiKey: string
): Record<string, string> => {
    if (auth === 'goog_header') return { 'x-goog-api-key': apiKey }
    if (auth === 'key_query') return {}
    return authHeaders(protocol, apiKey)
}

const parseModels = (
    body: unknown,
    protocol: InferenceProtocol,
    modelFamily?: ModelFamily | null
): ProviderTestModel[] => {
    const parsed = body as ParsedModelsResponse | null
    if (!parsed || typeof parsed !== 'object') return []
    const models: ProviderTestModel[] = []
    if (Array.isArray(parsed.data)) {
        for (const entry of parsed.data) {
            if (!entry || typeof entry !== 'object') continue
            const id = (entry as { id?: unknown }).id
            if (typeof id !== 'string' || id.length === 0) continue
            // OpenAI-shape fallbacks can serve one mixed catalog for every
            // protocol (the managed antigravity gateway lists Claude + Gemini);
            // keep only gemini-family ids for the gemini protocol.
            if (protocol === 'google_generate_content' && !/gemini/i.test(id))
                continue
            const ownedBy = (entry as { owned_by?: unknown }).owned_by
            models.push({
                id,
                ownedBy: typeof ownedBy === 'string' ? ownedBy : null
            })
        }
        // A mixed catalog narrowed only when the caller named the family it
        // owns. NOT inferred from the protocol the way the gemini filter above
        // is: for anthropic the OpenAI-shape `data[]` is the canonical listing
        // (official /v1/models answers in it), so a protocol-wide rule would
        // reach every anthropic provider — including a user's own gateway
        // serving claude alongside GLM or Kimi ids, whose next test would write
        // the narrowed list straight back into lastTestModels.
        if (models.length > 0)
            return modelFamily === 'claude'
                ? models.filter((m) => /claude/i.test(m.id))
                : models
    }
    if (Array.isArray(parsed.models)) {
        for (const entry of parsed.models) {
            if (!entry || typeof entry !== 'object') continue
            const e = entry as Record<string, unknown>
            const googleName = typeof e.name === 'string' ? e.name : null
            if (googleName && googleName.length > 0) {
                const id = googleName.startsWith('models/')
                    ? googleName.slice('models/'.length)
                    : googleName
                models.push({ id, ownedBy: 'google' })
                continue
            }
            const netmindName =
                typeof e.model_name === 'string' ? e.model_name : null
            if (netmindName && netmindName.length > 0) {
                const cfg =
                    e.model_exhibition_config &&
                    typeof e.model_exhibition_config === 'object'
                        ? (e.model_exhibition_config as Record<string, unknown>)
                        : null
                const modelType =
                    typeof e.model_type === 'string' ? e.model_type : null
                if (
                    !netmindMatchesProtocol(
                        cfg,
                        protocol,
                        netmindName,
                        modelType
                    )
                )
                    continue
                const ownedBy =
                    cfg && typeof cfg.model_owner === 'string'
                        ? (cfg.model_owner as string)
                        : null
                models.push({ id: netmindName, ownedBy })
            }
        }
    }
    return models
}

@Injectable()
export class ProviderTestService {
    private readonly log = new Logger(ProviderTestService.name)

    async runBuiltInTest(
        input: RunBuiltInTestInput
    ): Promise<BuiltInTestResult> {
        const started = Date.now()
        const apiKey = input.apiKey.trim()
        const url = builtInModelsUrl(input.entry, apiKey)
        const headers =
            input.entry.modelsListAuth === 'google_query'
                ? { accept: 'application/json' }
                : {
                      ...builtInAuthHeaders(input.entry, apiKey),
                      accept: 'application/json'
                  }

        try {
            const res = await fetch(url, {
                method: 'GET',
                headers,
                signal: AbortSignal.timeout(TIMEOUT_MS)
            })
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    return {
                        ok: false,
                        status: 'error',
                        message: 'Invalid API key',
                        latencyMs: Date.now() - started,
                        modelsByProtocol: {}
                    }
                }
                return {
                    ok: false,
                    status: 'error',
                    message: `Provider returned ${res.status} ${res.statusText}`.trim(),
                    latencyMs: Date.now() - started,
                    modelsByProtocol: {}
                }
            }
            let parsed: unknown
            try {
                parsed = await res.json()
            } catch {
                return {
                    ok: false,
                    status: 'error',
                    message: 'Could not parse model list',
                    latencyMs: Date.now() - started,
                    modelsByProtocol: {}
                }
            }
            const modelsByProtocol: Record<string, ProviderTestModel[]> = {}
            let totalCount = 0
            for (const { protocol } of input.entry.protocols) {
                const list = parseModels(parsed, protocol)
                modelsByProtocol[protocol] = list
                totalCount += list.length
            }
            if (totalCount === 0) {
                return {
                    ok: false,
                    status: 'error',
                    message: 'Could not parse model list',
                    latencyMs: Date.now() - started,
                    modelsByProtocol
                }
            }
            return {
                ok: true,
                status: 'ok',
                latencyMs: Date.now() - started,
                modelsByProtocol
            }
        } catch (err) {
            const name = (err as Error)?.name
            if (name === 'TimeoutError' || name === 'AbortError') {
                return {
                    ok: false,
                    status: 'error',
                    message: 'Provider timed out',
                    latencyMs: Date.now() - started,
                    modelsByProtocol: {}
                }
            }
            this.log.warn(
                `built-in provider-test fetch error url=${redactSensitiveUrlQuery(url)} err=${(err as Error).message}`
            )
            return {
                ok: false,
                status: 'error',
                message: 'Network error reaching provider',
                latencyMs: Date.now() - started,
                modelsByProtocol: {}
            }
        }
    }

    async runTest(input: RunTestInput): Promise<ProviderTestResult> {
        const started = Date.now()
        const apiKey = input.apiKey.trim()
        const overrideRaw = (input.modelsListUrl ?? '').trim()
        const baseRaw = (input.baseUrl ?? '').trim()
        if (overrideRaw.length === 0 && baseRaw.length === 0)
            throw new BadRequestException(
                'baseUrl is required when modelsListUrl is not provided'
            )

        const candidates: Array<{ url: string; auth: CandidateAuth }> =
            overrideRaw.length > 0
                ? [{ url: overrideRaw, auth: 'protocol_headers' }]
                : buildCandidateUrls(input.inferenceProtocol, baseRaw, apiKey)

        let lastStatus: number | null = null
        let lastStatusText: string | null = null
        let authStatus: number | null = null
        let timedOut = false
        let networkError = false

        for (const candidate of candidates) {
            try {
                const res = await fetch(candidate.url, {
                    method: 'GET',
                    headers: {
                        ...candidateHeaders(
                            candidate.auth,
                            input.inferenceProtocol,
                            apiKey
                        ),
                        accept: 'application/json'
                    },
                    signal: AbortSignal.timeout(TIMEOUT_MS)
                })
                if (!res.ok) {
                    lastStatus = res.status
                    lastStatusText = res.statusText
                    if (
                        res.status === 400 ||
                        res.status === 401 ||
                        res.status === 403
                    )
                        authStatus = authStatus ?? res.status
                    // Auth-ish failures on the gemini-specific candidates are
                    // not conclusive (the managed gateway 400s ?key= as "deprecated" while
                    // accepting the header; other gateways may only take
                    // Bearer) — keep trying the remaining auth styles.
                    if (candidate.auth !== 'protocol_headers') continue
                    if (res.status === 401 || res.status === 403) {
                        return {
                            ok: false,
                            status: 'error',
                            message: 'Invalid API key',
                            latencyMs: Date.now() - started,
                            models: []
                        }
                    }
                    if (
                        res.status === 404 ||
                        res.status === 405 ||
                        res.status >= 500
                    )
                        continue
                    return {
                        ok: false,
                        status: 'error',
                        message:
                            `Provider returned ${res.status} ${res.statusText}`.trim(),
                        latencyMs: Date.now() - started,
                        models: []
                    }
                }
                let parsed: unknown
                try {
                    parsed = await res.json()
                } catch {
                    return {
                        ok: false,
                        status: 'error',
                        message: 'Could not parse model list',
                        latencyMs: Date.now() - started,
                        models: []
                    }
                }
                const models = parseModels(
                    parsed,
                    input.inferenceProtocol,
                    input.modelFamily
                )
                if (models.length === 0) {
                    return {
                        ok: false,
                        status: 'error',
                        message: 'Could not parse model list',
                        latencyMs: Date.now() - started,
                        models: []
                    }
                }
                return {
                    ok: true,
                    status: 'ok',
                    latencyMs: Date.now() - started,
                    models
                }
            } catch (err) {
                const name = (err as Error)?.name
                if (name === 'TimeoutError' || name === 'AbortError') {
                    timedOut = true
                    continue
                }
                networkError = true
                this.log.warn(
                    `provider-test fetch error url=${redactSensitiveUrlQuery(candidate.url)} err=${(err as Error).message}`
                )
                continue
            }
        }

        if (timedOut) {
            return {
                ok: false,
                status: 'error',
                message: 'Provider timed out',
                latencyMs: Date.now() - started,
                models: []
            }
        }
        if (authStatus === 401 || authStatus === 403) {
            return {
                ok: false,
                status: 'error',
                message: 'Invalid API key',
                latencyMs: Date.now() - started,
                models: []
            }
        }
        if (authStatus === 400) {
            return {
                ok: false,
                status: 'error',
                message: 'Provider returned 400 for the model list request',
                latencyMs: Date.now() - started,
                models: []
            }
        }
        if (lastStatus === 404 || lastStatus === 405) {
            return {
                ok: false,
                status: 'error',
                message: 'Provider does not expose /v1/models at this base URL',
                latencyMs: Date.now() - started,
                models: []
            }
        }
        if (networkError) {
            return {
                ok: false,
                status: 'error',
                message: 'Network error reaching provider',
                latencyMs: Date.now() - started,
                models: []
            }
        }
        return {
            ok: false,
            status: 'error',
            message: lastStatusText
                ? `Provider returned ${lastStatus ?? '?'} ${lastStatusText}`
                : 'Provider returned no successful response',
            latencyMs: Date.now() - started,
            models: []
        }
    }
}
