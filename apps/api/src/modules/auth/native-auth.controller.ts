import {
    AuthForgotPasswordBody,
    AuthLoginBody,
    AuthOkResponse,
    AuthRegisterBody,
    AuthRegisterResponse,
    AuthResendCodeBody,
    AuthResetPasswordBody,
    AuthSessionResponse,
    AuthSessionUser,
    AuthVerifyEmailBody,
    NetmindLoginBody,
    createObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Get,
    NotFoundException,
    Param,
    Post,
    Query,
    Req,
    Res,
    UnauthorizedException,
    Inject,
    UseGuards
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { User } from '@manyfold/db'
import { AuthGuard } from '@/common/guards/auth.guard'
import { configString } from '@/common/config-alias'
import {
    ACQUISITION_PORT,
    type AcquisitionPort
} from '@/common/ports/acquisition.ports'
import { isApiToken } from './api-token.service'
import { AuthService } from './auth.service'
import { AuthSettingsService } from './auth-settings.service'
import { CliAuthRateLimitService } from './cli-auth-rate-limit.service'
import { clientKey } from './cli-auth.controller'
import { EmailVerificationService } from './email-verification.service'
import { normalizeEmail } from './linked-identities'
import { OauthFlowService, type OauthProvider } from './oauth-flow.service'
import { PasswordService } from './password.service'
import { SessionService, type SessionProvider } from './session.service'
import {
    NetmindTokenVerifierService,
    netmindHttpError
} from './netmind-token-verifier.service'

const RATE_WINDOW_MS = 60_000
const REGISTER_LIMIT = 20
const LOGIN_LIMIT = 30
const VERIFY_LIMIT = 30
const RESEND_LIMIT = 10
const FORGOT_LIMIT = 10
const RESET_LIMIT = 30

@Controller('auth')
export class NativeAuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly authSettings: AuthSettingsService,
        private readonly passwords: PasswordService,
        private readonly sessions: SessionService,
        private readonly netmind: NetmindTokenVerifierService,
        private readonly emailVerification: EmailVerificationService,
        private readonly oauthFlow: OauthFlowService,
        private readonly rateLimit: CliAuthRateLimitService,
        private readonly config: ConfigService,
        @Inject(ACQUISITION_PORT)
        private readonly attribution: AcquisitionPort
    ) {}

    @Post('register')
    async register(
        @Body() body: AuthRegisterBody,
        @Req() req: FastifyRequest
    ): Promise<AuthRegisterResponse> {
        this.limit('register', req, REGISTER_LIMIT)
        const email = this.requireEmail(body.email)
        this.passwords.validatePolicy(body.password)
        const settings = await this.authSettings.getPrivateSettings()
        if (!settings.passwordEnabled)
            throw new BadRequestException({
                code: 'auth.password_disabled',
                message: 'password sign-up is disabled'
            })
        if (await this.auth.findUserIdByIdentity('email', email))
            throw new ConflictException({
                code: 'auth.email_in_use',
                message: 'an account with that email already exists'
            })

        const verify = settings.emailVerificationRequired
        const pendingUserId = await this.emailVerification.pendingUserId(
            email,
            'email_verify'
        )
        const userId =
            pendingUserId ??
            (
                await this.auth.upsertUser(
                    { id: createObjectId('user'), email },
                    { fireSignupHooks: !verify }
                )
            ).id
        await this.passwords.set(userId, body.password)

        if (verify) {
            await this.emailVerification.issue({
                userId,
                email,
                purpose: 'email_verify'
            })
            return { pendingVerification: true, email }
        }

        await this.linkVerifiedEmail(userId, email)
        // No verification gate on this install, so this IS the account-created
        // moment (the deferred path records it in verifyEmail instead).
        await this.attribution.recordAccountCreated({
            userId,
            email,
            touches: await this.attribution.resolveTouches(body)
        })
        return this.sessionResponse(userId, email, req)
    }

    @Post('verify-email')
    async verifyEmail(
        @Body() body: AuthVerifyEmailBody,
        @Req() req: FastifyRequest
    ): Promise<AuthSessionResponse> {
        this.limit('verify', req, VERIFY_LIMIT)
        const email = this.requireEmail(body.email)
        const userId = await this.emailVerification.verify({
            email,
            code: body.code ?? '',
            purpose: 'email_verify'
        })
        if (!userId)
            throw new BadRequestException({
                code: 'auth.code_invalid',
                message: 'the verification code is invalid or expired'
            })
        await this.linkVerifiedEmail(userId, email)
        // Email is now proven — run the deferred new-user side effects (managed
        // bootstrap + signup credit) that register() withheld.
        await this.auth.completeDeferredSignup(userId)
        // The client re-sends its touch tokens here because register() stores
        // nothing server-side while the address is unproven.
        await this.attribution.recordAccountCreated({
            userId,
            email,
            touches: await this.attribution.resolveTouches(body)
        })
        return this.sessionResponse(userId, email, req)
    }

    @Post('resend-code')
    async resendCode(
        @Body() body: AuthResendCodeBody,
        @Req() req: FastifyRequest
    ): Promise<AuthOkResponse> {
        this.limit('resend', req, RESEND_LIMIT)
        const email = normalizeEmail(body.email)
        if (email) {
            const userId = await this.emailVerification.pendingUserId(
                email,
                'email_verify'
            )
            if (userId)
                await this.emailVerification
                    .issue({ userId, email, purpose: 'email_verify' })
                    .catch(() => undefined)
        }
        return { ok: true }
    }

    @Post('login')
    async login(
        @Body() body: AuthLoginBody,
        @Req() req: FastifyRequest
    ): Promise<AuthSessionResponse> {
        // In-memory per-IP limiter is the first line; argon2id verify cost is the
        // second. NOTE: the limiter is per-machine, so it is not a hard
        // cross-instance brute-force bound — acceptable alongside the slow hash
        // for now; revisit with a DB counter if abuse appears.
        this.limit('login', req, LOGIN_LIMIT)
        await this.requirePasswordEnabled()
        const email = normalizeEmail(body.email)
        const userId = email
            ? await this.auth.findUserIdByIdentity('email', email)
            : null
        // Always run an argon2 verify (PasswordService dummy-hashes when no row
        // exists) so response time does not reveal whether the account exists.
        const ok = await this.passwords.verify(
            userId ?? 'absent',
            body.password ?? ''
        )
        if (!userId || !ok)
            throw new UnauthorizedException({
                code: 'auth.invalid_credentials',
                message: 'incorrect email or password'
            })
        await this.attribution.applyUserTouches({
            userId,
            touches: await this.attribution.resolveTouches(body)
        })
        return this.sessionResponse(userId, email, req)
    }

    // NetMind login: trade a NetMind loginToken for a Manyfold session. Resolve-
    // or-create the user by their netmind identity, so a user who bound NetMind
    // in settings lands on their EXISTING account. Session is minted with
    // provider 'netmind' (not 'email'). Public — the loginToken IS the credential.
    @Post('netmind')
    async netmindLogin(
        @Body() body: NetmindLoginBody,
        @Req() req: FastifyRequest
    ): Promise<AuthSessionResponse> {
        this.limit('login', req, LOGIN_LIMIT)
        const loginToken = body?.loginToken?.trim()
        if (!loginToken)
            throw new BadRequestException({
                code: 'auth.netmind_token_required',
                message: 'loginToken is required'
            })
        const identity = await this.netmind
            .verify(loginToken)
            .catch(netmindHttpError)
        const { user, created } =
            await this.auth.upsertExternalIdentityWithResult(identity)
        const touches = await this.attribution.resolveTouches(body)
        if (created)
            await this.attribution.recordAccountCreated({
                userId: user.id,
                email: identity.email,
                touches
            })
        else await this.attribution.applyUserTouches({ userId: user.id, touches })
        void this.auth.notifyNetmindLogin({
            userId: user.id,
            loginToken,
            identity: { subject: identity.subject, email: identity.email },
            trigger: 'login'
        })
        return this.sessionResponse(user.id, identity.subject, req, 'netmind')
    }

    @Post('logout')
    @UseGuards(AuthGuard)
    async logout(@Req() req: FastifyRequest): Promise<AuthOkResponse> {
        const token = bearerToken(req)
        if (isApiToken(token))
            throw new BadRequestException({
                code: 'auth.not_a_session',
                message: 'api tokens are revoked from settings, not logout'
            })
        await this.sessions.revoke(token)
        return { ok: true }
    }

    @Post('forgot-password')
    async forgotPassword(
        @Body() body: AuthForgotPasswordBody,
        @Req() req: FastifyRequest
    ): Promise<AuthOkResponse> {
        this.limit('forgot', req, FORGOT_LIMIT)
        await this.requirePasswordEnabled()
        const email = normalizeEmail(body.email)
        if (email) {
            const userId = await this.auth.findUserIdByIdentity('email', email)
            if (userId)
                await this.emailVerification
                    .issue({ userId, email, purpose: 'password_reset' })
                    .catch(() => undefined)
        }
        return { ok: true }
    }

    @Post('reset-password')
    async resetPassword(
        @Body() body: AuthResetPasswordBody,
        @Req() req: FastifyRequest
    ): Promise<AuthSessionResponse> {
        this.limit('reset', req, RESET_LIMIT)
        await this.requirePasswordEnabled()
        const email = this.requireEmail(body.email)
        this.passwords.validatePolicy(body.password)
        const userId = await this.emailVerification.verify({
            email,
            code: body.code ?? '',
            purpose: 'password_reset'
        })
        if (!userId)
            throw new BadRequestException({
                code: 'auth.code_invalid',
                message: 'the reset code is invalid or expired'
            })
        await this.passwords.set(userId, body.password)
        await this.sessions.revokeAllForUser(userId)
        return this.sessionResponse(userId, email, req)
    }

    @Get('oauth/:provider/start')
    async oauthStart(
        @Param('provider') provider: string,
        @Query('redirect_url') redirectUrl: string | undefined,
        @Query('first_touch_token') firstTouchToken: string | undefined,
        @Query('last_touch_token') lastTouchToken: string | undefined,
        @Res() reply: FastifyReply
    ): Promise<void> {
        const { authorizeUrl } = await this.oauthFlow.start({
            provider: oauthProvider(provider),
            redirectAfter: redirectUrl ?? null,
            // Validated and resolved to link ids here at start: the touch
            // must survive the IdP round trip inside oauth_states, not in
            // the browser (the callback lands with only code+state).
            attributionTokens: { firstTouchToken, lastTouchToken }
        })
        // Pass 302 explicitly: NestJS pre-sets the GET default (200) on the
        // reply, and Fastify v5's redirect(url) keeps an already-set status, so
        // without this the browser gets a 200 + Location and never follows it.
        await reply.redirect(authorizeUrl, 302)
    }

    @Get('oauth/:provider/callback')
    async oauthCallback(
        @Param('provider') provider: string,
        @Query('code') code: string | undefined,
        @Query('state') state: string | undefined,
        @Query('error') error: string | undefined,
        @Req() req: FastifyRequest,
        @Res() reply: FastifyReply
    ): Promise<void> {
        const p = oauthProvider(provider)
        if (error || !code || !state) {
            await reply.redirect(this.errorRedirect(), 302)
            return
        }
        try {
            const result = await this.oauthFlow.callback({
                provider: p,
                code,
                state,
                userAgent: req.headers['user-agent'],
                ip: clientKey(req)
            })
            if (result.kind === 'link') {
                await reply.redirect(
                    this.linkRedirect(result.error, result.reauthToken),
                    302
                )
                return
            }
            await reply.redirect(
                this.successRedirect(result.token, result.redirectAfter),
                302
            )
        } catch {
            await reply.redirect(this.errorRedirect(), 302)
        }
    }

    private async sessionResponse(
        userId: string,
        subject: string,
        req: FastifyRequest,
        provider: SessionProvider = 'email'
    ): Promise<AuthSessionResponse> {
        const session = await this.sessions.mint({
            userId,
            provider,
            subject,
            userAgent: req.headers['user-agent'] ?? null,
            ip: clientKey(req)
        })
        const user = await this.auth.getUser(userId)
        if (!user)
            throw new NotFoundException({
                code: 'auth.account_not_found',
                message: 'account not found'
            })
        return { token: session.token, user: toSessionUser(user) }
    }

    private limit(action: string, req: FastifyRequest, limit: number): void {
        this.rateLimit.consume({
            key: `auth:${action}:${clientKey(req)}`,
            limit,
            windowMs: RATE_WINDOW_MS
        })
    }

    private requireEmail(value: string): string {
        const email = normalizeEmail(value)
        if (!email)
            throw new BadRequestException({
                code: 'auth.invalid_email',
                message: 'a valid email is required'
            })
        return email
    }

    private async requirePasswordEnabled(): Promise<void> {
        const settings = await this.authSettings.getPrivateSettings()
        if (!settings.passwordEnabled)
            throw new BadRequestException({
                code: 'auth.password_disabled',
                message: 'password login is disabled'
            })
    }

    // Link the verified email identity, then guard a register/verify race: if
    // another account already owns this email identity, do NOT mint a session for
    // the loser — surface email_in_use so the orphaned pending row is harmless.
    private async linkVerifiedEmail(
        userId: string,
        email: string
    ): Promise<void> {
        await this.auth.linkIdentities(
            userId,
            [{ provider: 'email', subject: email, email }],
            email
        )
        const owner = await this.auth.findUserIdByIdentity('email', email)
        if (owner !== userId)
            throw new ConflictException({
                code: 'auth.email_in_use',
                message: 'an account with that email already exists'
            })
    }

    private webUrl(): string {
        return trimTrailingSlash(
            configString(this.config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? 'https://manyfold.ai'
        )
    }

    private adminUrl(): string | null {
        return (
            configString(this.config, ['MF_ADMIN_URL', 'NCA_ADMIN_URL']) ?? null
        )
    }

    // The token lands in the fragment of `${base}/login`, so `base` MUST be one
    // of our own apps. When the flow was started from admin (absolute admin-origin
    // redirect_url) we return the user there; otherwise the web app.
    private successRedirect(
        token: string,
        redirectAfter: string | null
    ): string {
        const rd = this.safeServerRedirect(redirectAfter)
        let base = this.webUrl()
        let query = ''
        if (rd && /^https?:\/\//.test(rd)) {
            const url = new URL(rd)
            base = `${url.protocol}//${url.host}`
            const after = `${url.pathname}${url.search}`
            if (after && after !== '/')
                query = `?redirect_url=${encodeURIComponent(after)}`
        } else if (rd) {
            query = `?redirect_url=${encodeURIComponent(rd)}`
        }
        return `${base}/login${query}#session=${encodeURIComponent(token)}`
    }

    private errorRedirect(): string {
        return `${this.webUrl()}/login#error=oauth`
    }

    // Link-mode callbacks return to the Account page; the outcome travels in
    // the query string because a redirect can't carry a JSON body. A reauth
    // proof rides along when the consented identity was already linked —
    // the Account page trades it for a change-email start.
    private linkRedirect(
        error: string | null,
        reauthToken: string | null = null
    ): string {
        const base = `${this.webUrl()}/settings/account`
        if (error) return `${base}?link_error=${encodeURIComponent(error)}`
        return reauthToken
            ? `${base}?linked=google&reauth=${encodeURIComponent(reauthToken)}`
            : `${base}?linked=google`
    }

    // Allow only relative paths or absolute URLs on an explicitly-configured app
    // origin (web/admin) or a subdomain of the web host (agent dashboards).
    // Explicit-host matching avoids the registrable-suffix footgun (e.g. a
    // *.co.uk wildcard from naive apex derivation).
    private safeServerRedirect(value: string | null): string | null {
        if (!value) return null
        if (value.startsWith('/') && !value.startsWith('//')) return value
        try {
            const url = new URL(value)
            if (url.protocol !== 'http:' && url.protocol !== 'https:')
                return null
            return this.allowedRedirectHost(url.hostname)
                ? url.toString()
                : null
        } catch {
            return null
        }
    }

    private allowedRedirectHost(host: string): boolean {
        if (host === 'localhost' || host === '127.0.0.1') return true
        const webHost = hostOf(this.webUrl())
        if (webHost && (host === webHost || host.endsWith(`.${webHost}`)))
            return true
        const adminHost = hostOf(this.adminUrl())
        if (adminHost && (host === adminHost || host.endsWith(`.${adminHost}`)))
            return true
        return false
    }
}

const hostOf = (url: string | null): string | null => {
    if (!url) return null
    try {
        return new URL(url).hostname
    } catch {
        return null
    }
}

const toSessionUser = (user: User): AuthSessionUser => ({
    id: user.id,
    email: user.email,
    role: user.role
})

const bearerToken = (req: FastifyRequest): string => {
    const header = req.headers['authorization']
    return typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7)
        : ''
}

const oauthProvider = (value: string): OauthProvider => {
    if (value === 'google' || value === 'oidc') return value
    throw new NotFoundException(`unknown oauth provider: ${value}`)
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')
