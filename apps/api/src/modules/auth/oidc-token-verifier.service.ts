import { Injectable } from '@nestjs/common'
import type { JWTPayload, JWTVerifyResult } from 'jose'
import type { ExternalAuthIdentity } from './auth-principal'
import { isGoogleIssuer, normalizeEmail } from './linked-identities'

export interface OidcVerifierSettings {
    authority: string
    clientId: string
    audience: string | null
    jwksUrl: string | null
    userIdClaim: string
    emailClaim: string
}

type JoseModule = typeof import('jose')
type RemoteJWKSet = ReturnType<JoseModule['createRemoteJWKSet']>

const importJose = ((): (() => Promise<JoseModule>) => {
    const dynamicImport = new Function(
        'specifier',
        'return import(specifier)'
    ) as (specifier: string) => Promise<JoseModule>
    return () => dynamicImport('jose')
})()

@Injectable()
export class OidcTokenVerifierService {
    private readonly jwks = new Map<string, RemoteJWKSet>()

    async verify(
        token: string,
        settings: OidcVerifierSettings
    ): Promise<ExternalAuthIdentity> {
        const { jwtVerify } = await importJose()
        const issuer = settings.authority
        const audience = settings.audience || settings.clientId

        const result = (await jwtVerify(token, await this.jwksSet(settings), {
            issuer,
            audience
        })) as JWTVerifyResult<JWTPayload>
        const payload = result.payload
        const subject = claimString(payload, settings.userIdClaim)
        const email = claimString(payload, settings.emailClaim)
        // Seed-only: used once at account creation for the initial display
        // name, never synced on later sign-ins (the user owns it after that).
        const displayName = claimString(payload, 'name')
        if (!subject) throw new Error('Invalid token payload: missing subject')
        if (!email) throw new Error('Invalid token payload: missing email')
        if (!isGoogleIssuer(issuer)) {
            // Reject an explicitly-unverified email so a misconfigured IdP can't
            // promote an initial-admin email it never verified. A missing claim
            // is trusted to the configured IdP (many omit it).
            if (
                payload.email_verified === false ||
                payload.email_verified === 'false'
            )
                throw new Error('Invalid token payload: email is not verified')
            return {
                provider: 'oidc',
                subject,
                email,
                ...(displayName ? { displayName } : {})
            }
        }

        if (payload.email_verified !== true && payload.email_verified !== 'true')
            throw new Error('Invalid token payload: email is not verified')
        const verifiedEmail = normalizeEmail(email)
        if (!verifiedEmail)
            throw new Error('Invalid token payload: missing verified email')
        return {
            provider: 'google',
            subject,
            email: verifiedEmail,
            ...(displayName ? { displayName } : {}),
            linkedIdentities: [
                {
                    provider: 'email',
                    subject: verifiedEmail,
                    email: verifiedEmail,
                    sourceEmail: verifiedEmail
                }
            ]
        }
    }

    private async jwksSet(
        settings: OidcVerifierSettings
    ): Promise<RemoteJWKSet> {
        const url = await this.jwksUrl(settings)
        const cached = this.jwks.get(url)
        if (cached) return cached
        const { createRemoteJWKSet } = await importJose()
        const next = createRemoteJWKSet(new URL(url))
        this.jwks.set(url, next)
        return next
    }

    private async jwksUrl(
        settings: OidcVerifierSettings
    ): Promise<string> {
        if (settings.jwksUrl) return settings.jwksUrl

        const issuer = trimTrailingSlash(settings.authority)
        const discoveryUrl = `${issuer}/.well-known/openid-configuration`
        const res = await fetch(discoveryUrl)
        if (!res.ok)
            throw new Error(
                `OIDC discovery failed: ${res.status} ${res.statusText}`
            )
        const body = (await res.json()) as { jwks_uri?: unknown }
        if (typeof body.jwks_uri !== 'string' || !body.jwks_uri.trim())
            throw new Error('OIDC discovery response missing jwks_uri')
        return body.jwks_uri
    }
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const claimString = (payload: JWTPayload, claim: string): string => {
    const value = payload[claim]
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) {
        const first = value.find((item) => typeof item === 'string')
        return typeof first === 'string' ? first.trim() : ''
    }
    return ''
}
