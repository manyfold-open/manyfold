import type {
    ChannelDeliverySummary,
    ChannelDetail,
    ChannelScopeSummary,
    ChannelSessionSummary,
    ChannelSummary,
    ChannelTestResult,
    CreateChannelSessionBody,
    GithubAppManifestResponse,
    LarkAppRegistrationSummary,
    UpdateChannelSessionBody,
    WeixinRegistrationSummary,
    WhatsappRegistrationSummary
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseGuards
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import {
    AllowBoundTokenWithoutSubject,
    ListFilteredByBoundAgent,
    SubjectAgentFromBody,
    SubjectAgentFromResource
} from '@/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '@/modules/agents/agents.controller'
import { CliAuthRateLimitService } from '@/modules/auth/cli-auth-rate-limit.service'
import { clientKey } from '@/modules/auth/cli-auth.controller'
import { ChannelsService } from './channels.service'
import { ChannelManagerService } from './channel-manager.service'
import { LarkRegistrationService } from './lark-registration.service'
import { WeixinRegistrationService } from './weixin-registration.service'
import { WhatsappRegistrationService } from './whatsapp-registration.service'
import {
    CreateChannelDto,
    StartLarkRegistrationDto,
    StartWeixinRegistrationDto,
    StartWhatsappRegistrationDto,
    SubmitWeixinVerifyCodeDto,
    UpdateChannelDto
} from './dto/channels.dto'

const RATE_WINDOW_MS = 60_000

@Controller('channels')
@UseGuards(AuthGuard)
export class ChannelsController {
    constructor(
        private readonly channels: ChannelsService,
        private readonly manager: ChannelManagerService,
        private readonly larkRegistrations: LarkRegistrationService,
        private readonly weixinRegistrations: WeixinRegistrationService,
        private readonly whatsappRegistrations: WhatsappRegistrationService,
        private readonly rateLimit: CliAuthRateLimitService
    ) {}

    @Get()
    @RequireApiTokenScope('channels:read')
    @ListFilteredByBoundAgent()
    list(@CurrentUser() user: AuthPrincipal): Promise<ChannelSummary[]> {
        this.assertEnabled()
        return this.channels.list(user.userId, {
            boundAgentId: boundAgentIdFromUser(user)
        })
    }

    @Post()
    @HttpCode(201)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromBody('agentId')
    create(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: CreateChannelDto
    ): Promise<ChannelDetail> {
        this.assertEnabled()
        return this.channels.create(user.userId, dto)
    }

    @Post('lark-registrations')
    @HttpCode(201)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromBody('agentId')
    startLarkRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: StartLarkRegistrationDto,
        @Req() req: FastifyRequest
    ): Promise<LarkAppRegistrationSummary> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `lark-registration:start:user:${user.userId}`,
            limit: 10,
            windowMs: RATE_WINDOW_MS
        })
        this.rateLimit.consume({
            key: `lark-registration:start:ip:${clientKey(req)}`,
            limit: 30,
            windowMs: RATE_WINDOW_MS
        })
        return this.larkRegistrations.start(user.userId, dto)
    }

    @Get('lark-registrations/:id')
    @RequireApiTokenScope('channels:read')
    @AllowBoundTokenWithoutSubject(
        'registration service enforces the stored subject agent'
    )
    getLarkRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Req() req: FastifyRequest
    ): Promise<LarkAppRegistrationSummary> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `lark-registration:get:ip:${clientKey(req)}`,
            limit: 120,
            windowMs: RATE_WINDOW_MS
        })
        return this.larkRegistrations.getAndAdvance(
            {
                userId: user.userId,
                boundAgentId: boundAgentIdFromUser(user)
            },
            id
        )
    }

    @Delete('lark-registrations/:id')
    @HttpCode(204)
    @RequireApiTokenScope('channels:edit')
    @AllowBoundTokenWithoutSubject(
        'registration service enforces the stored subject agent'
    )
    async cancelLarkRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Req() req: FastifyRequest
    ): Promise<void> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `lark-registration:cancel:ip:${clientKey(req)}`,
            limit: 30,
            windowMs: RATE_WINDOW_MS
        })
        await this.larkRegistrations.cancel(
            {
                userId: user.userId,
                boundAgentId: boundAgentIdFromUser(user)
            },
            id
        )
    }

    @Post('weixin-registrations')
    @HttpCode(201)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromBody('agentId')
    startWeixinRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: StartWeixinRegistrationDto,
        @Req() req: FastifyRequest
    ): Promise<WeixinRegistrationSummary> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `weixin-registration:start:user:${user.userId}`,
            limit: 10,
            windowMs: RATE_WINDOW_MS
        })
        this.rateLimit.consume({
            key: `weixin-registration:start:ip:${clientKey(req)}`,
            limit: 30,
            windowMs: RATE_WINDOW_MS
        })
        return this.weixinRegistrations.start(user.userId, dto)
    }

    @Get('weixin-registrations/:id')
    @RequireApiTokenScope('channels:read')
    @AllowBoundTokenWithoutSubject(
        'registration service enforces the stored subject agent'
    )
    getWeixinRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Req() req: FastifyRequest
    ): Promise<WeixinRegistrationSummary> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `weixin-registration:get:ip:${clientKey(req)}`,
            limit: 120,
            windowMs: RATE_WINDOW_MS
        })
        return this.weixinRegistrations.getAndAdvance(
            {
                userId: user.userId,
                boundAgentId: boundAgentIdFromUser(user)
            },
            id
        )
    }

    @Post('weixin-registrations/:id/verify-code')
    @RequireApiTokenScope('channels:edit')
    @AllowBoundTokenWithoutSubject(
        'registration service enforces the stored subject agent'
    )
    submitWeixinVerifyCode(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: SubmitWeixinVerifyCodeDto,
        @Req() req: FastifyRequest
    ): Promise<WeixinRegistrationSummary> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `weixin-registration:verify:ip:${clientKey(req)}`,
            limit: 30,
            windowMs: RATE_WINDOW_MS
        })
        return this.weixinRegistrations.submitVerifyCode(
            {
                userId: user.userId,
                boundAgentId: boundAgentIdFromUser(user)
            },
            id,
            dto.verifyCode
        )
    }

    @Delete('weixin-registrations/:id')
    @HttpCode(204)
    @RequireApiTokenScope('channels:edit')
    @AllowBoundTokenWithoutSubject(
        'registration service enforces the stored subject agent'
    )
    async cancelWeixinRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Req() req: FastifyRequest
    ): Promise<void> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `weixin-registration:cancel:ip:${clientKey(req)}`,
            limit: 30,
            windowMs: RATE_WINDOW_MS
        })
        await this.weixinRegistrations.cancel(
            {
                userId: user.userId,
                boundAgentId: boundAgentIdFromUser(user)
            },
            id
        )
    }

    @Post('whatsapp-registrations')
    @HttpCode(201)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromBody('agentId')
    startWhatsappRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Body() dto: StartWhatsappRegistrationDto,
        @Req() req: FastifyRequest
    ): Promise<WhatsappRegistrationSummary> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `whatsapp-registration:start:user:${user.userId}`,
            limit: 10,
            windowMs: RATE_WINDOW_MS
        })
        this.rateLimit.consume({
            key: `whatsapp-registration:start:ip:${clientKey(req)}`,
            limit: 30,
            windowMs: RATE_WINDOW_MS
        })
        return this.whatsappRegistrations.start(user.userId, dto)
    }

    @Get('whatsapp-registrations/:id')
    @RequireApiTokenScope('channels:read')
    @AllowBoundTokenWithoutSubject(
        'registration service enforces the stored subject agent'
    )
    getWhatsappRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Req() req: FastifyRequest
    ): Promise<WhatsappRegistrationSummary> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `whatsapp-registration:get:ip:${clientKey(req)}`,
            limit: 120,
            windowMs: RATE_WINDOW_MS
        })
        return this.whatsappRegistrations.get(
            {
                userId: user.userId,
                boundAgentId: boundAgentIdFromUser(user)
            },
            id
        )
    }

    @Delete('whatsapp-registrations/:id')
    @HttpCode(204)
    @RequireApiTokenScope('channels:edit')
    @AllowBoundTokenWithoutSubject(
        'registration service enforces the stored subject agent'
    )
    async cancelWhatsappRegistration(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Req() req: FastifyRequest
    ): Promise<void> {
        this.assertEnabled()
        this.rateLimit.consume({
            key: `whatsapp-registration:cancel:ip:${clientKey(req)}`,
            limit: 30,
            windowMs: RATE_WINDOW_MS
        })
        await this.whatsappRegistrations.cancel(
            {
                userId: user.userId,
                boundAgentId: boundAgentIdFromUser(user)
            },
            id
        )
    }

    @Get(':id')
    @RequireApiTokenScope('channels:read')
    @SubjectAgentFromResource('channel', 'id')
    get(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ChannelDetail> {
        this.assertEnabled()
        return this.channels.get(user.userId, id)
    }

    @Patch(':id')
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromResource('channel', 'id')
    update(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() dto: UpdateChannelDto
    ): Promise<ChannelDetail> {
        this.assertEnabled()
        // The resource guard only proves the token may touch the channel's
        // CURRENT agent; moving the channel to a different agent exceeds a
        // bound token's authority.
        const boundAgentId = boundAgentIdFromUser(user)
        if (dto.agentId && boundAgentId && dto.agentId !== boundAgentId)
            throw new ForbiddenException(
                'agent-bound tokens cannot rebind a channel to another agent'
            )
        return this.channels.update(user.userId, id, dto)
    }

    @Delete(':id')
    @HttpCode(204)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromResource('channel', 'id')
    async delete(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<void> {
        this.assertEnabled()
        await this.channels.delete(user.userId, id)
    }

    @Post(':id/test')
    @HttpCode(200)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromResource('channel', 'id')
    test(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ChannelTestResult> {
        this.assertEnabled()
        return this.channels.test(user.userId, id)
    }

    @Post(':id/register')
    @HttpCode(200)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromResource('channel', 'id')
    register(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ChannelTestResult> {
        this.assertEnabled()
        return this.channels.register(user.userId, id)
    }

    @Get(':id/deliveries')
    @RequireApiTokenScope('channels:read')
    @SubjectAgentFromResource('channel', 'id')
    deliveries(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('limit') limit?: string
    ): Promise<ChannelDeliverySummary[]> {
        this.assertEnabled()
        const parsed = limit ? Number(limit) : 50
        return this.channels.listDeliveries(
            user.userId,
            id,
            Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50
        )
    }

    @Get(':id/slack-manifest')
    @RequireApiTokenScope('channels:read')
    @SubjectAgentFromResource('channel', 'id')
    slackManifest(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<Record<string, unknown>> {
        this.assertEnabled()
        return this.channels.slackManifest(user.userId, id)
    }

    @Get(':id/github-app-manifest')
    @RequireApiTokenScope('channels:read')
    @SubjectAgentFromResource('channel', 'id')
    githubAppManifest(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('org') org?: string
    ): Promise<GithubAppManifestResponse> {
        this.assertEnabled()
        return this.channels.githubAppManifest(user.userId, id, org)
    }

    @Get(':id/scopes')
    @RequireApiTokenScope('channels:read')
    @SubjectAgentFromResource('channel', 'id')
    listScopes(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string
    ): Promise<ChannelScopeSummary[]> {
        this.assertEnabled()
        return this.channels.listScopes(user.userId, id)
    }

    @Get(':id/sessions')
    @RequireApiTokenScope('channels:read')
    @SubjectAgentFromResource('channel', 'id')
    listSessions(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Query('scopeKey') scopeKey?: string,
        @Query('includeArchived') includeArchived?: string
    ): Promise<ChannelSessionSummary[]> {
        this.assertEnabled()
        return this.channels.listChannelSessions(user.userId, id, {
            scopeKey: scopeKey?.trim() ? scopeKey : undefined,
            includeArchived: includeArchived === 'true'
        })
    }

    @Post(':id/sessions')
    @HttpCode(201)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromResource('channel', 'id')
    createSession(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Body() body: CreateChannelSessionBody & { scopeKey: string }
    ): Promise<ChannelSessionSummary> {
        this.assertEnabled()
        if (!body || typeof body.scopeKey !== 'string')
            throw new NotFoundException('scopeKey is required')
        return this.channels.createChannelSession(
            user.userId,
            id,
            body.scopeKey,
            body.displayName ?? null
        )
    }

    @Patch(':id/sessions/:sessionId')
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromResource('channel', 'id')
    updateSession(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('sessionId') sessionId: string,
        @Body() body: UpdateChannelSessionBody
    ): Promise<ChannelSessionSummary> {
        this.assertEnabled()
        return this.channels.updateChannelSession(
            user.userId,
            id,
            sessionId,
            body
        )
    }

    @Delete(':id/sessions/:sessionId')
    @HttpCode(200)
    @RequireApiTokenScope('channels:edit')
    @SubjectAgentFromResource('channel', 'id')
    deleteSession(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') id: string,
        @Param('sessionId') sessionId: string,
        @Query('activateFallback') activateFallback?: string
    ): Promise<{
        archived: ChannelSessionSummary
        fallbackActivated: ChannelSessionSummary | null
    }> {
        this.assertEnabled()
        return this.channels.archiveChannelSession(user.userId, id, sessionId, {
            activateFallback: activateFallback === 'true'
        })
    }

    private assertEnabled(): void {
        if (!this.manager.isEnabled())
            throw new NotFoundException('channels feature is disabled')
    }
}
