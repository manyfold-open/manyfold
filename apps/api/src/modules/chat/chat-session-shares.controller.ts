import type {
    GetChatSessionShareResult,
    ShareChatSessionResult
} from '@manyfold/shared'
import {
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    UseGuards
} from '@nestjs/common'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromPath } from '@/common/decorators/subject-agent.decorator'
import { ChatSessionSharesService } from '@/modules/chat/chat-session-shares.service'

@Controller('agents/:agentId')
@UseGuards(AuthGuard)
export class ChatSessionSharesController {
    constructor(private readonly shares: ChatSessionSharesService) {}

    @Post('sessions/:sessionId/share')
    @HttpCode(201)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async createShare(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string
    ): Promise<ShareChatSessionResult> {
        return this.shares.createShare(user.userId, agentId, sessionId)
    }

    @Get('sessions/:sessionId/share')
    @RequireApiTokenScope('chat:read')
    @SubjectAgentFromPath('agentId')
    async getShare(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string
    ): Promise<GetChatSessionShareResult> {
        return this.shares.getShare(user.userId, agentId, sessionId)
    }

    @Delete('sessions/:sessionId/share')
    @HttpCode(204)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async revokeShare(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string
    ): Promise<void> {
        await this.shares.revokeShare(user.userId, agentId, sessionId)
    }
}
