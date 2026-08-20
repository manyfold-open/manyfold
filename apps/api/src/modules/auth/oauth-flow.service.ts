import { createObjectId } from '@manyfold/shared'
import { createHash, randomBytes } from 'node:crypto'
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, isNull } from 'drizzle-orm'
import type { AcquisitionAttributionTokens } from '@/common/ports/acquisition.ports'
import {
    authIdentities,
    oauthStates,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { configString } from '@/common/config-alias'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import {
    ACQUISITION_PORT,
    type AcquisitionPort
} from '@/common/ports/acquisition.ports'
import {
    AuthSettingsService,
    type PrivateGoogleSettings,
    type PrivateOidcSettings
} from './auth-settings.service'
import { AuthService } from './auth.service'
import { EmailVerificationService } from './email-verification.service'
import { GOOGLE_OIDC_ISSUER } from './linked-identities'
import {
    OidcTokenVerifierService,
    type OidcVerifierSettings
} from './oidc-token-verifier.service'
import { SessionService, type SessionProvider } from './session.service'

export type OauthProvider = 'google' | 'oidc'

export type OauthCallbackResult =
    | { kind: 'session'; token: string; redirectAfter: string | null }
    | {
          kind: 'link'
          error: 'identity_in_use' | null
          // Set when the user completed consent with an ALREADY-linked
          // identity: that is a re-authentication, and the proof unlocks
          // change-email for password-less accounts. A newly-linked identity
          // never mints one — a hijacked session must not vouch for itself
          // by connecting the attacker's own account.
          reauthToken: string | null
      }

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const STATE_TTL_MS = 10 * 60_000

interface OidcEndpoints {
    authorizationEndpoint: string
    tokenEndpoint: string
}

@Injectable()
export class OauthFlowService {
    private readonly log = new Logger(OauthFlowService.name)
    private readonly discoveryCache = new Map<string, OidcEndpoints>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService,
        private readonly authSettings: AuthSettingsService,
        private readonly oidc: OidcTokenVerifierService,
        private readonly auth: AuthService,
        private readonly sessions: SessionService,
        private readonly emailVerification: EmailVerificationService,
        @Inject(ACQUISITION_PORT)
        private readonly attribution: AcquisitionPort
    ) {}

    async start(args: {
        provider: OauthProvider
        redirectAfter: string | null
        // Link mode: attach the resulting identity to this signed-in user
        // instead of minting a session (the Account page's Connect flow).
        linkUserId?: string | null
        // Mint time of the initiating session, so the callback only issues a
        // reauth proof for an identity that predates it.
        linkSessionAt?: Date | null
        // Acquisition touch tokens resolved here (start is the last moment
        // the browser context is ours) and persisted on the state row so
        // attribution survives the IdP round trip.
        attributionTokens?: AcquisitionAttributionTokens | null
    }): Promise<{ authorizeUrl: string }> {
        const settings = await this.authSettings.getPrivateSettings()
        const codeVerifier = base64url(randomBytes(32))
        const codeChallenge = base64url(
            createHash('sha256').update(codeVerifier).digest()
        )
        const state = base64url(randomBytes(32))
        const now = new Date()

        let authorizationEndpoint: string
        let clientId: string
        let scope: string
        if (args.provider === 'google') {
            const google = this.requireGoogle(settings.google)
            authorizationEndpoint = GOOGLE_AUTH_ENDPOINT
            clientId = google.clientId
            scope = 'openid email profile'
        } else {
            const oidc = this.requireOidc(settings.oidc)
            authorizationEndpoint = (await this.endpoints(oidc.authority))
                .authorizationEndpoint
            clientId = oidc.clientId
            scope = oidc.scope || 'openid profile email'
        }

        const touches = await this.attribution.resolveTouches(
            args.attributionTokens
        )
        const stateId = createObjectId('oauthState')
        await this.db.insert(oauthStates).values({
            id: stateId,
            provider: args.provider,
            stateHash: hashState(state),
            codeVerifier,
            redirectAfter: args.redirectAfter,
            linkUserId: args.linkUserId ?? null,
            linkSessionAt: args.linkSessionAt ?? null,
            expiresAt: new Date(now.getTime() + STATE_TTL_MS)
        })
        // §4.2-a switch: the snapshot lives only in cloud-owned storage now
        // (the dormant oauth_states columns drop at contract).
        await this.attribution.stashOauthTouches(stateId, touches)

        const url = new URL(authorizationEndpoint)
        url.searchParams.set('client_id', clientId)
        url.searchParams.set('redirect_uri', this.callbackUrl(args.provider))
        url.searchParams.set('response_type', 'code')
        url.searchParams.set('scope', scope)
        url.searchParams.set('state', state)
        url.searchParams.set('code_challenge', codeChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        url.searchParams.set('prompt', 'select_account')
        return { authorizeUrl: url.toString() }
    }

    async callback(args: {
        provider: OauthProvider
        code: string
        state: string
        userAgent?: string | null
        ip?: string | null
    }): Promise<OauthCallbackResult> {
        const [stateRow] = await this.db
            .update(oauthStates)
            .set({ consumedAt: new Date() })
            .where(
                and(
                    eq(oauthStates.stateHash, hashState(args.state)),
                    eq(oauthStates.provider, args.provider),
                    isNull(oauthStates.consumedAt)
                )
            )
            .returning()
        if (!stateRow)
            throw new BadRequestException({
                code: 'auth.oauth_state_invalid',
                message: 'invalid or already-used oauth state'
            })
        if (stateRow.expiresAt <= new Date())
            throw new BadRequestException({
                code: 'auth.oauth_state_invalid',
                message: 'oauth state expired'
            })

        const settings = await this.authSettings.getPrivateSettings()
        let verifierSettings: OidcVerifierSettings
        let tokenEndpoint: string
        let clientId: string
        let clientSecret: string
        if (args.provider === 'google') {
            const google = this.requireGoogle(settings.google)
            tokenEndpoint = GOOGLE_TOKEN_ENDPOINT
            clientId = google.clientId
            clientSecret = google.clientSecret
            verifierSettings = {
                authority: GOOGLE_OIDC_ISSUER,
                clientId: google.clientId,
                audience: google.clientId,
                jwksUrl: null,
                userIdClaim: 'sub',
                emailClaim: 'email'
            }
        } else {
            const oidc = this.requireOidc(settings.oidc)
            tokenEndpoint = (await this.endpoints(oidc.authority)).tokenEndpoint
            clientId = oidc.clientId
            clientSecret = oidc.clientSecret
            verifierSettings = {
                authority: oidc.authority,
                clientId: oidc.clientId,
                audience: oidc.audience,
                jwksUrl: oidc.jwksUrl,
                userIdClaim: oidc.userIdClaim,
                emailClaim: oidc.emailClaim
            }
        }

        const idToken = await this.exchangeCode({
            tokenEndpoint,
            code: args.code,
            redirectUri: this.callbackUrl(args.provider),
            clientId,
            clientSecret,
            codeVerifier: stateRow.codeVerifier
        })
        const external = await this.oidc.verify(idToken, verifierSettings)
        if (stateRow.linkUserId) {
            // Link mode: attach ONLY the provider identity to the initiating
            // user — never the derived email identity, which would silently
            // grant email login for the address (same rule as bindNetmind).
            // No session is minted; the user is already signed in.
            const linked = await this.auth.linkIdentities(
                stateRow.linkUserId,
                [
                    {
                        provider: external.provider,
                        subject: external.subject,
                        email: external.email
                    }
                ],
                external.email
            )
            if (linked.conflicts > 0)
                return {
                    kind: 'link',
                    error: 'identity_in_use',
                    reauthToken: null
                }
            // Only vouch for the session when the re-consented identity was
            // linked BEFORE that session started. `existingIdentities > 0`
            // alone is not enough: a hijacked session can connect the
            // attacker's own account, then re-run the flow so the freshly
            // added identity now reads as "existing" and vouches for itself.
            const identityAt = await this.identityCreatedAt(
                external.provider,
                external.subject
            )
            const reauthToken =
                identityAt &&
                stateRow.linkSessionAt &&
                identityAt < stateRow.linkSessionAt
                    ? await this.emailVerification.issueReauthProof(
                          stateRow.linkUserId,
                          external.email
                      )
                    : null
            return { kind: 'link', error: null, reauthToken }
        }
        const { user, created } =
            await this.auth.upsertExternalIdentityWithResult(external)
        if (created)
            await this.attribution.recordAccountCreated({
                userId: user.id,
                email: external.email,
                oauthStateId: stateRow.id
            })
        else
            await this.attribution.applyUserTouches({
                userId: user.id,
                oauthStateId: stateRow.id
            })
        const session = await this.sessions.mint({
            userId: user.id,
            provider: external.provider as SessionProvider,
            subject: external.subject,
            userAgent: args.userAgent ?? null,
            ip: args.ip ?? null
        })
        return {
            kind: 'session',
            token: session.token,
            redirectAfter: stateRow.redirectAfter
        }
    }

    private async identityCreatedAt(
        provider: 'oidc' | 'google' | 'email' | 'netmind',
        subject: string
    ): Promise<Date | null> {
        const [row] = await this.db
            .select({ createdAt: authIdentities.createdAt })
            .from(authIdentities)
            .where(
                and(
                    eq(authIdentities.provider, provider),
                    eq(authIdentities.subject, subject)
                )
            )
            .limit(1)
        return row?.createdAt ?? null
    }

    private async exchangeCode(args: {
        tokenEndpoint: string
        code: string
        redirectUri: string
        clientId: string
        clientSecret: string
        codeVerifier: string
    }): Promise<string> {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: args.code,
            redirect_uri: args.redirectUri,
            client_id: args.clientId,
            client_secret: args.clientSecret,
            code_verifier: args.codeVerifier
        })
        const res = await fetch(args.tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
            signal: AbortSignal.timeout(15_000)
        })
        if (!res.ok) {
            const detail = (await res.text().catch(() => '')).slice(0, 300)
            this.log.warn(
                `oauth token exchange failed ${res.status}: ${detail}`
            )
            throw new BadRequestException({
                code: 'auth.oauth_failed',
                message: 'oauth token exchange failed'
            })
        }
        const payload = (await res.json()) as { id_token?: unknown }
        if (typeof payload.id_token !== 'string' || !payload.id_token)
            throw new BadRequestException({
                code: 'auth.oauth_failed',
                message: 'oauth response missing id_token'
            })
        return payload.id_token
    }

    private async endpoints(authority: string): Promise<OidcEndpoints> {
        const cached = this.discoveryCache.get(authority)
        if (cached) return cached
        const discoveryUrl = `${trimTrailingSlash(
            authority
        )}/.well-known/openid-configuration`
        const res = await fetch(discoveryUrl)
        if (!res.ok)
            throw new BadRequestException({
                code: 'auth.oauth_failed',
                message: `oidc discovery failed: ${res.status}`
            })
        const body = (await res.json()) as {
            authorization_endpoint?: unknown
            token_endpoint?: unknown
        }
        if (
            typeof body.authorization_endpoint !== 'string' ||
            typeof body.token_endpoint !== 'string'
        )
            throw new BadRequestException({
                code: 'auth.oauth_failed',
                message: 'oidc discovery missing endpoints'
            })
        const endpoints: OidcEndpoints = {
            authorizationEndpoint: body.authorization_endpoint,
            tokenEndpoint: body.token_endpoint
        }
        this.discoveryCache.set(authority, endpoints)
        return endpoints
    }

    private callbackUrl(provider: OauthProvider): string {
        const base = configString(this.config, ['PUBLIC_API_BASE_URL'])
        if (!base)
            throw new BadRequestException({
                code: 'auth.oauth_failed',
                message: 'PUBLIC_API_BASE_URL is not configured'
            })
        return `${publicApiUrlWithApiPrefix(base)}/auth/oauth/${provider}/callback`
    }

    private requireGoogle(
        google: PrivateGoogleSettings | null
    ): PrivateGoogleSettings {
        if (!google?.enabled)
            throw new BadRequestException({
                code: 'auth.provider_disabled',
                message: 'Google login is not enabled'
            })
        return google
    }

    private requireOidc(oidc: PrivateOidcSettings | null): PrivateOidcSettings {
        if (!oidc?.enabled)
            throw new BadRequestException({
                code: 'auth.provider_disabled',
                message: 'OIDC login is not enabled'
            })
        return oidc
    }
}

const base64url = (buf: Buffer): string => buf.toString('base64url')


const hashState = (state: string): string =>
    createHash('sha256').update(state).digest('hex')

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')
