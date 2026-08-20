import type {
    SharedChatMessagesPage,
    SharedChatSessionPreview
} from '@manyfold/shared'
import { Controller, Get, Param, Query, Req } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import {
    clientKey,
    ShareRateLimitService
} from '@/common/share-rate-limit.service'
import { ChatSessionSharesService } from '@/modules/chat/chat-session-shares.service'
import { ListMessagesQueryDto } from '@/modules/chat/dto/create-message.dto'

const SHARED_PREVIEW_LIMIT_PER_MIN = 60

// Unauthenticated on purpose: the share id is the capability (unlisted-link
// semantics). Keyed per-IP only — a per-id bucket would hand an enumerating
// client a fresh quota for every guess.
@Controller('chat/shared')
export class SharedChatSessionsController {
    constructor(
        private readonly shares: ChatSessionSharesService,
        private readonly rateLimit: ShareRateLimitService
    ) {}

    @Get(':shareId')
    preview(
        @Param('shareId') shareId: string,
        @Req() req: FastifyRequest
    ): Promise<SharedChatSessionPreview> {
        this.consume(req)
        return this.shares.buildPublicPreview(shareId)
    }

    @Get(':shareId/messages')
    messages(
        @Param('shareId') shareId: string,
        @Query() query: ListMessagesQueryDto,
        @Req() req: FastifyRequest
    ): Promise<SharedChatMessagesPage> {
        this.consume(req)
        return this.shares.listPublicMessages(shareId, {
            limit: query.limit,
            before: query.before
        })
    }

    private consume(req: FastifyRequest): void {
        this.rateLimit.consume({
            key: `chat:shared:${clientKey(req)}`,
            limit: SHARED_PREVIEW_LIMIT_PER_MIN,
            windowMs: 60_000
        })
    }
}
