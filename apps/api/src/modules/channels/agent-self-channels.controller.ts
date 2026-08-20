import type { AgentChannelSendResult } from '@manyfold/shared'
import {
    BadRequestException,
    Body,
    Controller,
    HttpCode,
    NotFoundException,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromResource } from '@/common/decorators/subject-agent.decorator'
import { AllowRuntimeSelf } from '@/common/decorators/allow-runtime-self.decorator'
import { principalAgentId } from '@/modules/auth/auth-principal'
import { ChannelsService } from './channels.service'
import { ChannelManagerService } from './channel-manager.service'
import { ChannelBridgeService } from './channel-bridge.service'
import { ChannelSendRateLimitService } from './channel-send-rate-limit.service'
import { AgentChannelSendDto } from './dto/channels.dto'
import type { ChannelSendTarget } from './channel-provider'

const SEND_LIMIT_PER_MIN = 30

// Agent-initiated channel send. @AllowRuntimeSelf lets the bound agent's
// runtime token through scope-free while @SubjectAgentFromResource still
// asserts the channel is bound to that agent and owned by the same user;
// human tokens need channels:edit on an owned channel.
@Controller('agent-self/channels')
@UseGuards(AuthGuard)
export class AgentSelfChannelsController {
    constructor(
        private readonly channels: ChannelsService,
        private readonly manager: ChannelManagerService,
        private readonly bridge: ChannelBridgeService,
        private readonly rateLimit: ChannelSendRateLimitService
    ) {}

    @Post(':channelId/send')
    @HttpCode(200)
    @RequireApiTokenScope('channels:edit')
    @AllowRuntimeSelf()
    @SubjectAgentFromResource('channel', 'channelId')
    async send(
        @CurrentUser() user: AuthPrincipal,
        @Param('channelId') channelId: string,
        @Body() dto: AgentChannelSendDto
    ): Promise<AgentChannelSendResult> {
        if (!this.manager.isEnabled())
            throw new NotFoundException('channels feature is disabled')
        const target = parseSendTarget(dto)
        const channel = await this.channels.loadOwned(user.userId, channelId)
        if (channel.status !== 'active')
            throw new BadRequestException(
                `channel is ${channel.status}; only active channels can send`
            )
        this.rateLimit.consume({
            key: `channel:send:${principalAgentId(user) ?? user.userId}:${channel.id}`,
            limit: SEND_LIMIT_PER_MIN,
            windowMs: 60_000
        })
        const text = dto.text ?? null
        const files = (dto.files ?? []).map(parseWorkspaceFileRef)
        if (text === null && files.length === 0)
            throw new BadRequestException('text or files is required')
        const sent = await this.bridge.sendAgentDirect(
            channel,
            target,
            text,
            files
        )
        return {
            deliveryId: String(sent.deliveryId),
            status: sent.status,
            providerMessageId: sent.providerMessageId,
            ...(sent.files
                ? {
                      files: {
                          deliveryId: String(sent.files.deliveryId),
                          status: sent.files.status,
                          providerMessageId: sent.files.providerMessageId
                      }
                  }
                : {})
        }
    }
}

// Agents name files the way they see them ("/workspace/report.pdf" or a bare
// relative path); normalize to the workspace-relative form readWorkspaceFiles
// expects. Path safety is enforced server-side at read time (resolveSafePath).
const parseWorkspaceFileRef = (
    path: string
): { relPath: string; name: string } => {
    const relPath = path.trim().replace(/^\/?(?:workspace\/)?/, '')
    if (!relPath)
        throw new BadRequestException(`invalid workspace file path: ${path}`)
    const name = relPath.split('/').pop() ?? relPath
    return { relPath, name }
}

const parseSendTarget = (dto: AgentChannelSendDto): ChannelSendTarget => {
    const targets: ChannelSendTarget[] = []
    if (dto.chatId) targets.push({ kind: 'chat', chatId: dto.chatId })
    if (dto.userId) targets.push({ kind: 'user', userId: dto.userId })
    if (dto.replyToMessageId)
        targets.push({ kind: 'reply', messageId: dto.replyToMessageId })
    const target = targets[0]
    if (!target || targets.length !== 1)
        throw new BadRequestException(
            'exactly one of chatId, userId or replyToMessageId is required'
        )
    return target
}
