import type {
    AdminChatSessionDetail,
    AdminChatSessionsPage,
    AdminChatStreamEventsPage
} from '@manyfold/shared'
import {
    BadRequestException,
    Controller,
    Get,
    Param,
    Query,
    UseGuards
} from '@nestjs/common'
import { AuthGuard } from '@/common/guards/auth.guard'
import { AdminGuard } from '@/common/guards/admin.guard'
import { AdminChatSessionsService } from './admin-chat-sessions.service'

const parseLimit = (raw: string | undefined, fallback: number): number =>
    raw ? Math.max(1, Math.min(200, Number(raw))) : fallback

const parseEventCursor = (cursor: string | undefined): bigint | null => {
    if (!cursor) return null
    try {
        const id = BigInt(cursor)
        if (id < 0n) throw new Error('negative')
        return id
    } catch {
        throw new BadRequestException('cursor must be a stream event id')
    }
}

const parseOrder = (value: string | undefined): 'asc' | 'desc' => {
    if (!value) return 'desc'
    if (value !== 'asc' && value !== 'desc')
        throw new BadRequestException("order must be 'asc' or 'desc'")
    return value
}

@Controller('admin/chat-sessions')
@UseGuards(AuthGuard, AdminGuard)
export class AdminChatSessionsController {
    constructor(private readonly sessions: AdminChatSessionsService) {}

    @Get()
    list(
        @Query()
        q: {
            agentId?: string
            userId?: string
            status?: string
            hasError?: string
            q?: string
            cursor?: string
            limit?: string
        }
    ): Promise<AdminChatSessionsPage> {
        return this.sessions.list({
            limit: parseLimit(q.limit, 50),
            cursor: q.cursor ?? null,
            agentId: q.agentId ?? null,
            userId: q.userId ?? null,
            running: q.status === 'running',
            hasError: q.hasError === 'true' || q.hasError === '1',
            q: q.q?.trim() || null
        })
    }

    @Get(':id')
    get(@Param('id') id: string): Promise<AdminChatSessionDetail> {
        return this.sessions.get(id)
    }

    @Get(':id/events')
    listEvents(
        @Param('id') id: string,
        @Query()
        q: {
            cursor?: string
            limit?: string
            order?: string
            types?: string
            messageId?: string
        }
    ): Promise<AdminChatStreamEventsPage> {
        return this.sessions.listEvents(id, {
            limit: parseLimit(q.limit, 100),
            afterId: parseEventCursor(q.cursor),
            order: parseOrder(q.order),
            types: q.types
                ? q.types
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean)
                : null,
            messageId: q.messageId ?? null
        })
    }
}
