import type {
    AuthIdentitySummary,
    SetAccountPasswordBody,
    SetAccountPasswordStartResponse
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Post,
    Put,
    Req,
    UnauthorizedException,
    UseGuards
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { EmailService } from '@/modules/email/email.service'
import { SUPPORT_EMAIL } from '@/modules/email/templates/email-content'
import { renderEmail } from '@/modules/email/templates/render-email'
import { AuthService } from './auth.service'
import { AuthSettingsService } from './auth-settings.service'
import { CliAuthRateLimitService } from './cli-auth-rate-limit.service'
import { clientKey } from './cli-auth.controller'
import { EmailVerificationService } from './email-verification.service'
import { normalizeEmail } from './linked-identities'
import { PasswordService } from './password.service'
import { SessionService } from './session.service'

const RATE_WINDOW_MS = 10 * 60_000
const START_LIMIT = 5

@Controller('me')
@UseGuards(AuthGuard)
export class AccountPasswordController {
    constructor(
        private readonly auth: AuthService,
        private readonly authSettings: AuthSettingsService,
        private readonly passwords: PasswordService,
        private readonly sessions: SessionService,
        private readonly emailVerification: EmailVerificationService,
        private readonly email: EmailService,
        private readonly rateLimit: CliAuthRateLimitService
    ) {}

    // Step 1 of the first-password setup: mail a code to the account's OWN
    // sign-in address (server-resolved, never caller-supplied). The code is
    // the owner proof the PUT below requires — a session alone must not mint
    // a credential, or a hijacked session could set a password, re-login and
    // pass the change-email re-auth check with it.
    @Post('password/setup/start')
    @RequireAuthSession()
    async setupStart(
        @CurrentUser() user: AuthPrincipal,
        @Req() req: FastifyRequest
    ): Promise<SetAccountPasswordStartResponse> {
        this.limit(user.userId, req)
        await this.requirePasswordEnabled()
        if (await this.passwords.has(user.userId))
            throw new BadRequestException({
                code: 'auth.password_exists',
                message: 'the account already has a password'
            })
        const email = await this.accountEmail(user.userId)
        await this.emailVerification.issue({
            userId: user.userId,
            email,
            purpose: 'password_setup'
        })
        return { ok: true }
    }

    // Set (or change) the password for the account's primary email. Owner
    // proof by state: a password holder presents the current password; a
    // first-time set presents the setup code mailed to the account's inbox.
    // Session-required on purpose — an API token must never be able to change
    // how the account signs in.
    @Put('password')
    @RequireAuthSession()
    async setPassword(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: SetAccountPasswordBody
    ): Promise<AuthIdentitySummary[]> {
        await this.requirePasswordEnabled()
        this.passwords.validatePolicy(body.password)
        const email = await this.accountEmail(user.userId)
        const hadPassword = await this.passwords.has(user.userId)
        if (hadPassword) {
            const ok = await this.passwords.verify(
                user.userId,
                body.currentPassword ?? ''
            )
            if (!ok)
                throw new BadRequestException({
                    code: 'auth.invalid_current_password',
                    message: 'the current password is incorrect'
                })
        } else {
            // Verified against the same server-resolved address setupStart
            // mailed, and bound to this user — a code minted for another
            // account that shares the address must not count.
            const codeUserId = await this.emailVerification.verify({
                email,
                code: body.code ?? '',
                purpose: 'password_setup'
            })
            if (!codeUserId || codeUserId !== user.userId)
                throw new UnauthorizedException({
                    code: 'auth.code_invalid',
                    message: 'the verification code is invalid or expired'
                })
        }
        // Link the email identity before storing the password so an
        // email-in-use conflict leaves the account unchanged.
        await this.auth.linkIdentities(
            user.userId,
            [{ provider: 'email', subject: email, email }],
            email
        )
        const owner = await this.auth.findUserIdByIdentity('email', email)
        if (owner !== user.userId)
            throw new ConflictException({
                code: 'auth.email_in_use',
                message: 'an account with that email already exists'
            })
        await this.passwords.set(user.userId, body.password)
        // Parity with reset-password: a new credential evicts every other
        // session, so a stolen session dies the moment the owner sets or
        // changes the password. Only the caller's own session survives.
        await this.sessions.revokeAllForUser(user.userId, {
            exceptSessionId:
                user.kind === 'human-session' ? user.sessionId : undefined
        })
        await this.notifyPasswordSet(email, !hadPassword)
        return this.auth.listIdentities(user.userId)
    }

    // The email identity subject is the sign-in email (kept in step with
    // users.email by the change-email swap); users.email alone can lag on
    // legacy accounts from the drift era.
    private async accountEmail(userId: string): Promise<string> {
        const identities = await this.auth.listIdentities(userId)
        const account = await this.auth.getUser(userId)
        const email =
            normalizeEmail(
                identities.find((i) => i.provider === 'email')?.subject
            ) || normalizeEmail(account?.email)
        if (!email)
            throw new BadRequestException({
                code: 'auth.email_missing',
                message: 'the account has no primary email'
            })
        return email
    }

    private async requirePasswordEnabled(): Promise<void> {
        const settings = await this.authSettings.getPrivateSettings()
        if (!settings.passwordEnabled)
            throw new BadRequestException({
                code: 'auth.password_disabled',
                message: 'password sign-in is disabled'
            })
    }

    private limit(userId: string, req: FastifyRequest): void {
        this.rateLimit.consume({
            key: `auth:password-setup:start:${userId}`,
            limit: START_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        this.rateLimit.consume({
            key: `auth:password-setup:start:${clientKey(req)}`,
            limit: START_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
    }

    private async notifyPasswordSet(
        to: string,
        isFirstPassword: boolean
    ): Promise<void> {
        const action = isFirstPassword ? 'set' : 'changed'
        try {
            await this.email.send({
                to,
                subject: `Your Manyfold password was ${action}`,
                tag: 'auth.password_set_notice',
                ...renderEmail({
                    preheader: `A password was just ${action} for your account.`,
                    greeting: 'Hi,',
                    blocks: [
                        {
                            kind: 'paragraph',
                            text: `A password was just ${action} for your Manyfold account (${to}).`
                        },
                        {
                            kind: 'paragraph',
                            text: 'If this was you, no action is needed.'
                        },
                        {
                            kind: 'callout',
                            label: 'If this was not you',
                            text: 'Your account may be compromised. Reset your password immediately and review your sign-in methods.'
                        }
                    ],
                    footerNote: `Questions? Email ${SUPPORT_EMAIL}.`
                })
            })
        } catch {
            // Best effort: the password is already stored; a mail failure must
            // not surface as a failed request.
        }
    }
}
