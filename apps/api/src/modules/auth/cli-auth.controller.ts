import type {
    CliLoginApproveBody,
    CliLoginApproveResponse,
    CliLoginExchangeBody,
    CliLoginExchangeResponse,
    CliLoginSessionResponse,
    CliLoginStartBody,
    CliLoginStartResponse
} from '@manyfold/shared'
import {
    Body,
    Controller,
    GoneException,
    Get,
    Param,
    Post,
    Req,
    UseGuards
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { CliAuthRateLimitService } from './cli-auth-rate-limit.service'
import { CliAuthService } from './cli-auth.service'

const RATE_WINDOW_MS = 60_000
const START_LIMIT = 30
const EXCHANGE_LIMIT = 60
const SESSION_LIMIT = 120

@Controller('auth/cli')
export class CliAuthController {
    constructor(
        private readonly cliAuth: CliAuthService,
        private readonly rateLimit: CliAuthRateLimitService
    ) {}

    @Post('start')
    async start(
        @Body() body: CliLoginStartBody,
        @Req() req: FastifyRequest
    ): Promise<CliLoginStartResponse> {
        this.rateLimit.consume({
            key: `cli-auth:start:${clientKey(req)}`,
            limit: START_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        if ('requestedScopes' in body || 'requestedAgentId' in body)
            throw new GoneException(
                'agent bearer grants are retired; run mf auth ensure --scopes <list>'
            )
        return this.cliAuth.start({
            redirectUri: body.redirectUri
        })
    }

    @Post('approve')
    @UseGuards(AuthGuard)
    async approve(
        @CurrentUser() user: AuthPrincipal,
        @Body() body: CliLoginApproveBody
    ): Promise<CliLoginApproveResponse> {
        return this.cliAuth.approve({
            requestId: body.requestId,
            userCode: body.userCode,
            userId: user.userId
        })
    }

    @Post('exchange')
    async exchange(
        @Body() body: CliLoginExchangeBody,
        @Req() req: FastifyRequest
    ): Promise<CliLoginExchangeResponse> {
        this.rateLimit.consume({
            key: `cli-auth:exchange:${clientKey(req)}`,
            limit: EXCHANGE_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return this.cliAuth.exchange(body.authCode)
    }

    @Get('session/:requestId/:userCode')
    async session(
        @Param('requestId') requestId: string,
        @Param('userCode') userCode: string,
        @Req() req: FastifyRequest
    ): Promise<CliLoginSessionResponse> {
        this.rateLimit.consume({
            key: `cli-auth:session:${clientKey(req)}`,
            limit: SESSION_LIMIT,
            windowMs: RATE_WINDOW_MS
        })
        return this.cliAuth.getSession({ requestId, userCode })
    }
}

export const clientKey = (req: FastifyRequest): string => {
    const forwarded = req.headers['x-forwarded-for']
    const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded
    return firstForwarded?.split(',')[0]?.trim() || req.ip || 'unknown'
}
