import type {
    ChatContentBlock,
    ChatMessage,
    ChatSessionSummary,
    ConversationListEnvelope,
    ConversationMessageObject,
    ConversationMessageTextPart,
    ConversationObject
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import { ChatService } from '@/modules/chat/chat.service'
import { sanitizeBlock } from '@/modules/chat/content-block-sanitizer'

export interface ConversationsListParams {
    agentId: string | null
    limit: number
    after: string | null
    order: 'asc' | 'desc'
}

export interface ConversationMessagesParams {
    boundAgentId: string | null
    limit: number
    after: string | null
    order: 'asc' | 'desc'
}

@Injectable()
export class OpenAiConversationsService {
    constructor(private readonly chat: ChatService) {}

    async listConversations(
        userId: string,
        params: ConversationsListParams
    ): Promise<ConversationListEnvelope<ConversationObject>> {
        const { items, hasMore } = await this.chat.listConversations(
            userId,
            params
        )
        return toListEnvelope(items.map(toConversationObject), hasMore)
    }

    async listConversationMessages(
        userId: string,
        sessionId: string,
        params: ConversationMessagesParams
    ): Promise<ConversationListEnvelope<ConversationMessageObject>> {
        const { items, hasMore } = await this.chat.listConversationMessages(
            userId,
            sessionId,
            params
        )
        return toListEnvelope(items.map(toMessageObject), hasMore)
    }
}

const toConversationObject = (s: ChatSessionSummary): ConversationObject => ({
    object: 'conversation',
    id: s.id,
    model: s.agentId,
    title: s.title,
    created_at: unixSeconds(s.createdAt),
    updated_at: unixSeconds(s.updatedAt)
})

const toMessageObject = (m: ChatMessage): ConversationMessageObject => ({
    id: m.id,
    object: 'message',
    role: m.role,
    content: textParts(m.contentBlocks),
    content_blocks: m.contentBlocks.map(sanitizeBlock),
    model: m.model ?? null,
    created_at: unixSeconds(m.createdAt)
})

const toListEnvelope = <T extends { id: string }>(
    data: T[],
    hasMore: boolean
): ConversationListEnvelope<T> => ({
    object: 'list',
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: hasMore
})

const textParts = (
    blocks: ChatContentBlock[]
): ConversationMessageTextPart[] =>
    blocks.flatMap((b): ConversationMessageTextPart[] =>
        b.type === 'text' ? [{ type: 'text', text: b.text }] : []
    )

const unixSeconds = (iso: string): number =>
    Math.floor(new Date(iso).getTime() / 1000)