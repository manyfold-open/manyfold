import type {
    ChatMessage,
    ChatMessagesPage,
    ChatSessionSummary,
    ChatStreamEvent,
    RegenerateMessageResponse
} from '@manyfold/shared'
import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    Req,
    Res,
    UseGuards
} from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { corsHeadersForOrigin } from '@/common/cors-headers'
import { AuthGuard, type AuthPrincipal } from '@/common/guards/auth.guard'
import { CurrentUser } from '@/common/decorators/current-user.decorator'
import { RequireApiTokenScope } from '@/common/decorators/require-api-token-scope.decorator'
import { SubjectAgentFromPath } from '@/common/decorators/subject-agent.decorator'
import { ChatService } from '@/modules/chat/chat.service'
import {
    ChatSseBroadcaster,
    SSE_MAX_BUFFERED_BYTES
} from '@/modules/chat/sse-broadcaster'
import { CreateSessionDto } from '@/modules/chat/dto/create-session.dto'
import { UpdateSessionDto } from '@/modules/chat/dto/update-session.dto'
import {
    CreateMessageDto,
    ListMessagesQueryDto,
    RegenerateMessageDto
} from '@/modules/chat/dto/create-message.dto'
import { AnswerPermissionDto } from '@/modules/chat/dto/answer-permission.dto'

@Controller('agents/:agentId')
@UseGuards(AuthGuard)
export class ChatController {
    constructor(
        private readonly chat: ChatService,
        private readonly broadcaster: ChatSseBroadcaster
    ) {}

    @Get('sessions')
    @RequireApiTokenScope('chat:read')
    @SubjectAgentFromPath('agentId')
    async listSessions(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string
    ): Promise<ChatSessionSummary[]> {
        return this.chat.listSessions(user.userId, agentId)
    }

    @Post('sessions')
    @HttpCode(201)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async createSession(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Body() dto: CreateSessionDto
    ): Promise<ChatSessionSummary> {
        return this.chat.createSession(user.userId, agentId, dto.title)
    }

    @Patch('sessions/:sessionId')
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async updateSession(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Body() dto: UpdateSessionDto
    ): Promise<ChatSessionSummary> {
        return this.chat.updateSession(user.userId, agentId, sessionId, dto)
    }

    @Delete('sessions/:sessionId')
    @HttpCode(204)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async deleteSession(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Query('force') forceQuery?: string
    ): Promise<void> {
        await this.chat.deleteSession(
            user.userId,
            agentId,
            sessionId,
            forceQuery === 'true' || forceQuery === '1'
        )
    }

    @Get('sessions/:sessionId/messages')
    @RequireApiTokenScope('chat:read')
    @SubjectAgentFromPath('agentId')
    async listMessages(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Query() query: ListMessagesQueryDto
    ): Promise<ChatMessage[] | ChatMessagesPage> {
        if (query.limit !== undefined || query.before !== undefined) {
            return this.chat.listMessagePage(user.userId, agentId, sessionId, {
                limit: query.limit,
                before: query.before
            })
        }
        return this.chat.listMessages(user.userId, agentId, sessionId)
    }

    @Post('sessions/:sessionId/cancel')
    @HttpCode(204)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async cancelStream(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Query('assistantMessageId') assistantMessageId?: string
    ): Promise<void> {
        await this.chat.cancelStream(
            user.userId,
            agentId,
            sessionId,
            assistantMessageId
        )
    }

    // Composer-intent wake: fire-and-forget sprite resume so the ~1s VM wake
    // overlaps typing time. 202 whether or not a wake was actually dispatched
    // (debounced server-side).
    @Post('chat/prewarm')
    @HttpCode(202)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async prewarm(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string
    ): Promise<{ accepted: boolean }> {
        return this.chat.prewarmAgent(user.userId, agentId)
    }

    @Post('sessions/:sessionId/messages')
    @HttpCode(201)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async sendMessage(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Body() dto: CreateMessageDto
    ): Promise<{ userMessage: ChatMessage; assistantMessageId: string }> {
        return this.chat.sendMessage(
            user.userId,
            agentId,
            sessionId,
            dto.text,
            dto.attachments ?? [],
            dto.model,
            dto.modelConfigSource,
            dto.modelConfig,
            dto.saveAsDefault,
            dto.claudeCodePermissionMode,
            dto.codexPermissionMode,
            dto.hermesPermissionMode,
            undefined,
            dto.contextRefs ?? [],
            dto.uploads ?? []
        )
    }

    // The user's answer to a hermes permission_request card. 204 = delivered
    // to the blocked ACP client (or durably queued for the peer that holds
    // it); 409 = already answered or the turn ended; 502 = the carrying
    // daemon could not be reached (retryable).
    @Post('sessions/:sessionId/messages/:messageId/permissions/:requestId')
    @HttpCode(204)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async answerPermission(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Param('messageId') messageId: string,
        @Param('requestId') requestId: string,
        @Body() dto: AnswerPermissionDto
    ): Promise<void> {
        await this.chat.answerPermission(
            user.userId,
            agentId,
            sessionId,
            messageId,
            requestId,
            dto.optionId
        )
    }

    @Post('sessions/:sessionId/messages/:messageId/regenerate')
    @HttpCode(201)
    @RequireApiTokenScope('chat:edit')
    @SubjectAgentFromPath('agentId')
    async regenerateMessage(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Param('messageId') messageId: string,
        @Body() dto: RegenerateMessageDto
    ): Promise<RegenerateMessageResponse> {
        return this.chat.regenerateMessage(
            user.userId,
            agentId,
            sessionId,
            messageId,
            dto.text,
            dto.model,
            dto.modelConfigSource,
            dto.modelConfig,
            dto.saveAsDefault,
            dto.codexPermissionMode
        )
    }

    @Get('sessions/:sessionId/stream')
    @RequireApiTokenScope('chat:read')
    @SubjectAgentFromPath('agentId')
    async stream(
        @CurrentUser() user: AuthPrincipal,
        @Param('agentId') agentId: string,
        @Param('sessionId') sessionId: string,
        @Query('lastEventId') lastEventIdQuery: string | undefined,
        @Query('replayMessageId') replayMessageIdQuery: string | undefined,
        @Req() req: FastifyRequest,
        @Res() res: FastifyReply
    ): Promise<void> {
        const session = await this.chat.subscribeStream(
            user.userId,
            agentId,
            sessionId
        )

        const headerLastEventId =
            (req.headers['last-event-id'] as string | undefined) ?? undefined
        const lastEventId = lastEventIdQuery ?? headerLastEventId ?? null
        const replayMessageId = replayMessageIdQuery ?? null

        res.hijack()
        res.raw.socket?.setNoDelay(true)
        res.raw.writeHead(200, {
            ...corsHeadersForOrigin(req.headers),
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no'
        })

        const writeEvent = (event: ChatStreamEvent): void => {
            // A client that stopped reading lets unflushed data pile up in the
            // socket without bound. Disconnect it instead — the browser
            // reconnects with Last-Event-ID and the DB log replays the gap.
            if (res.raw.writableLength > SSE_MAX_BUFFERED_BYTES) {
                cleanup()
                throw new Error(
                    `sse client too slow (${res.raw.writableLength} buffered bytes)`
                )
            }
            // One write per frame: the socket is setNoDelay(true), so a write
            // per line can leave as its own syscall and its own TCP segment.
            res.raw.write(
                `id: ${event.eventId}\n` +
                    `event: ${event.type}\n` +
                    `data: ${JSON.stringify(event)}\n\n`
            )
        }

        const subscriber = {
            send: writeEvent,
            close: (): void => {
                try {
                    res.raw.end()
                } catch {
                    /* ignore */
                }
            }
        }

        let unsubscribe: (() => void) | null = null
        const keepalive = setInterval(() => {
            try {
                res.raw.write(`: keepalive ${Date.now()}\n\n`)
            } catch {
                /* socket already gone; cleanup will run */
            }
        }, 15000)

        const cleanup = (): void => {
            clearInterval(keepalive)
            unsubscribe?.()
            try {
                res.raw.end()
            } catch {
                /* ignore */
            }
        }
        req.raw.on('close', cleanup)
        req.raw.on('error', cleanup)
        if (req.raw.destroyed) {
            cleanup()
            return
        }

        unsubscribe = await this.broadcaster.subscribe(
            session.id,
            subscriber,
            lastEventId,
            replayMessageId
        )
        if (req.raw.destroyed) cleanup()
    }
}
