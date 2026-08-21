import { DEFAULT_WEB_BASE_URL } from '@/common/brand'
import {
    AgentFramework,
    ChatContentBlock,
    ChatRole,
    GetChatSessionShareResult,
    ShareChatSessionResult,
    SharedChatMessage,
    SharedChatMessagesPage,
    SharedChatSessionPreview,
    createObjectId,
    isObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, isNull } from 'drizzle-orm'
import {
    agents,
    chatSessions,
    chatSessionShares,
    users,
    type AgentUsageEventRow,
    type ChatMessage as DbChatMessage,
    type ChatSession as DbChatSession,
    type ChatSessionShareRow,
    type Database
} from '@manyfold/db'
import { configString } from '@/common/config-alias'
import { DRIZZLE } from '@/db/tokens'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { sanitizeSharedBlocks } from '@/modules/chat/content-block-sanitizer'
import {
    decodeMessageCursor,
    encodeMessageCursor,
    modelFromMessageMetadata,
    normalizeMessagePageLimit
} from '@/modules/chat/message-page'

interface ResolvedShare {
    share: ChatSessionShareRow
    session: DbChatSession
    agent: { name: string; framework: AgentFramework }
}

@Injectable()
export class ChatSessionSharesService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly repo: ChatRepository,
        private readonly config: ConfigService
    ) {}

    async createShare(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<ShareChatSessionResult> {
        const session = await this.assertOwnedSession(
            userId,
            agentId,
            sessionId
        )
        // Channel-bound sessions carry third-party members' messages, which
        // the owner cannot unilaterally publish.
        const channels = await this.repo.listSessionChannels([sessionId])
        if (channels.length > 0)
            throw new ConflictException({
                code: 'chat_share_channel_session',
                message: 'channel-bound sessions cannot be shared'
            })
        const active = await this.activeForSession(sessionId)
        if (active) return this.toShareResult(active)
        const cutoff = await this.repo.latestMessageCursor(sessionId, {
            excludeMessageId: session.inflightMessageId
        })
        if (!cutoff)
            throw new BadRequestException({
                code: 'chat_share_empty_session',
                message: 'session has no messages to share'
            })
        try {
            const [row] = await this.db
                .insert(chatSessionShares)
                .values({
                    id: createObjectId('chatSessionShare'),
                    sessionId,
                    userId,
                    cutoffMessageId: cutoff.id,
                    cutoffCreatedAt: cutoff.createdAt
                })
                .returning()
            return this.toShareResult(row)
        } catch (err) {
            if (isActiveShareConflict(err)) {
                const existing = await this.activeForSession(sessionId)
                if (existing) return this.toShareResult(existing)
            }
            throw err
        }
    }

    async revokeShare(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<void> {
        await this.assertOwnedSession(userId, agentId, sessionId)
        await this.db
            .update(chatSessionShares)
            .set({ revokedAt: new Date(), updatedAt: new Date() })
            .where(
                and(
                    eq(chatSessionShares.sessionId, sessionId),
                    isNull(chatSessionShares.revokedAt)
                )
            )
    }

    async getShare(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<GetChatSessionShareResult> {
        await this.assertOwnedSession(userId, agentId, sessionId)
        const active = await this.activeForSession(sessionId)
        return { share: active ? this.toShareResult(active) : null }
    }

    // Missing, revoked, malformed and cascade-deleted shares all resolve to
    // null so every public read shares one uniform 404.
    async resolveActiveShare(shareId: string): Promise<ResolvedShare | null> {
        if (!isObjectId(shareId, 'chatSessionShare')) return null
        const [row] = await this.db
            .select({
                share: chatSessionShares,
                session: chatSessions,
                agentName: agents.name,
                agentFramework: agents.framework
            })
            .from(chatSessionShares)
            .innerJoin(
                chatSessions,
                eq(chatSessionShares.sessionId, chatSessions.id)
            )
            .innerJoin(agents, eq(chatSessions.agentId, agents.id))
            .where(
                and(
                    eq(chatSessionShares.id, shareId),
                    isNull(chatSessionShares.revokedAt)
                )
            )
            .limit(1)
        if (!row) return null
        return {
            share: row.share,
            session: row.session,
            agent: { name: row.agentName, framework: row.agentFramework }
        }
    }

    // Built field-by-field on purpose: the anonymous surface must not carry
    // internal ids (session/agent/user), the owner's email or usage/error data.
    async buildPublicPreview(
        shareId: string
    ): Promise<SharedChatSessionPreview> {
        const resolved = await this.resolveActiveShare(shareId)
        if (!resolved) throw shareNotFound()
        const [owner] = await this.db
            .select({ displayName: users.displayName })
            .from(users)
            .where(eq(users.id, resolved.share.userId))
            .limit(1)
        return {
            session: {
                title: resolved.session.title,
                createdAt: resolved.session.createdAt.toISOString()
            },
            agent: resolved.agent,
            sharedBy: owner?.displayName ?? null,
            sharedAt: resolved.share.createdAt.toISOString()
        }
    }

    async listPublicMessages(
        shareId: string,
        opts: { limit?: number; before?: string }
    ): Promise<SharedChatMessagesPage> {
        const resolved = await this.resolveActiveShare(shareId)
        if (!resolved) throw shareNotFound()
        const limit = normalizeMessagePageLimit(opts.limit)
        const before = opts.before ? decodeMessageCursor(opts.before) : null
        const rows = await this.repo.listMessagePageWithUsage(
            resolved.session.id,
            {
                limit: limit + 1,
                before,
                notAfter: {
                    createdAt: resolved.share.cutoffCreatedAt,
                    id: resolved.share.cutoffMessageId
                }
            }
        )
        const hasMore = rows.length > limit
        const pageRows = hasMore ? rows.slice(0, limit) : rows
        const messages = pageRows
            .map(({ message, usage }) => toSharedMessage(message, usage))
            .reverse()
        const earliest = pageRows[pageRows.length - 1]?.message ?? null
        return {
            messages,
            hasMore,
            nextBefore:
                hasMore && earliest
                    ? encodeMessageCursor({
                          createdAt: earliest.createdAt,
                          id: earliest.id
                      })
                    : null
        }
    }

    private async assertOwnedSession(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<DbChatSession> {
        const session = await this.repo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        return session
    }

    private async activeForSession(
        sessionId: string
    ): Promise<ChatSessionShareRow | null> {
        const [row] = await this.db
            .select()
            .from(chatSessionShares)
            .where(
                and(
                    eq(chatSessionShares.sessionId, sessionId),
                    isNull(chatSessionShares.revokedAt)
                )
            )
            .limit(1)
        return row ?? null
    }

    private toShareResult(row: ChatSessionShareRow): ShareChatSessionResult {
        return {
            id: row.id,
            sessionId: row.sessionId,
            url: `${this.webUrl()}/chat/shared/${row.id}`,
            createdAt: row.createdAt.toISOString()
        }
    }

    private webUrl(): string {
        const raw =
            configString(this.config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? DEFAULT_WEB_BASE_URL
        return raw.replace(/\/+$/, '')
    }
}

const toSharedMessage = (
    row: DbChatMessage,
    usageRow: AgentUsageEventRow | null
): SharedChatMessage => ({
    id: row.id,
    role: row.role as ChatRole,
    contentBlocks: sanitizeSharedBlocks(
        (row.contentBlocksJson as ChatContentBlock[]) ?? []
    ),
    createdAt: row.createdAt.toISOString(),
    model: usageRow?.model ?? modelFromMessageMetadata(row)
})

export const shareNotFound = (): NotFoundException =>
    new NotFoundException({
        code: 'chat_share_not_found',
        message: 'share not found'
    })

const isActiveShareConflict = (err: unknown): boolean =>
    err instanceof Error &&
    err.message.includes('chat_session_shares_active_session_uq')
