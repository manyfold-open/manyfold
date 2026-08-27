// Credential facts are collected by the two runtime-local inspect paths (the
// CLI daemon's model.inspect handler and the API's sandbox inspect script) and
// evaluated here. Splitting collection from judgement keeps a single source of
// truth for validity across those two hand-mirrored copies, and lets the API
// re-evaluate expiry against the current clock without re-inspecting: the facts
// carry timestamps, not verdicts.
//
// Facts never carry secret values — only presence flags, expiry timestamps and
// non-secret identifiers such as a provider's env var name.

export const runtimeLocalCredentialStatuses = [
    'valid',
    'expired',
    'missing',
    'unknown'
] as const
export type RuntimeLocalCredentialStatus =
    (typeof runtimeLocalCredentialStatuses)[number]

// Stable machine-readable evidence code; the UI maps it to a localized string.
export type RuntimeLocalCredentialReason =
    | 'env-token'
    | 'api-key'
    | 'oauth-live'
    | 'oauth-refreshable'
    | 'login-record'
    | 'custom-provider'
    | 'oauth-expired'
    | 'no-credentials'
    | 'unreadable'
    | 'not-reported'

export interface ClaudeCredentialFacts {
    framework: 'claude-code'
    envToken: boolean
    credentialsFileParsed: boolean
    oauthExpiresAt: number | null
    hasRefreshToken: boolean
    oauthAccount: boolean
    configPresent: boolean
}

export interface CodexCustomProviderFact {
    id: string
    hasBaseUrl: boolean
    envKey: string | null
    envKeyPresent: boolean
    requiresOpenaiAuth: boolean
}

export interface CodexCredentialFacts {
    framework: 'codex'
    authFilePresent: boolean
    authFileParsed: boolean
    apiKeyPresent: boolean
    envApiKey: boolean
    hasAccessToken: boolean
    hasRefreshToken: boolean
    accessTokenExp: number | null
    lastRefresh: string | null
    customProviders: CodexCustomProviderFact[]
    activeProvider: string | null
}

export interface GeminiCredentialFacts {
    framework: 'gemini-cli'
    envApiKey: boolean
    settingsApiKey: boolean
    oauthFilePresent: boolean
    oauthFileParsed: boolean
    oauthExpiryDate: number | null
    hasRefreshToken: boolean
}

export type RuntimeLocalCredentialFacts =
    | ClaudeCredentialFacts
    | CodexCredentialFacts
    | GeminiCredentialFacts

export interface RuntimeLocalCredentialEvaluation {
    status: RuntimeLocalCredentialStatus
    reason: RuntimeLocalCredentialReason
}

const evaluation = (
    status: RuntimeLocalCredentialStatus,
    reason: RuntimeLocalCredentialReason
): RuntimeLocalCredentialEvaluation => ({ status, reason })

// A live expiry is the only thing that lets us call a token expired. Anything
// refreshable stays valid: all three CLIs renew silently before a turn. A
// missing timestamp must fall through rather than compare as expired — raw
// daemon JSON reports absent fields as undefined, not null.
const oauthEvaluation = (
    expiresAt: number | null | undefined,
    hasRefreshToken: boolean,
    now: number
): RuntimeLocalCredentialEvaluation | null => {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))
        return null
    if (expiresAt > now) return evaluation('valid', 'oauth-live')
    if (hasRefreshToken) return evaluation('valid', 'oauth-refreshable')
    return evaluation('expired', 'oauth-expired')
}

const evaluateClaude = (
    facts: ClaudeCredentialFacts,
    now: number
): RuntimeLocalCredentialEvaluation => {
    if (facts.envToken) return evaluation('valid', 'env-token')
    const oauth = oauthEvaluation(
        facts.oauthExpiresAt,
        facts.hasRefreshToken,
        now
    )
    if (oauth) return oauth
    // macOS keeps the token in the Keychain, which a launchd daemon must not
    // prompt for, so the login record in ~/.claude.json is the strongest
    // signal available there.
    if (facts.oauthAccount) return evaluation('valid', 'login-record')
    if (facts.credentialsFileParsed || facts.configPresent)
        return evaluation('unknown', 'unreadable')
    return evaluation('missing', 'no-credentials')
}

const codexCustomProviders = (
    facts: CodexCredentialFacts
): CodexCustomProviderFact[] =>
    Array.isArray(facts.customProviders) ? facts.customProviders : []

const codexCustomProviderReady = (facts: CodexCredentialFacts): boolean => {
    const providers = codexCustomProviders(facts)
    const active = facts.activeProvider
    const candidates = active
        ? providers.filter((provider) => provider?.id === active)
        : providers
    return candidates.some(
        (provider) => provider?.hasBaseUrl && provider?.envKeyPresent
    )
}

const evaluateCodex = (
    facts: CodexCredentialFacts,
    now: number
): RuntimeLocalCredentialEvaluation => {
    if (facts.apiKeyPresent) return evaluation('valid', 'api-key')
    if (facts.envApiKey) return evaluation('valid', 'env-token')
    // A third-party gateway configured in config.toml authenticates through its
    // own env var, so OpenAI credentials being absent says nothing about it.
    if (codexCustomProviderReady(facts))
        return evaluation('valid', 'custom-provider')
    if (facts.hasRefreshToken) return evaluation('valid', 'oauth-refreshable')
    const oauth = oauthEvaluation(facts.accessTokenExp, false, now)
    if (oauth) return oauth
    if (facts.hasAccessToken) return evaluation('unknown', 'unreadable')
    // config.toml is parsed by regex, so a gateway we failed to match is more
    // likely than a user who configured one they cannot authenticate against.
    if (codexCustomProviders(facts).length > 0)
        return evaluation('unknown', 'unreadable')
    if (facts.authFilePresent)
        return facts.authFileParsed
            ? evaluation('missing', 'no-credentials')
            : evaluation('unknown', 'unreadable')
    return evaluation('missing', 'no-credentials')
}

const evaluateGemini = (
    facts: GeminiCredentialFacts,
    now: number
): RuntimeLocalCredentialEvaluation => {
    if (facts.envApiKey) return evaluation('valid', 'env-token')
    if (facts.settingsApiKey) return evaluation('valid', 'api-key')
    const oauth = oauthEvaluation(
        facts.oauthExpiryDate,
        facts.hasRefreshToken,
        now
    )
    if (oauth) return oauth
    if (facts.oauthFilePresent) return evaluation('unknown', 'unreadable')
    return evaluation('missing', 'no-credentials')
}

// Facts absent means an older daemon that predates this contract: fail open so
// a rolling CLI fleet never loses access to a runtime it can actually use.
// Callers may pass a raw wire payload, so every branch tolerates missing keys.
export const runtimeLocalCredentialStatus = (
    facts: RuntimeLocalCredentialFacts | null | undefined,
    now: number
): RuntimeLocalCredentialEvaluation => {
    if (!facts) return evaluation('unknown', 'not-reported')
    if (facts.framework === 'claude-code') return evaluateClaude(facts, now)
    if (facts.framework === 'codex') return evaluateCodex(facts, now)
    if (facts.framework === 'gemini-cli') return evaluateGemini(facts, now)
    return evaluation('unknown', 'not-reported')
}

export const isRuntimeLocalCredentialUsable = (
    status: RuntimeLocalCredentialStatus
): boolean => status === 'valid' || status === 'unknown'

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const optionalBoolean = (value: unknown): boolean => value === true

const optionalNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

const optionalString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const parseCustomProviders = (value: unknown): CodexCustomProviderFact[] => {
    if (!Array.isArray(value)) return []
    const parsed: CodexCustomProviderFact[] = []
    for (const entry of value) {
        if (!isRecord(entry)) continue
        const id = optionalString(entry.id)
        if (!id) continue
        parsed.push({
            id,
            hasBaseUrl: optionalBoolean(entry.hasBaseUrl),
            envKey: optionalString(entry.envKey),
            envKeyPresent: optionalBoolean(entry.envKeyPresent),
            requiresOpenaiAuth: optionalBoolean(entry.requiresOpenaiAuth)
        })
    }
    return parsed
}

// Facts arrive as untyped JSON over the daemon RPC and out of the agent extras
// jsonb column, so every field is re-validated rather than cast.
export const parseRuntimeLocalCredentialFacts = (
    value: unknown
): RuntimeLocalCredentialFacts | null => {
    if (!isRecord(value)) return null
    if (value.framework === 'claude-code')
        return {
            framework: 'claude-code',
            envToken: optionalBoolean(value.envToken),
            credentialsFileParsed: optionalBoolean(value.credentialsFileParsed),
            oauthExpiresAt: optionalNumber(value.oauthExpiresAt),
            hasRefreshToken: optionalBoolean(value.hasRefreshToken),
            oauthAccount: optionalBoolean(value.oauthAccount),
            configPresent: optionalBoolean(value.configPresent)
        }
    if (value.framework === 'codex')
        return {
            framework: 'codex',
            authFilePresent: optionalBoolean(value.authFilePresent),
            authFileParsed: optionalBoolean(value.authFileParsed),
            apiKeyPresent: optionalBoolean(value.apiKeyPresent),
            envApiKey: optionalBoolean(value.envApiKey),
            hasAccessToken: optionalBoolean(value.hasAccessToken),
            hasRefreshToken: optionalBoolean(value.hasRefreshToken),
            accessTokenExp: optionalNumber(value.accessTokenExp),
            lastRefresh: optionalString(value.lastRefresh),
            customProviders: parseCustomProviders(value.customProviders),
            activeProvider: optionalString(value.activeProvider)
        }
    if (value.framework === 'gemini-cli')
        return {
            framework: 'gemini-cli',
            envApiKey: optionalBoolean(value.envApiKey),
            settingsApiKey: optionalBoolean(value.settingsApiKey),
            oauthFilePresent: optionalBoolean(value.oauthFilePresent),
            oauthFileParsed: optionalBoolean(value.oauthFileParsed),
            oauthExpiryDate: optionalNumber(value.oauthExpiryDate),
            hasRefreshToken: optionalBoolean(value.hasRefreshToken)
        }
    return null
}
