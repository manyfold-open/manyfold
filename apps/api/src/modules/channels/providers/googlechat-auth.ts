import { createPrivateKey, createSign } from 'node:crypto'
import type { GoogleChatAudienceType } from '@manyfold/shared'
import { channelProviderJsonRequest } from './channel-http'

// Inbound and outbound auth for the Google Chat channel. Kept out of the
// provider so the JWT work is unit-testable on its own and the provider file
// stays about Chat semantics.

// Chat signs every inbound request as this account, in both audience modes.
export const GOOGLE_CHAT_ISSUER = 'chat@system.gserviceaccount.com'

// 'app-url' mode sends a Google-issued OIDC ID token; 'project-number' mode
// sends a JWT the Chat service account signed for itself. Different issuers,
// different key sets.
const GOOGLE_OIDC_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const GOOGLE_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_CHAT_JWKS_URL = `https://www.googleapis.com/service_accounts/v1/jwk/${GOOGLE_CHAT_ISSUER}`

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
export const GOOGLE_CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'

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

export interface GoogleChatServiceAccount {
    clientEmail: string
    privateKey: string
    tokenUri: string
}

export interface GoogleChatTokenCheck {
    ok: boolean
    reason?: string
}

// Parse and sanity-check a downloaded service-account key file. A doctored key
// can point token_uri at an attacker host, which would hand them a signed
// assertion for this account — so the endpoint is pinned rather than trusted.
export const parseGoogleChatServiceAccount = (
    raw: string
): GoogleChatServiceAccount => {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('serviceAccountJson is not valid JSON')
    }
    if (parsed === null || typeof parsed !== 'object')
        throw new Error('serviceAccountJson must be a JSON object')
    const sa = parsed as Record<string, unknown>
    if (typeof sa.type === 'string' && sa.type !== 'service_account')
        throw new Error(`serviceAccountJson type must be service_account, got ${sa.type}`)
    const clientEmail =
        typeof sa.client_email === 'string' ? sa.client_email.trim() : ''
    if (clientEmail.length === 0)
        throw new Error('serviceAccountJson is missing client_email')
    const privateKey =
        typeof sa.private_key === 'string' ? sa.private_key : ''
    if (!privateKey.includes('PRIVATE KEY'))
        throw new Error('serviceAccountJson is missing a PEM private_key')
    const tokenUri =
        typeof sa.token_uri === 'string' && sa.token_uri.trim().length > 0
            ? sa.token_uri.trim()
            : GOOGLE_TOKEN_URI
    if (tokenUri !== GOOGLE_TOKEN_URI)
        throw new Error(`serviceAccountJson token_uri must be ${GOOGLE_TOKEN_URI}`)
    return { clientEmail, privateKey, tokenUri }
}

interface JsonWebKeySet {
    keys?: Array<Record<string, unknown> & { kid?: string; alg?: string }>
}

const jwksCache = new Map<string, { keys: JsonWebKeySet; fetchedAt: number }>()

const fetchJwks = async (url: string): Promise<JsonWebKeySet> => {
    const cached = jwksCache.get(url)
    if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys
    const res = await channelProviderJsonRequest<JsonWebKeySet>({
        provider: 'googlechat',
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

// Exposed so tests start from a clean cache; also lets an operator-triggered
// re-register recover from a key set cached during an outage.
export const resetGoogleChatJwksCache = (): void => jwksCache.clear()

// Verify the Bearer token Chat puts on every inbound request. Returns a reason
// instead of throwing so the webhook controller can record it and answer 401.
export const verifyGoogleChatToken = async (opts: {
    token: string
    audienceType: GoogleChatAudienceType
    audience: string
}): Promise<GoogleChatTokenCheck> => {
    const { token, audienceType, audience } = opts
    if (token.length === 0) return { ok: false, reason: 'missing_token' }
    if (audience.length === 0) return { ok: false, reason: 'audience_missing' }
    const isOidc = audienceType === 'app-url'
    const jwksUrl = isOidc ? GOOGLE_OIDC_JWKS_URL : GOOGLE_CHAT_JWKS_URL
    try {
        const { decodeProtectedHeader, importJWK, jwtVerify } =
            await importJose()
        const header = decodeProtectedHeader(token)
        const jwks = await fetchJwks(jwksUrl)
        const jwk = (jwks.keys ?? []).find((k) => k.kid === header.kid)
        if (!jwk) return { ok: false, reason: 'unknown_signing_key' }
        const key = await importJWK(jwk, header.alg ?? 'RS256')
        const { payload } = await jwtVerify(token, key, {
            audience,
            algorithms: ['RS256'],
            ...(isOidc ? {} : { issuer: GOOGLE_CHAT_ISSUER })
        })
        if (isOidc) {
            if (!GOOGLE_OIDC_ISSUERS.includes(String(payload.iss)))
                return { ok: false, reason: 'unexpected_issuer' }
            // In OIDC mode the issuer is Google at large, so the Chat service
            // account has to be identified by the verified email claim —
            // otherwise any Google-issued token for this URL would pass.
            if (payload.email_verified !== true)
                return { ok: false, reason: 'email_not_verified' }
            if (payload.email !== GOOGLE_CHAT_ISSUER)
                return { ok: false, reason: 'unexpected_token_identity' }
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

export const resetGoogleChatTokenCache = (): void => tokenCache.clear()

// Exchange a self-signed service-account assertion for a chat.bot access
// token (RFC 7523 jwt-bearer grant), cached per channel until just before it
// expires. Mirrors buildGithubAppJwt in modules/connections/github-app-jwt.ts.
export const getGoogleChatAccessToken = async (
    cacheKey: string,
    sa: GoogleChatServiceAccount
): Promise<string> => {
    const cached = tokenCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = b64url(
        JSON.stringify({
            iss: sa.clientEmail,
            scope: GOOGLE_CHAT_SCOPE,
            aud: sa.tokenUri,
            iat: now,
            exp: now + 3600
        })
    )
    const data = `${header}.${claims}`
    const signature = createSign('RSA-SHA256')
        .update(data)
        .sign(createPrivateKey(sa.privateKey))
        .toString('base64url')
    const res = await channelProviderJsonRequest<{
        access_token?: string
        expires_in?: number
        error_description?: string
        error?: string
    }>({
        provider: 'googlechat',
        operation: 'oauth2.token',
        url: sa.tokenUri,
        init: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: `${data}.${signature}`
            }).toString()
        }
    })
    const accessToken = res.json?.access_token
    if (!res.ok || !accessToken) {
        const detail =
            res.json?.error_description ??
            res.json?.error ??
            res.text.slice(0, 200)
        throw new Error(`googlechat token mint failed: http ${res.status}: ${detail}`)
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
export const invalidateGoogleChatAccessToken = (cacheKey: string): void => {
    tokenCache.delete(cacheKey)
}

const b64url = (value: string): string =>
    Buffer.from(value, 'utf8').toString('base64url')
