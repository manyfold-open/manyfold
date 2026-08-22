import {
    Controller,
    Get,
    HttpCode,
    NotFoundException,
    Post,
    Query,
    Req,
    Res,
    UseGuards
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { CliAuthRateLimitService } from '@/modules/auth/cli-auth-rate-limit.service'
import { clientKey } from '@/modules/auth/cli-auth.controller'
import {
    UserExportService,
    type UserExportStatus
} from './user-export.service'

const RATE_WINDOW_MS = 10 * 60_000
const REQUEST_LIMIT = 5
const DOWNLOAD_LIMIT = 30

// Self-serve takeout (ADR-0023 §9.2). Like the other account security
// endpoints (deletion, email, password), requesting an export demands a human
// session — an API token must not be able to exfiltrate its owner's full
// account bundle. Post-deletion-T0 users cannot reach these endpoints at all
// (sessions are revoked); the admin controller is their support fallback.
@Controller('me/export')
export class MeExportController {
    constructor(
        private readonly exports: UserExportService,
        private readonly rateLimit: CliAuthRateLimitService
    ) {}

    @Get()
    @UseGuards(AuthGuard)
    async status(
        @CurrentUser() user: AuthPrincipal
    ): Promise<UserExportStatus | null> {
        return this.exports.status(user.userId)
    }

    @Post()
    @HttpCode(201)
    @UseGuards(AuthGuard)
    @RequireAuthSession()
    async request(
        @CurrentUser() user: AuthPrincipal
    ): Promise<UserExportStatus> {
        this.rateLimit.consume({
            key: `export:self:request:${user.userId}`,
            limit: REQUEST_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        const status = await this.exports.request({
            userId: user.userId,
            requestedBy: user.userId
        })
        // Fire-and-forget: the sweep does the slow collect/zip/upload work;
        // the interval tick (and stale-claim recovery) backstops a crash.
        void this.exports.sweep()
        return status
    }

    // Deliberately unauthenticated (the me-deletion/restore house pattern):
    // the emailed link must work for grace-period users whose sessions are
    // gone. The signed token is the whole credential; IP-keyed limiting
    // keeps token guessing loud.
    @Get('download')
    async download(
        @Query('token') token: string | undefined,
        @Req() req: FastifyRequest,
        @Res() reply: FastifyReply
    ): Promise<void> {
        this.rateLimit.consume({
            key: `export:download:${clientKey(req)}`,
            limit: DOWNLOAD_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        if (!token) throw new NotFoundException('export not found')
        const { stream, filename } = await this.exports.download(token)
        await reply
            .header('content-type', 'application/zip')
            .header(
                'content-disposition',
                `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`
            )
            .header('cache-control', 'no-store')
            .send(Readable.from(stream))
    }
}
