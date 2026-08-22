import type {
    ConfirmMeDeletionBody,
    RestoreMeDeletionBody
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Get,
    HttpCode,
    Post,
    Req,
    UseGuards
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { CliAuthRateLimitService } from '@/modules/auth/cli-auth-rate-limit.service'
import { clientKey } from '@/modules/auth/cli-auth.controller'
import {
    UserDeletionService,
    type MeDeletionAwaiting,
    type UserDeletionStatus
} from './user-deletion.service'

const RATE_WINDOW_MS = 10 * 60_000
const REQUEST_LIMIT = 5
const CONFIRM_LIMIT = 15

// Self-serve account deletion (ADR-0023 §9.1): request records intent and
// emails a signed confirmation link; confirm promotes to v1's T0; restore is
// the session-less magic link from the T0 email. Like the other account
// security endpoints (email/password), the mutating session routes demand a
// human session — an API token must not be able to schedule its owner's
// deletion.
@Controller('me/deletion')
export class MeDeletionController {
    constructor(
        private readonly deletions: UserDeletionService,
        private readonly rateLimit: CliAuthRateLimitService
    ) {}

    @Get()
    @UseGuards(AuthGuard)
    async status(
        @CurrentUser() user: AuthPrincipal
    ): Promise<MeDeletionAwaiting | null> {
        return this.deletions.meStatus(user.userId)
    }

    @Post()
    @HttpCode(201)
    @UseGuards(AuthGuard)
    @RequireAuthSession()
    async request(
        @CurrentUser() user: AuthPrincipal
    ): Promise<MeDeletionAwaiting> {
        this.rateLimit.consume({
            key: `deletion:self:request:${user.userId}`,
            limit: REQUEST_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return this.deletions.selfRequest(user.userId)
    }

    @Post('confirm')
    @UseGuards(AuthGuard)
    @RequireAuthSession()
    async confirm(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: ConfirmMeDeletionBody
    ): Promise<UserDeletionStatus> {
        this.rateLimit.consume({
            key: `deletion:self:confirm:${user.userId}`,
            limit: CONFIRM_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return this.deletions.selfConfirm(user.userId, body?.token ?? '')
    }

    // Deliberately unauthenticated: post-T0 the user cannot sign in, so the
    // signed single-use token is the whole credential. IP-keyed limiting
    // (the anonymous-endpoint house pattern) keeps token guessing loud.
    @Post('restore')
    async restore(
        @Body() body: RestoreMeDeletionBody,
        @Req() req: FastifyRequest
    ): Promise<UserDeletionStatus> {
        this.rateLimit.consume({
            key: `deletion:self:restore:${clientKey(req)}`,
            limit: CONFIRM_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return this.deletions.restoreByToken(body?.token ?? '')
    }
}
