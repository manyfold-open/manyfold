import type { ChatUploadResponse } from '@manyfold/shared'
import {
    BadRequestException,
    Controller,
    HttpCode,
    NotFoundException,
    Param,
    PayloadTooLargeException,
    Post,
    Req,
    UseGuards
} from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromPath } from '@/common/decorators/subject-agent.decorator'
import { AgentsService } from '@/modules/agents/agents.service'
import { ChatUploadStorageService } from '@/modules/chat/uploads/chat-upload-storage.service'

@Controller('agents')
@UseGuards(AuthGuard)
export class ChatUploadsController {
    constructor(
        private readonly agents: AgentsService,
        private readonly uploads: ChatUploadStorageService
    ) {}

    @Post(':id/chat-uploads')
    @HttpCode(201)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('id')
    async upload(
        @CurrentUser() user: AuthPrincipal,
        @Param('id') agentId: string,
        @Req() req: FastifyRequest
    ): Promise<ChatUploadResponse> {
        const agent = await this.agents.findForCaller(
            agentId,
            user.userId,
            false
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        if (agent.framework !== 'dify')
            throw new BadRequestException(
                `framework ${agent.framework} does not support chat uploads`
            )
        const file = await req.file()
        if (!file) throw new BadRequestException('file is required')
        const name = file.filename || 'upload'
        const contentType = file.mimetype || 'application/octet-stream'
        const { id, size } = await this.uploads.put({
            userId: user.userId,
            agentId,
            name,
            contentType,
            stream: file.file
        })
        if (file.file.truncated) {
            await this.uploads
                .delete(id, user.userId, agentId)
                .catch(() => undefined)
            throw new PayloadTooLargeException('uploaded file is too large')
        }
        return { id, name, contentType, size }
    }
}
