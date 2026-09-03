import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
    ConfigurableFramework,
    RuntimeAccountIdentity,
    RuntimeAccountProbe,
    RuntimeAccountTokenSource,
    RuntimeAccountUsageFetch,
    RuntimeAccountVendor
} from '@manyfold/shared'
import {
    codexHomeDir,
    jwtClaims,
    jwtExpiryMs,
    nestedRecord,
    parseJsonRecord,
    readTextIfPresent
} from './inspect-fs'

// account.inspect: who is signed in to a coding CLI on this machine, and what
// that account has used. The vendor usage call runs HERE, with the token the
// CLI left on disk, and only the response travels to the API — the token
// never does. Nothing in this file interprets the vendor's schema; the API
// maps it (packages/shared/src/runtime-account.ts) so this daemon and the
// sandbox inspect script cannot drift apart.
//
// macOS is read as "signed in, usage unreadable": the CLIs keep the token in
// the Keychain there, and a launchd daemon must never trigger the access
// prompt (the same rule the credential facts follow).

export interface AccountInspectDeps {
    fetch: typeof fetch
    now: () => number
    platform: NodeJS.Platform
    cliVersion: string | null
}

export type RuntimeAccountReport = Omit<RuntimeAccountProbe, 'credentialFacts'>

const VENDOR_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_RETRY_AFTER_SECONDS = 24 * 3600

export const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const GEMINI_LOAD_CODE_ASSIST_URL =
    'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
export const GEMINI_USER_QUOTA_URL =
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'

const defaultDeps = (): AccountInspectDeps => ({
    fetch: globalThis.fetch,
    now: Date.now,
    platform: process.platform,
    cliVersion: null
})

const trimmed = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null

const identityOrNull = (
    identity: RuntimeAccountIdentity
): RuntimeAccountIdentity | null =>
    Object.values(identity).some((field) => field !== null) ? identity : null

// Retry-After is either delta-seconds or an HTTP-date; both become seconds
// from now so the API can hold off exactly as long as the vendor asked.
const retryAfterSeconds = (
    header: string | null,
    nowMs: number
): number | null => {
    if (!header) return null
    const value = header.trim()
    if (/^\d+$/.test(value))
        return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS)
    const at = Date.parse(value)
    if (!Number.isFinite(at)) return null
    return Math.min(
        Math.max(0, Math.ceil((at - nowMs) / 1000)),
        MAX_RETRY_AFTER_SECONDS
    )
}

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text) as unknown
    } catch {
        return null
    }
}

const skippedFetch = (
    vendor: RuntimeAccountVendor,
    deps: AccountInspectDeps
): RuntimeAccountUsageFetch => ({
    vendor,
    status: 0,
    body: null,
    retryAfterSeconds: null,
    error: { kind: 'stale-token', message: null },
    fetchedAt: new Date(deps.now()).toISOString()
})

const vendorFetch = async (
    deps: AccountInspectDeps,
    vendor: RuntimeAccountVendor,
    url: string,
    init: { method?: string; headers: Record<string, string>; body?: string }
): Promise<RuntimeAccountUsageFetch> => {
    const fetchedAt = new Date(deps.now()).toISOString()
    try {
        const res = await deps.fetch(url, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS)
        })
        const text = await res.text()
        const body =
            res.ok && text.length <= MAX_BODY_BYTES ? parseJson(text) : null
        return {
            vendor,
            status: res.status,
            body,
            retryAfterSeconds: retryAfterSeconds(
                res.headers.get('retry-after'),
                deps.now()
            ),
            error: null,
            fetchedAt
        }
    } catch (err) {
        const name = (err as Error).name
        return {
            vendor,
            status: 0,
            body: null,
            retryAfterSeconds: null,
            error: {
                kind:
                    name === 'TimeoutError' || name === 'AbortError'
                        ? 'timeout'
                        : 'network',
                message: (err as Error).message || null
            },
            fetchedAt
        }
    }
}

const bearer = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
})

const inspectClaude = async (
    deps: AccountInspectDeps
): Promise<Omit<RuntimeAccountReport, 'framework' | 'checkedAt'>> => {
    const credentials = parseJsonRecord(
        (await readTextIfPresent(join(homedir(), '.claude', '.credentials.json')))
            .text
    )
    // Older installs wrote the oauth block under `oauthAccount`; the profile
    // record in ~/.claude.json reuses that name for something else.
    const oauth =
        nestedRecord(credentials, 'claudeAiOauth') ??
        nestedRecord(credentials, 'oauthAccount')
    const profile = nestedRecord(
        parseJsonRecord(
            (await readTextIfPresent(join(homedir(), '.claude.json'))).text
        ),
        'oauthAccount'
    )
    const identity = profile
        ? identityOrNull({
              email: trimmed(profile.emailAddress),
              name: trimmed(profile.displayName) ?? trimmed(profile.fullName),
              organization: trimmed(profile.organizationName),
              plan:
                  trimmed(oauth?.subscriptionType) ??
                  trimmed(profile.organizationType) ??
                  trimmed(profile.userRateLimitTier),
              accountId: trimmed(profile.accountUuid)
          })
        : null
    const accessToken = trimmed(oauth?.accessToken)
    if (!accessToken) {
        const tokenSource: RuntimeAccountTokenSource =
            deps.platform === 'darwin' && profile ? 'keychain-unread' : 'none'
        return { tokenSource, identity, usage: null }
    }
    const expiresAt = oauth?.expiresAt
    if (typeof expiresAt === 'number' && expiresAt <= deps.now())
        return { tokenSource: 'file', identity, usage: skippedFetch('anthropic', deps) }
    const usage = await vendorFetch(deps, 'anthropic', ANTHROPIC_USAGE_URL, {
        headers: {
            ...bearer(accessToken),
            'anthropic-beta': 'oauth-2025-04-20',
            // The endpoint serves the CLI; identify as it does.
            'User-Agent': `claude-code/${deps.cliVersion ?? '2.1.0'}`
        }
    })
    return { tokenSource: 'file', identity, usage }
}

const inspectCodex = async (
    deps: AccountInspectDeps
): Promise<Omit<RuntimeAccountReport, 'framework' | 'checkedAt'>> => {
    const auth = parseJsonRecord(
        (await readTextIfPresent(join(codexHomeDir(), 'auth.json'))).text
    )
    const tokens = nestedRecord(auth, 'tokens')
    const claims = jwtClaims(tokens?.id_token)
    const authClaims = nestedRecord(claims, 'https://api.openai.com/auth')
    const accountId =
        trimmed(tokens?.account_id) ?? trimmed(authClaims?.chatgpt_account_id)
    const identity = claims
        ? identityOrNull({
              email: trimmed(claims.email),
              name: trimmed(claims.name),
              organization: null,
              plan: trimmed(authClaims?.chatgpt_plan_type),
              accountId
          })
        : null
    const accessToken = trimmed(tokens?.access_token)
    // API-key mode has no ChatGPT account behind it, so there is no usage to
    // read even when stale tokens linger in the file.
    if (auth?.auth_mode === 'apikey' || !accessToken)
        return { tokenSource: 'none', identity, usage: null }
    const expiresAt = jwtExpiryMs(accessToken)
    if (expiresAt !== null && expiresAt <= deps.now())
        return { tokenSource: 'file', identity, usage: skippedFetch('openai', deps) }
    const usage = await vendorFetch(deps, 'openai', CODEX_USAGE_URL, {
        headers: {
            ...bearer(accessToken),
            'User-Agent': 'codex-cli',
            'OpenAI-Beta': 'codex-1',
            originator: 'Codex Desktop',
            ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {})
        }
    })
    return { tokenSource: 'file', identity, usage }
}

const geminiProjectId = (body: unknown): string | null => {
    const record =
        body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : null
    const project = record?.cloudaicompanionProject
    if (typeof project === 'string') return trimmed(project)
    const nested =
        project && typeof project === 'object'
            ? (project as Record<string, unknown>)
            : null
    return trimmed(nested?.id) ?? trimmed(nested?.projectId)
}

const inspectGemini = async (
    deps: AccountInspectDeps
): Promise<Omit<RuntimeAccountReport, 'framework' | 'checkedAt'>> => {
    const geminiHome = join(homedir(), '.gemini')
    const creds = parseJsonRecord(
        (await readTextIfPresent(join(geminiHome, 'oauth_creds.json'))).text
    )
    const accounts = parseJsonRecord(
        (await readTextIfPresent(join(geminiHome, 'google_accounts.json'))).text
    )
    const email = trimmed(accounts?.active)
    const identity = email
        ? { email, name: null, organization: null, plan: null, accountId: null }
        : null
    const accessToken = trimmed(creds?.access_token)
    if (!accessToken) {
        const tokenSource: RuntimeAccountTokenSource =
            deps.platform === 'darwin' && identity ? 'keychain-unread' : 'none'
        return { tokenSource, identity, usage: null }
    }
    const expiry = creds?.expiry_date
    if (typeof expiry === 'number' && expiry <= deps.now())
        return { tokenSource: 'file', identity, usage: skippedFetch('google', deps) }
    const headers = {
        ...bearer(accessToken),
        'Content-Type': 'application/json'
    }
    // Quota is per Code Assist project, which the same token resolves first.
    const load = await vendorFetch(deps, 'google', GEMINI_LOAD_CODE_ASSIST_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }
        })
    })
    if (load.error || load.status < 200 || load.status >= 300)
        return { tokenSource: 'file', identity, usage: load }
    const project =
        geminiProjectId(load.body) ?? trimmed(process.env.GOOGLE_CLOUD_PROJECT)
    const usage = await vendorFetch(deps, 'google', GEMINI_USER_QUOTA_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(project ? { project } : {})
    })
    return { tokenSource: 'file', identity, usage }
}

export const inspectRuntimeAccount = async (
    framework: ConfigurableFramework,
    overrides: Partial<AccountInspectDeps> = {}
): Promise<RuntimeAccountReport> => {
    const deps = { ...defaultDeps(), ...overrides }
    const report =
        framework === 'claude-code'
            ? await inspectClaude(deps)
            : framework === 'codex'
              ? await inspectCodex(deps)
              : await inspectGemini(deps)
    return {
        framework,
        checkedAt: new Date(deps.now()).toISOString(),
        ...report
    }
}
