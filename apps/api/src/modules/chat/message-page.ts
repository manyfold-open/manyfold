import { BadRequestException } from '@nestjs/common'
import type { ChatMessage as DbChatMessage } from '@manyfold/db'
import type { MessageCursor } from '@/modules/chat/chat.repository'

export const CHAT_MESSAGES_PAGE_DEFAULT_LIMIT = 50
export const CHAT_MESSAGES_PAGE_MAX_LIMIT = 100

export const normalizeMessagePageLimit = (
    limit: number | undefined
): number => {
    if (limit === undefined) return CHAT_MESSAGES_PAGE_DEFAULT_LIMIT
    if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > CHAT_MESSAGES_PAGE_MAX_LIMIT
    )
        throw new BadRequestException('limit must be an integer from 1 to 100')
    return limit
}

export const encodeMessageCursor = (cursor: MessageCursor): string =>
    Buffer.from(
        JSON.stringify({
            createdAt: cursor.createdAt.toISOString(),
            id: cursor.id
        })
    ).toString('base64url')

export const decodeMessageCursor = (value: string): MessageCursor => {
    try {
        const parsed = JSON.parse(
            Buffer.from(value, 'base64url').toString('utf8')
        ) as unknown
        if (!parsed || typeof parsed !== 'object')
            throw new Error('cursor is not an object')
        const cursor = parsed as { createdAt?: unknown; id?: unknown }
        if (typeof cursor.createdAt !== 'string')
            throw new Error('cursor createdAt is missing')
        if (typeof cursor.id !== 'string' || cursor.id.length === 0)
            throw new Error('cursor id is missing')
        const createdAt = new Date(cursor.createdAt)
        if (Number.isNaN(createdAt.getTime()))
            throw new Error('cursor createdAt is invalid')
        return {
            createdAt,
            id: cursor.id
        }
    } catch {
        throw new BadRequestException('invalid message cursor')
    }
}

export const modelFromMessageMetadata = (
    row: DbChatMessage
): string | null => {
    const metadata = row.capabilityEventsJson
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        return null
    return normalizeMessageModel((metadata as { model?: unknown }).model)
}

export const normalizeMessageModel = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}
