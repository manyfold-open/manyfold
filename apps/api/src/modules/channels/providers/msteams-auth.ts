import { channelProviderJsonRequest } from './channel-http'

// Inbound and outbound auth for the Microsoft Teams channel. Kept out of the
// provider so the JWT work is unit-testable on its own and the provider file
// stays about Teams semantics.
//
// Manyfold talks to the Bot Framework REST API directly rather than hosting
// Microsoft's Teams SDK. The SDK owns an HTTP server and expects one bot per
// process; this is one multi-tenant API serving every customer's channels
// behind a single ingress, so the SDK's server cannot be mounted per channel.

// Every activity Teams delivers is signed by the Bot Connector under this
// issuer, with the bot's own app id as the audience.
export const MSTEAMS_TOKEN_ISSUER = 'https://api.botframework.com'
const MSTEAMS_OPENID_CONFIG_URL =
    'https://login.botframework.com/v1/.well-known/openidconfiguration'

const MSTEAMS_TOKEN_SCOPE = 'https://api.botframework.com/.default'
const ENTRA_TOKEN_HOST = 'https://login.microsoftonline.com'

// Bot Connector hosts a stored serviceUrl is allowed to point at. A doctored
// or replayed serviceUrl would otherwise redirect a bot-authenticated reply to
// an attacker, so the host is pinned rather than trusted. Sovereign clouds get
// their own entry when Microsoft publishes one.
const ALLOWED_SERVICE_URL_HOSTS = new Set([
    'smba.trafficmanager.net',
    'smba.infra.gcc.teams.microsoft.com',
    'smba.infra.gov.teams.microsoft.us',
    'smba.infra.dod.teams.microsoft.us'
])

const JWKS_TTL_MS = 10 * 60 * 1000
// Mint a minute early so a token can't expire in flight.
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000

// jose is ESM-only; apps/api builds to CJS. The same shim the OIDC login
// verifier uses (modules/auth/oidc-token-verifier.service.ts) keeps tsc from
// rewriting this into a require().
type JoseModule = typeof import('jose')

const importJose = ((): (() => Promise<JoseModule>) => {
    const dynamicImport = new Function(
        'specifier',
        'return import(specifier)'
    ) as (specifier: string) => Promise<JoseModule>
    return () => dynamicImport('jose')
})()

export interface MsTeamsAppCredentials {
    appId: string
    appPassword: string
    tenantId: string
}

export interface MsTeamsTokenCheck {
    ok: boolean
    reason?: string
}

// True for a host the Bot Connector itself serves. Inline images and other
// bot-readable attachments live here and need the bot token; anywhere else must
// never see it.
export const isMsTeamsConnectorHost = (hostname: string): boolean =>
    ALLOWED_SERVICE_URL_HOSTS.has(hostname)

// Normalize a Bot Connector base so the two forms Teams and Microsoft's docs
// use ('…/teams' and '…/teams/') produce one URL. Returns null when the host is
// not a Bot Connector, which every caller must treat as fatal.
export const normalizeMsTeamsServiceUrl = (raw: string): string | null => {
    let url: URL
    try {
        url = new URL(raw.trim())
    } catch {
        return null
    }
    if (url.protocol !== 'https:') return null
    if (!ALLOWED_SERVICE_URL_HOSTS.has(url.hostname)) return null
    // Path is significant: the connector is regional ('/teams', '/emea/').
    // Query and fragment are not, and carrying them would corrupt the
    // /v3/conversations path appended to this base.
    const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
    return `${url.origin}${path}`
}

interface JsonWebKeySet {
    keys?: Array<Record<string, unknown> & { kid?: string; alg?: string }>
}

interface OpenIdConfiguration {
    jwks_uri?: string
}

const jwksCache = new Map<string, { keys: JsonWebKeySet; fetchedAt: number }>()
let jwksUriCache: { uri: string; fetchedAt: number } | null = null

// Exposed so tests start from a clean cache; also lets an operator-triggered
// re-register recover from a key set cached during an outage.
export const resetMsTeamsJwksCache = (): void => {
    jwksCache.clear()
    jwksUriCache = null
}

// Microsoft rotates the signing keys and moves the key-set URL, so the
// document is discovered rather than hardcoded, on the same TTL as the keys.
const resolveJwksUri = async (): Promise<string> => {
    if (jwksUriCache && Date.now() - jwksUriCache.fetchedAt < JWKS_TTL_MS)
        return jwksUriCache.uri
    const res = await channelProviderJsonRequest<OpenIdConfiguration>({
        provider: 'msteams',
        operation: 'openid.configuration',
        url: MSTEAMS_OPENID_CONFIG_URL,
        init: { method: 'GET' }
    })
    const uri = res.json?.jwks_uri
    if (!res.ok || typeof uri !== 'string' || uri.length === 0)
        throw new Error(`openid configuration fetch failed: http ${res.status}`)
    jwksUriCache = { uri, fetchedAt: Date.now() }
    return uri
}

const fetchJwks = async (url: string): Promise<JsonWebKeySet> => {
    const cached = jwksCache.get(url)
    if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys
    const res = await channelProviderJsonRequest<JsonWebKeySet>({
        provider: 'msteams',
        operation: 'jwks',
        url,
        init: { method: 'GET' }
    })
    if (!res.ok || !res.json?.keys)
        throw new Error(`jwks fetch failed: http ${res.status}`)
    const keys = res.json
    jwksCache.set(url, { keys, fetchedAt: Date.now() })
    return keys
}

// Verify the Bearer token the Bot Connector puts on every inbound request.
// Returns a reason instead of throwing so the webhook controller can record it
// and answer 401.
export const verifyMsTeamsToken = async (opts: {
    token: string
    appId: string
    serviceUrl: string | null
}): Promise<MsTeamsTokenCheck> => {
    const { token, appId, serviceUrl } = opts
    if (token.length === 0) return { ok: false, reason: 'missing_token' }
    if (appId.length === 0) return { ok: false, reason: 'app_id_missing' }
    try {
        const { decodeProtectedHeader, importJWK, jwtVerify } =
            await importJose()
        const header = decodeProtectedHeader(token)
        const jwks = await fetchJwks(await resolveJwksUri())
        const jwk = (jwks.keys ?? []).find((k) => k.kid === header.kid)
        if (!jwk) return { ok: false, reason: 'unknown_signing_key' }
        const key = await importJWK(jwk, header.alg ?? 'RS256')
        const { payload } = await jwtVerify(token, key, {
            audience: appId,
            issuer: MSTEAMS_TOKEN_ISSUER,
            algorithms: ['RS256']
        })
        // The token is scoped to the endpoint it authorizes replies for. Without
        // this check a token captured from one bot's traffic would authenticate
        // an activity whose serviceUrl points somewhere else entirely, and the
        // reply would follow the payload rather than the signed claim.
        const claimed = payload.serviceurl
        if (typeof claimed === 'string' && claimed.length > 0) {
            const expected = serviceUrl
                ? normalizeMsTeamsServiceUrl(serviceUrl)
                : null
            if (!expected) return { ok: false, reason: 'service_url_rejected' }
            if (normalizeMsTeamsServiceUrl(claimed) !== expected)
                return { ok: false, reason: 'service_url_mismatch' }
        }
        return { ok: true }
    } catch (err) {
        // Includes signature, aud, iss and exp failures, and a JWKS fetch that
        // did not come back — all of which must fail closed.
        return {
            ok: false,
            reason: `token_verification_failed:${(err as Error).message.slice(0, 120)}`
        }
    }
}

interface MintedToken {
    accessToken: string
    expiresAt: number
}

const tokenCache = new Map<string, MintedToken>()

export const resetMsTeamsTokenCache = (): void => tokenCache.clear()

// Exchange the app registration's client secret for a Bot Connector access
// token (client_credentials), cached per channel until just before it expires.
export const getMsTeamsAccessToken = async (
    cacheKey: string,
    credentials: MsTeamsAppCredentials
): Promise<string> => {
    const cached = tokenCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken
    const res = await channelProviderJsonRequest<{
        access_token?: string
        expires_in?: number
        error_description?: string
        error?: string
    }>({
        provider: 'msteams',
        operation: 'oauth2.token',
        url: `${ENTRA_TOKEN_HOST}/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: credentials.appId,
                client_secret: credentials.appPassword,
                scope: MSTEAMS_TOKEN_SCOPE
            }).toString()
        }
    })
    const accessToken = res.json?.access_token
    if (!res.ok || !accessToken) {
        const detail =
            res.json?.error_description ??
            res.json?.error ??
            res.text.slice(0, 200)
        throw new Error(`msteams token mint failed: http ${res.status}: ${detail}`)
    }
    const expiresInMs = (res.json?.expires_in ?? 3600) * 1000
    tokenCache.set(cacheKey, {
        accessToken,
        expiresAt: Date.now() + expiresInMs - TOKEN_EXPIRY_SKEW_MS
    })
    return accessToken
}

// Drop a channel's cached token so the next call re-mints. Called on a 401,
// where the cause is usually a token minted before a credential rotation.
export const invalidateMsTeamsAccessToken = (cacheKey: string): void => {
    tokenCache.delete(cacheKey)
}
