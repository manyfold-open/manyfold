import type {
    ConnectA2aApproveBody,
    ConnectA2aApproveResponse,
    ConnectA2aDenyBody,
    ConnectA2aDenyResponse,
    ConnectA2aPollBody,
    ConnectA2aPollResponse,
    ConnectA2aSessionResponse,
    ConnectA2aStartBody,
    ConnectA2aStartResponse
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Get,
    HttpCode,
    Param,
    Post,
    Req,
    UseGuards
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { FastifyRequest } from 'fastify'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireAuthSession } from '@/common/decorators/require-auth-session.decorator'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { CliAuthRateLimitService } from '../auth/cli-auth-rate-limit.service'
import { clientKey } from '../auth/cli-auth.controller'
import { ConnectA2aService } from './connect-a2a.service'

const RATE_WINDOW_MS = 60_000
const START_LIMIT = 30
const POLL_LIMIT = 120
const SESSION_LIMIT = 120

@Controller('connect/a2a')
export class ConnectA2aController {
    constructor(
        private readonly connect: ConnectA2aService,
        private readonly rateLimit: CliAuthRateLimitService,
        private readonly config: ConfigService
    ) {}

    @Post('start')
    async start(
        @Body() body: ConnectA2aStartBody,
        @Req() req: FastifyRequest
    ): Promise<ConnectA2aStartResponse> {
        this.rateLimit.consume({
            key: `connect-a2a:start:${clientKey(req)}`,
            limit: START_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return this.connect.start({
            clientName: body.clientName,
            clientUrl: body.clientUrl
        })
    }

    @Get('session/:requestId/:userCode')
    async session(
        @Param('requestId') requestId: string,
        @Param('userCode') userCode: string,
        @Req() req: FastifyRequest
    ): Promise<ConnectA2aSessionResponse> {
        this.rateLimit.consume({
            key: `connect-a2a:session:${clientKey(req)}`,
            limit: SESSION_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return this.connect.getSession({ requestId, userCode })
    }

    // Session-only like A2aGrantsController: authorizing an external client
    // must happen in a browser session, never via an API token.
    @Post('approve')
    @HttpCode(200)
    @UseGuards(AuthGuard)
    @RequireAuthSession()
    async approve(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: ConnectA2aApproveBody
    ): Promise<ConnectA2aApproveResponse> {
        return this.connect.approve({
            requestId: body.requestId,
            userCode: body.userCode,
            agentIds: body.agentIds,
            enableExposure: body.enableExposure ?? false,
            expiresInDays: body.expiresInDays,
            userId: user.userId
        })
    }

    @Post('poll')
    @HttpCode(200)
    async poll(
        @Body() body: ConnectA2aPollBody,
        @Req() req: FastifyRequest
    ): Promise<ConnectA2aPollResponse> {
        this.rateLimit.consume({
            key: `connect-a2a:poll:${clientKey(req)}`,
            limit: POLL_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return this.connect.poll(
            { deviceCode: body.deviceCode },
            this.apiOrigin(req)
        )
    }

    @Post('deny')
    @HttpCode(200)
    @UseGuards(AuthGuard)
    @RequireAuthSession()
    async deny(
        @Body() body: ConnectA2aDenyBody
    ): Promise<ConnectA2aDenyResponse> {
        return this.connect.deny({
            requestId: body.requestId,
            userCode: body.userCode
        })
    }

    private apiOrigin(req: FastifyRequest): string {
        const configured = this.config.get<string>('PUBLIC_API_BASE_URL')
        if (configured && configured.length > 0)
            return publicApiUrlWithApiPrefix(configured)
        const proto =
            (req.headers['x-forwarded-proto'] as string | undefined) || 'https'
        const host = req.headers.host ?? 'localhost'
        return `${proto}://${host}/api`
    }
}
