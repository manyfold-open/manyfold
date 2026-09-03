import type { AgentFramework, AgentRuntime } from './constants'
import type { SpriteStatus } from './dtos'
import {
    isConfigurableFramework,
    type ConfigurableFramework
} from './framework-catalog'
import {
    parseRuntimeLocalCredentialFacts,
    type RuntimeLocalCredentialFacts,
    type RuntimeLocalCredentialReason,
    type RuntimeLocalCredentialStatus
} from './runtime-local-credentials'

// The runtime-account probe extends the credential facts with who is signed
// in on the runtime and what that account has used. Like the facts, a probe
// never carries secret values: the host calls the vendor usage endpoint with
// its own token and ships back only the response, so the API can judge and
// map without ever seeing a credential. Hosts do no vendor-schema mapping —
// the sandbox probe is an emitted script that cannot import this module, so
// keeping the mapping here (and only here) is what stops the two host paths
// drifting apart.

// Where the host found a usable OAuth token. 'keychain-unread' is macOS: the
// CLI keeps the token in the Keychain, which a launchd daemon must not prompt
// for, so the sign-in is known from the login record but usage cannot be read.
export type RuntimeAccountTokenSource = 'file' | 'none' | 'keychain-unread'

export interface RuntimeAccountIdentity {
    email: string | null
    name: string | null
    organization: string | null
    plan: string | null
    accountId: string | null
}

export type RuntimeAccountVendor = 'anthropic' | 'openai' | 'google'

export type RuntimeAccountFetchErrorKind = 'stale-token' | 'network' | 'timeout'

// The raw outcome of the host's usage call. `status` 0 means the request never
// completed (or was skipped); `body` is the parsed 2xx JSON, capped by the host.
export interface RuntimeAccountUsageFetch {
    vendor: RuntimeAccountVendor
    status: number
    body: unknown
    retryAfterSeconds: number | null
    error: { kind: RuntimeAccountFetchErrorKind; message: string | null } | null
    fetchedAt: string
}

// Daemon `account.inspect` ack payload / the sandbox account script's line.
export interface RuntimeAccountProbe {
    framework: ConfigurableFramework
    checkedAt: string
    credentialFacts: RuntimeLocalCredentialFacts | null
    tokenSource: RuntimeAccountTokenSource
    identity: RuntimeAccountIdentity | null
    usage: RuntimeAccountUsageFetch | null
}

export interface RuntimeAccountUsageWindow {
    key: string
    usedPercent: number
    resetsAt: string | null
    windowSeconds: number | null
}

export type RuntimeAccountUsageErrorKind =
    | 'unauthorized'
    | 'rate-limited'
    | 'stale-token'
    | 'network'
    | 'unexpected'

export interface RuntimeAccountUsage {
    windows: RuntimeAccountUsageWindow[]
    plan: string | null
    fetchedAt: string
    error: {
        kind: RuntimeAccountUsageErrorKind
        retryAfterSeconds: number | null
        message: string | null
    } | null
}

export type RuntimeAccountViewStatus =
    | 'ok'
    | 'probe-failed'
    | 'sandbox-asleep'
    | 'daemon-offline'
    | 'daemon-upgrade-required'
    | 'unsupported'

export interface RuntimeAccountView {
    runtimeId: string
    framework: AgentFramework
    kind: AgentRuntime
    status: RuntimeAccountViewStatus
    checkedAt: string | null
    credentialStatus: RuntimeLocalCredentialStatus
    credentialReason: RuntimeLocalCredentialReason
    tokenSource: RuntimeAccountTokenSource | null
    identity: RuntimeAccountIdentity | null
    usage: RuntimeAccountUsage | null
    host: { spriteStatus: SpriteStatus | null; terminalEnabled: boolean } | null
    error: string | null
}

export type RuntimeAccountSupport = 'ok' | 'framework' | 'runtime-kind'

// Only the coding CLIs hold a vendor sign-in of their own, and only a daemon
// machine or a sandbox exposes a host we can probe without an agent.
export const runtimeAccountSupport = (
    framework: string,
    kind: AgentRuntime
): RuntimeAccountSupport => {
    if (!isConfigurableFramework(framework)) return 'framework'
    if (kind !== 'daemon' && kind !== 'sprites') return 'runtime-kind'
    return 'ok'
}

const MAX_IDENTITY_CHARS = 200
const MAX_BODY_DEPTH = 6
const MAX_BODY_ENTRIES = 200

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const optionalString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed ? trimmed.slice(0, MAX_IDENTITY_CHARS) : null
}

const optionalNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

const isoOrNull = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

// Host payloads arrive as untyped JSON over the daemon RPC or a sandbox exec,
// so nothing is cast: unknown keys are dropped and the vendor body is
// re-walked with a depth and entry budget, since it is echoed from a network
// response the host did not validate.
const sanitizeBody = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_BODY_DEPTH) return null
    if (value === null) return null
    if (typeof value === 'string') return value.slice(0, MAX_IDENTITY_CHARS)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (Array.isArray(value))
        return value
            .slice(0, MAX_BODY_ENTRIES)
            .map((item) => sanitizeBody(item, depth + 1))
    if (isRecord(value)) {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value).slice(
            0,
            MAX_BODY_ENTRIES
        ))
            out[key] = sanitizeBody(item, depth + 1)
        return out
    }
    return null
}

const parseIdentity = (value: unknown): RuntimeAccountIdentity | null => {
    if (!isRecord(value)) return null
    const identity = {
        email: optionalString(value.email),
        name: optionalString(value.name),
        organization: optionalString(value.organization),
        plan: optionalString(value.plan),
        accountId: optionalString(value.accountId)
    }
    return Object.values(identity).some((field) => field !== null)
        ? identity
        : null
}

const FETCH_ERROR_KINDS: RuntimeAccountFetchErrorKind[] = [
    'stale-token',
    'network',
    'timeout'
]

const parseFetch = (value: unknown): RuntimeAccountUsageFetch | null => {
    if (!isRecord(value)) return null
    const vendor = value.vendor
    if (vendor !== 'anthropic' && vendor !== 'openai' && vendor !== 'google')
        return null
    const rawError = isRecord(value.error) ? value.error : null
    const errorKind = FETCH_ERROR_KINDS.find((kind) => kind === rawError?.kind)
    const error = errorKind
        ? { kind: errorKind, message: optionalString(rawError?.message) }
        : null
    return {
        vendor,
        status: optionalNumber(value.status) ?? 0,
        body: sanitizeBody(value.body),
        retryAfterSeconds: optionalNumber(value.retryAfterSeconds),
        error,
        fetchedAt: isoOrNull(value.fetchedAt) ?? new Date(0).toISOString()
    }
}

export const parseRuntimeAccountProbe = (
    value: unknown
): RuntimeAccountProbe | null => {
    if (!isRecord(value)) return null
    if (!isConfigurableFramework(value.framework)) return null
    const tokenSource = value.tokenSource
    return {
        framework: value.framework,
        checkedAt: isoOrNull(value.checkedAt) ?? new Date().toISOString(),
        credentialFacts: parseRuntimeLocalCredentialFacts(value.credentialFacts),
        tokenSource:
            tokenSource === 'file' || tokenSource === 'keychain-unread'
                ? tokenSource
                : 'none',
        identity: parseIdentity(value.identity),
        usage: parseFetch(value.usage)
    }
}

const clampPercent = (value: number): number =>
    Math.min(100, Math.max(0, Math.round(value)))

const FIVE_HOURS = 5 * 3600
const SEVEN_DAYS = 7 * 24 * 3600

const windowSecondsForKey = (key: string): number | null => {
    if (key === 'five_hour') return FIVE_HOURS
    if (key.startsWith('seven_day')) return SEVEN_DAYS
    return null
}

const ANTHROPIC_KNOWN_WINDOWS = [
    'five_hour',
    'seven_day',
    'seven_day_opus',
    'seven_day_sonnet'
]
// Not rate-limit windows, even though extra_usage also carries `utilization`.
const ANTHROPIC_SKIPPED_KEYS = new Set(['extra_usage', 'limits'])

const anthropicWindows = (
    body: Record<string, unknown>
): RuntimeAccountUsageWindow[] => {
    const windows: RuntimeAccountUsageWindow[] = []
    const ordered = [
        ...ANTHROPIC_KNOWN_WINDOWS,
        ...Object.keys(body).filter(
            (key) => !ANTHROPIC_KNOWN_WINDOWS.includes(key)
        )
    ]
    for (const key of ordered) {
        if (ANTHROPIC_SKIPPED_KEYS.has(key)) continue
        const raw = body[key]
        if (!isRecord(raw)) continue
        const utilization = optionalNumber(raw.utilization)
        if (utilization === null) continue
        windows.push({
            key,
            usedPercent: clampPercent(utilization),
            resetsAt: isoOrNull(raw.resets_at),
            windowSeconds: windowSecondsForKey(key)
        })
    }
    return windows
}

// Codex reports epoch seconds; a value already in milliseconds is tolerated
// so a vendor change cannot render every reset as the year 57000.
const epochToIso = (value: unknown): string | null => {
    const raw = optionalNumber(value)
    if (raw === null || raw <= 0) return null
    const ms = raw > 10_000_000_000 ? raw : raw * 1000
    return new Date(ms).toISOString()
}

const codexWindowKey = (seconds: number | null): string => {
    if (seconds === FIVE_HOURS) return 'five_hour'
    if (seconds === SEVEN_DAYS) return 'seven_day'
    return seconds === null ? 'window' : `window_${seconds}s`
}

const codexWindows = (
    body: Record<string, unknown>
): RuntimeAccountUsageWindow[] => {
    const rateLimit = isRecord(body.rate_limit) ? body.rate_limit : null
    if (!rateLimit) return []
    const windows: RuntimeAccountUsageWindow[] = []
    for (const slot of ['primary_window', 'secondary_window']) {
        const raw = rateLimit[slot]
        if (!isRecord(raw)) continue
        const used = optionalNumber(raw.used_percent)
        if (used === null) continue
        const seconds = optionalNumber(raw.limit_window_seconds)
        windows.push({
            key: codexWindowKey(seconds),
            usedPercent: clampPercent(used),
            resetsAt: epochToIso(raw.reset_at),
            windowSeconds: seconds
        })
    }
    return windows
}

const GEMINI_FAMILY_ORDER = ['gemini_pro', 'gemini_flash', 'gemini_flash_lite']

const geminiFamily = (modelId: string): string => {
    const lower = modelId.toLowerCase()
    if (lower.includes('flash-lite')) return 'gemini_flash_lite'
    if (lower.includes('flash')) return 'gemini_flash'
    if (lower.includes('pro')) return 'gemini_pro'
    return modelId
}

// One bar per model family, pinned to the bucket with the least headroom:
// the tightest bucket is the one that will refuse the next request.
const geminiWindows = (
    body: Record<string, unknown>
): RuntimeAccountUsageWindow[] => {
    if (!Array.isArray(body.buckets)) return []
    const tightest = new Map<
        string,
        { remaining: number; resetsAt: string | null }
    >()
    for (const bucket of body.buckets) {
        if (!isRecord(bucket)) continue
        const remaining = optionalNumber(bucket.remainingFraction)
        const modelId = optionalString(bucket.modelId)
        if (remaining === null || !modelId) continue
        const family = geminiFamily(modelId)
        const current = tightest.get(family)
        if (!current || remaining < current.remaining)
            tightest.set(family, {
                remaining,
                resetsAt: isoOrNull(bucket.resetTime)
            })
    }
    const keys = [
        ...GEMINI_FAMILY_ORDER.filter((key) => tightest.has(key)),
        ...[...tightest.keys()].filter(
            (key) => !GEMINI_FAMILY_ORDER.includes(key)
        )
    ]
    return keys.map((key) => {
        const entry = tightest.get(key)!
        return {
            key,
            usedPercent: clampPercent((1 - entry.remaining) * 100),
            resetsAt: entry.resetsAt,
            windowSeconds: null
        }
    })
}

const usageError = (
    kind: RuntimeAccountUsageErrorKind,
    message: string | null,
    retryAfterSeconds: number | null = null
): RuntimeAccountUsage['error'] => ({ kind, retryAfterSeconds, message })

export const runtimeAccountUsage = (
    probe: RuntimeAccountProbe
): RuntimeAccountUsage | null => {
    const fetch = probe.usage
    if (!fetch) return null
    const base = { windows: [], plan: null, fetchedAt: fetch.fetchedAt }
    if (fetch.error)
        return {
            ...base,
            error: usageError(
                fetch.error.kind === 'stale-token' ? 'stale-token' : 'network',
                fetch.error.message
            )
        }
    if (fetch.status === 401 || fetch.status === 403)
        return { ...base, error: usageError('unauthorized', null) }
    if (fetch.status === 429)
        return {
            ...base,
            error: usageError('rate-limited', null, fetch.retryAfterSeconds)
        }
    if (fetch.status < 200 || fetch.status >= 300 || !isRecord(fetch.body))
        return {
            ...base,
            error: usageError(
                'unexpected',
                fetch.status ? `HTTP ${fetch.status}` : 'no usable response'
            )
        }
    const body = fetch.body
    if (fetch.vendor === 'anthropic')
        return { ...base, windows: anthropicWindows(body), error: null }
    if (fetch.vendor === 'openai')
        return {
            ...base,
            windows: codexWindows(body),
            plan: optionalString(body.plan_type),
            error: null
        }
    return { ...base, windows: geminiWindows(body), error: null }
}
