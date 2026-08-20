import type {
    AuthIdentitySummary,
    ChangeAccountEmailStartBody,
    ChangeAccountEmailStartResponse,
    ChangeAccountEmailVerifyBody
} from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Post,
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
import { CliAuthRateLimitService } from './cli-auth-rate-limit.service'
import { clientKey } from './cli-auth.controller'
import { EmailVerificationService } from './email-verification.service'
import { normalizeEmail } from './linked-identities'
import { PasswordService } from './password.service'

const RATE_WINDOW_MS = 10 * 60_000
const START_LIMIT = 5
const VERIFY_LIMIT = 15

// Changing the sign-in email is an atomic swap (identity + primary email);
// the address is never left unbound. start proves the caller is the account
// OWNER (not merely a live session) and mails a code to the new address;
// verify proves ownership of that address and commits the swap.
@Controller('me/email')
@UseGuards(AuthGuard)
export class AccountEmailController {
    constructor(
        private readonly auth: AuthService,
        private readonly passwords: PasswordService,
        private readonly emailVerification: EmailVerificationService,
        private readonly email: EmailService,
        private readonly rateLimit: CliAuthRateLimitService
    ) {}

    @Post('change/start')
    @RequireAuthSession()
    async start(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: ChangeAccountEmailStartBody,
        @Req() req: FastifyRequest
    ): Promise<ChangeAccountEmailStartResponse> {
        this.limit('start', user.userId, req, START_LIMIT)
        const newEmail = normalizeEmail(body.newEmail)
        if (!newEmail)
            throw new BadRequestException({
                code: 'auth.invalid_email',
                message: 'a valid email is required'
            })
        const identities = await this.auth.listIdentities(user.userId)
        const current = identities.find((i) => i.provider === 'email')
        if (current?.subject === newEmail)
            throw new BadRequestException({
                code: 'auth.email_unchanged',
                message: 'that is already your sign-in email'
            })
        const owner = await this.auth.findUserIdByIdentity('email', newEmail)
        if (owner && owner !== user.userId)
            throw new ConflictException({
                code: 'auth.email_in_use',
                message: 'an account with that email already exists'
            })

        await this.requireReauth(user, body)
        await this.emailVerification.issue({
            userId: user.userId,
            email: newEmail,
            purpose: 'email_change'
        })
        return { ok: true }
    }

    @Post('change/verify')
    @RequireAuthSession()
    async verify(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: ChangeAccountEmailVerifyBody,
        @Req() req: FastifyRequest
    ): Promise<AuthIdentitySummary[]> {
        this.limit('verify', user.userId, req, VERIFY_LIMIT)
        const newEmail = normalizeEmail(body.newEmail)
        if (!newEmail)
            throw new BadRequestException({
                code: 'auth.invalid_email',
                message: 'a valid email is required'
            })
        const hasPassword = await this.passwords.has(user.userId)
        // Enforced BEFORE consuming the code so a missing password doesn't
        // burn a valid code. The swap must not leave a password-less account:
        // after it, the (OAuth-derived) email identity no longer matches any
        // OAuth address, so the password is what keeps email sign-in usable.
        if (!hasPassword) {
            if (!body.newPassword)
                throw new BadRequestException({
                    code: 'auth.password_required',
                    message: 'set a password to complete the email change'
                })
            this.passwords.validatePolicy(body.newPassword)
        }
        // Hash before consuming the code (CPU-bound, no DB state touched) so
        // the swap and the password write commit together in one transaction.
        const passwordHash =
            !hasPassword && body.newPassword
                ? await this.passwords.hash(body.newPassword)
                : undefined
        const codeUserId = await this.emailVerification.verify({
            email: newEmail,
            code: body.code ?? '',
            purpose: 'email_change'
        })
        if (!codeUserId || codeUserId !== user.userId)
            throw new BadRequestException({
                code: 'auth.code_invalid',
                message: 'the verification code is invalid or expired'
            })
        const { oldEmail } = await this.auth.changeEmail(
            user.userId,
            newEmail,
            {
                passwordHash
            }
        )
        if (oldEmail && normalizeEmail(oldEmail) !== newEmail)
            await this.notifyOldAddress(oldEmail, newEmail)
        return this.auth.listIdentities(user.userId)
    }

    // Owner proof, not just session proof: a stolen browser session must not
    // be able to rotate the account to an attacker address. Accepted proofs:
    // a single-use OAuth reauth token, or the current password — but only
    // when that password predates the session, since a hijacker can set a
    // fresh password on a password-less account and replay it here.
    private async requireReauth(
        user: AuthPrincipal,
        body: ChangeAccountEmailStartBody
    ): Promise<void> {
        if (body.reauthToken) {
            const ok = await this.emailVerification.validateReauthProof(
                user.userId,
                body.reauthToken
            )
            if (!ok)
                throw new UnauthorizedException({
                    code: 'auth.reauth_invalid',
                    message: 're-authentication expired; try again'
                })
            return
        }
        const passwordChangedAt = await this.passwords.lastChangedAt(
            user.userId
        )
        const sessionCreatedAt =
            user.kind === 'human-session' ? user.sessionCreatedAt : undefined
        if (
            passwordChangedAt &&
            sessionCreatedAt &&
            passwordChangedAt <= sessionCreatedAt
        ) {
            const ok = await this.passwords.verify(
                user.userId,
                body.currentPassword ?? ''
            )
            if (!ok)
                throw new BadRequestException({
                    code: 'auth.invalid_current_password',
                    message: 'the current password is incorrect'
                })
            return
        }
        throw new UnauthorizedException({
            code: 'auth.reauth_required',
            message:
                'confirm it is you first: re-authenticate with a linked sign-in method'
        })
    }

    private async notifyOldAddress(
        oldEmail: string,
        newEmail: string
    ): Promise<void> {
        try {
            await this.email.send({
                to: oldEmail,
                subject: 'Your Manyfold sign-in email was changed',
                tag: 'auth.email_change_notice',
                ...renderEmail({
                    preheader: `Your sign-in email is now ${newEmail}.`,
                    greeting: 'Hi,',
                    blocks: [
                        {
                            kind: 'paragraph',
                            text: `The sign-in email for your Manyfold account was changed from ${oldEmail} to ${newEmail}.`
                        },
                        {
                            kind: 'paragraph',
                            text: 'If you made this change, no action is needed.'
                        },
                        {
                            kind: 'callout',
                            label: 'If this was not you',
                            text: `Contact ${SUPPORT_EMAIL} immediately — this address can no longer be used to sign in or recover the account.`
                        }
                    ]
                })
            })
        } catch {
            // Best effort: the swap already committed; a mail failure must
            // not surface as a failed change.
        }
    }

    private limit(
        action: string,
        userId: string,
        req: FastifyRequest,
        limit: number
    ): void {
        this.rateLimit.consume({
            key: `auth:email-change:${action}:${userId}`,
            limit,
            windowMs: RATE_WINDOW_MS
        })
        this.rateLimit.consume({
            key: `auth:email-change:${action}:${clientKey(req)}`,
            limit,
            windowMs: RATE_WINDOW_MS
        })
    }
}
