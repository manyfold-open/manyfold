import { DAEMON_ONLINE_THRESHOLD_MS } from '@manyfold/shared'
import type {
    ChannelProviderName,
    ChatContentBlock
} from '@manyfold/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import {
    and,
    asc,
    count,
    desc,
    eq,
    exists,
    gt,
    ilike,
    inArray,
    isNotNull,
    isNull,
    lt,
    lte,
    max,
    min,
    ne,
    notExists,
    or,
    sql,
    type AnyColumn,
    type SQL
} from 'drizzle-orm'
import {
    agents,
    agentUsageEvents,
    channels,
    channelSessions,
    chatMessageSources,
    chatMessages,
    chatPermissionAnswers,
    chatSessions,
    chatSessionShares,
    chatStreamEvents,
    jsonbMerge,
    runtimeHosts,
    turnExecutions,
    users,
    type AgentUsageEventRow,
    type ChatMessage as DbChatMessage,
    type ChatMessageSource as DbChatMessageSource,
    type ChatSession as DbChatSession,
    type Database,
    type NewChatMessage,
    type NewChatMessageSource,
    type NewChatSession,
    type NewChatStreamEventRow,
    type TurnExecutionRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { likeNeedle } from '@/common/catalog-query'
import { sanitizeForJsonb } from '@/common/jsonb-sanitize'
import { nonTerminalStreamEventInsert } from './stream-event-insert'
import { dedupRecoveredRowsBySourceKey } from './recovered-dedup'
import { createAssistantBlockBuffer } from './assistant-blocks'
import { TurnFenceLostError, type TurnExecutionFence } from './turn-fence'

export type TerminalStreamContent =
    | {
          contentBlocksJson: ChatContentBlock[]
          contentCheckpointEventId: bigint | null
      }
    | { replayFromStream: true }

export type ResumeTurnClaim =
    | { outcome: 'claimed'; row: TurnExecutionRow }
    | { outcome: 'busy' | 'terminal' | 'mismatch' }

export const ORPHANED_ASSISTANT_MESSAGE_GRACE_MS = 24 * 60 * 60 * 1000
// On graceful shutdown a turn is handed off (marked adoptable) from
// onModuleDestroy, but the dying instance's relay loop keeps emitting for a few
// seconds while the process closes. Delay adoptability past main.ts's
// post-handoff shutdown ceiling (<10s) so the original relay is gone before any
// peer adopts — otherwise both emit the same (messageId, seq) and collide.
export const HANDOFF_DRAIN_GRACE_SECONDS = 15

export interface ChatSessionChannelRow {
    chatSessionId: string
    channelSessionId: string
    channelId: string
    provider: ChannelProviderName
    label: string
    displayName: string | null
    channelSessionCreatedAt: Date
    channelSessionUpdatedAt: Date
}

export interface RegenerateRewriteResult {
    userMessage: DbChatMessage
    deletedMessageIds: string[]
    historyRows: DbChatMessage[]
}

export interface MessageCursor {
    createdAt: Date
    id: string
}

export interface AdminSessionCursor {
    updatedAt: Date
    id: string
}

export interface AdminSessionRow {
    session: DbChatSession
    userEmail: string | null
    userDisplayName: string | null
    agentName: string | null
    agentFramework: string | null
    agentRuntime: string | null
}

@Injectable()
export class ChatRepository {
    private readonly logger = new Logger(ChatRepository.name)
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async writeAssistantContent(
        messageId: string,
        blocks: ChatContentBlock[],
        checkpointEventId: bigint | null,
        fence?: TurnExecutionFence
    ): Promise<{ written: boolean; fenceLost: boolean }> {
        if (fence && fence.messageId !== messageId)
            return { written: false, fenceLost: true }
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext('chat_message_content'), hashtext(${messageId}))`
            )
            // Locking the execution tuple is the serialization point with an
            // ownership UPDATE. A snapshot-only check can approve here, wait,
            // and commit stale content after the takeover.
            if (fence && !(await lockTurnFence(tx, fence)))
                return { written: false, fenceLost: true }
            const [terminal] = await tx
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(
                    and(
                        eq(chatStreamEvents.messageId, messageId),
                        inArray(chatStreamEvents.eventType, ['done', 'error'])
                    )
                )
                .limit(1)
            if (terminal) return { written: false, fenceLost: false }
            const [updated] = await tx
                .update(chatMessages)
                .set({
                    contentBlocksJson: blocks,
                    contentCheckpointEventId: checkpointEventId
                })
                .where(eq(chatMessages.id, messageId))
                .returning({ id: chatMessages.id })
            return { written: updated !== undefined, fenceLost: false }
        })
    }

    // Run several reads against ONE Postgres snapshot instead of one snapshot
    // per statement. Under the default READ COMMITTED every statement takes a
    // fresh snapshot, so a multi-read answer can describe two different
    // instants — and where the reads classify the SAME turn from different
    // angles (its content row, its terminal, whether it is still inflight),
    // two instants is a contradiction the caller ships to a client.
    //
    // REPEATABLE READ takes the snapshot at the FIRST statement inside and
    // holds it for the rest, which is exactly the property wanted here. Read
    // only, so it can never take the serialization failure a writing
    // transaction at this level can, and never holds a row lock.
    //
    // The cost is one BEGIN/COMMIT pair and a connection pinned across the
    // reads, so this belongs on page-shaped reads and not on hot per-event
    // paths.
    async readSnapshot<T>(
        fn: (repo: ChatRepository) => Promise<T>
    ): Promise<T> {
        return this.db.transaction(
            (tx) => fn(new ChatRepository(tx as unknown as Database)),
            { isolationLevel: 'repeatable read', accessMode: 'read only' }
        )
    }

    async createSession(row: NewChatSession): Promise<DbChatSession> {
        const [created] = await this.db
            .insert(chatSessions)
            .values(row)
            .returning()
        return created
    }

    async deleteSessionIfEmpty(sessionId: string): Promise<boolean> {
        const deleted = await this.db
            .delete(chatSessions)
            .where(
                and(
                    eq(chatSessions.id, sessionId),
                    notExists(
                        this.db
                            .select({ id: chatMessages.id })
                            .from(chatMessages)
                            .where(eq(chatMessages.sessionId, chatSessions.id))
                    )
                )
            )
            .returning({ id: chatSessions.id })
        return deleted.length > 0
    }

    async deleteSession(sessionId: string): Promise<boolean> {
        const deleted = await this.db
            .delete(chatSessions)
            .where(eq(chatSessions.id, sessionId))
            .returning({ id: chatSessions.id })
        return deleted.length > 0
    }

    async listSessions(
        userId: string,
        agentId: string
    ): Promise<DbChatSession[]> {
        return this.db
            .select()
            .from(chatSessions)
            .where(
                and(
                    eq(chatSessions.userId, userId),
                    eq(chatSessions.agentId, agentId)
                )
            )
            .orderBy(asc(chatSessions.createdAt))
    }

    async listSessionChannels(
        sessionIds: string[]
    ): Promise<ChatSessionChannelRow[]> {
        if (sessionIds.length === 0) return []

        return this.db
            .select({
                chatSessionId: channelSessions.chatSessionId,
                channelSessionId: channelSessions.id,
                channelId: channels.id,
                provider: channels.provider,
                label: channels.label,
                displayName: channelSessions.displayName,
                channelSessionCreatedAt: channelSessions.createdAt,
                channelSessionUpdatedAt: channelSessions.updatedAt
            })
            .from(channelSessions)
            .innerJoin(channels, eq(channelSessions.channelId, channels.id))
            .where(inArray(channelSessions.chatSessionId, sessionIds))
            .orderBy(
                channelSessions.chatSessionId,
                desc(channelSessions.updatedAt),
                desc(channelSessions.createdAt)
            )
    }

    // Public /v1/conversations list: the caller's non-channel sessions across
    // all (or one filtered) agent. Ordered by created_at + id — NOT by id
    // string: ObjectIds are UUIDv7 base32 (alphabet a-z2-7), which is not
    // order-preserving under SQL string comparison, so an id cursor would be
    // non-chronological. created_at is the chronological anchor; id is only a
    // deterministic tie-breaker.
    async listUserConversationsPage(
        userId: string,
        opts: {
            agentId: string | null
            limit: number
            after: MessageCursor | null
            order: 'asc' | 'desc'
        }
    ): Promise<DbChatSession[]> {
        const { agentId, after, order } = opts
        return this.db
            .select()
            .from(chatSessions)
            .where(
                and(
                    eq(chatSessions.userId, userId),
                    agentId ? eq(chatSessions.agentId, agentId) : undefined,
                    notExists(
                        this.db
                            .select({ id: channelSessions.id })
                            .from(channelSessions)
                            .where(
                                eq(
                                    channelSessions.chatSessionId,
                                    chatSessions.id
                                )
                            )
                    ),
                    after
                        ? afterCondition(
                              chatSessions.createdAt,
                              chatSessions.id,
                              after,
                              order
                          )
                        : undefined
                )
            )
            .orderBy(
                order === 'asc'
                    ? asc(chatSessions.createdAt)
                    : desc(chatSessions.createdAt),
                order === 'asc' ? asc(chatSessions.id) : desc(chatSessions.id)
            )
            .limit(opts.limit)
    }

    // Resolve an `after` object-id cursor to its (created_at, id) under the
    // SAME visibility predicate as the list (owner + optional agent + non
    // channel). Returns null when the id is outside the caller's filtered set,
    // so pagination can't be anchored on a session the filter would hide.
    async resolveConversationCursor(
        userId: string,
        opts: { agentId: string | null },
        after: string
    ): Promise<MessageCursor | null> {
        const rows = await this.db
            .select({ createdAt: chatSessions.createdAt, id: chatSessions.id })
            .from(chatSessions)
            .where(
                and(
                    eq(chatSessions.id, after),
                    eq(chatSessions.userId, userId),
                    opts.agentId
                        ? eq(chatSessions.agentId, opts.agentId)
                        : undefined,
                    notExists(
                        this.db
                            .select({ id: channelSessions.id })
                            .from(channelSessions)
                            .where(
                                eq(
                                    channelSessions.chatSessionId,
                                    chatSessions.id
                                )
                            )
                    )
                )
            )
            .limit(1)
        return rows[0] ?? null
    }

    async getSession(
        sessionId: string,
        userId: string
    ): Promise<DbChatSession | null> {
        const rows = await this.db
            .select()
            .from(chatSessions)
            .where(
                and(
                    eq(chatSessions.id, sessionId),
                    eq(chatSessions.userId, userId)
                )
            )
            .limit(1)
        return rows[0] ?? null
    }

    async findSessionByFrameworkSessionRef(
        userId: string,
        agentId: string,
        ref: string
    ): Promise<DbChatSession | null> {
        const rows = await this.db
            .select()
            .from(chatSessions)
            .where(
                and(
                    eq(chatSessions.userId, userId),
                    eq(chatSessions.agentId, agentId),
                    eq(chatSessions.frameworkSessionRef, ref)
                )
            )
            .orderBy(desc(chatSessions.updatedAt))
            .limit(1)
        return rows[0] ?? null
    }

    async touchSession(sessionId: string): Promise<void> {
        await this.db
            .update(chatSessions)
            .set({ updatedAt: new Date() })
            .where(eq(chatSessions.id, sessionId))
    }

    async updateFrameworkSessionRef(
        sessionId: string,
        ref: string | null,
        fence?: TurnExecutionFence
    ): Promise<void> {
        if (fence) {
            await this.db.transaction(async (tx) => {
                if (!(await lockTurnSessionFence(tx, fence, sessionId)))
                    throw new TurnFenceLostError(fence.messageId)
                await tx
                    .update(chatSessions)
                    .set({ frameworkSessionRef: ref, updatedAt: new Date() })
                    .where(eq(chatSessions.id, sessionId))
            })
            return
        }
        await this.db
            .update(chatSessions)
            .set({ frameworkSessionRef: ref, updatedAt: new Date() })
            .where(eq(chatSessions.id, sessionId))
    }

    // Shallow-merges a patch into the message's capability metadata (the jsonb
    // that already carries {model}). jsonbMerge runs against the LIVE row in
    // SQL, so it cannot resurrect fields a concurrent writer just set.
    async mergeMessageMetadata(
        messageId: string,
        sessionId: string,
        patch: Record<string, unknown>,
        fence?: TurnExecutionFence
    ): Promise<void> {
        const merged = sanitizeForJsonb(patch) as Record<string, unknown>
        const apply = async (tx: Database | DatabaseTx): Promise<void> => {
            await tx
                .update(chatMessages)
                .set({
                    capabilityEventsJson: jsonbMerge(
                        chatMessages.capabilityEventsJson,
                        merged
                    )
                })
                .where(eq(chatMessages.id, messageId))
        }
        if (fence) {
            await this.db.transaction(async (tx) => {
                if (!(await lockTurnSessionFence(tx, fence, sessionId)))
                    throw new TurnFenceLostError(fence.messageId)
                await apply(tx)
            })
            return
        }
        await apply(this.db)
    }

    // Durable half of a permission answer (see ChatPermissionBus). The
    // composite PK makes the second answer a no-op here and a 409 at the
    // endpoint — first click wins, racing tabs included.
    async insertPermissionAnswer(row: {
        messageId: string
        requestId: string
        optionId: string
        userId: string
    }): Promise<boolean> {
        const inserted = await this.db
            .insert(chatPermissionAnswers)
            .values(row)
            .onConflictDoNothing()
            .returning({ requestId: chatPermissionAnswers.requestId })
        return inserted.length > 0
    }

    // Drop a resume ref a framework can no longer load, but only while it is
    // still the one the caller attempted. A failing turn decides to clear after
    // its exec ended, and by then another writer (a concurrent turn's `init`,
    // an edit-fork reset, an adoption) may already have moved the session on —
    // an unconditional clear would throw that live ref away. Reports whether
    // this call is the one that cleared it.
    async clearFrameworkSessionRefIfMatches(
        sessionId: string,
        expectedRef: string,
        fence?: TurnExecutionFence
    ): Promise<boolean> {
        if (fence)
            return this.db.transaction(async (tx) => {
                if (!(await lockTurnSessionFence(tx, fence, sessionId)))
                    throw new TurnFenceLostError(fence.messageId)
                const cleared = await tx
                    .update(chatSessions)
                    .set({ frameworkSessionRef: null, updatedAt: new Date() })
                    .where(
                        and(
                            eq(chatSessions.id, sessionId),
                            eq(chatSessions.frameworkSessionRef, expectedRef)
                        )
                    )
                    .returning({ id: chatSessions.id })
                return cleared.length > 0
            })
        const cleared = await this.db
            .update(chatSessions)
            .set({ frameworkSessionRef: null, updatedAt: new Date() })
            .where(
                and(
                    eq(chatSessions.id, sessionId),
                    eq(chatSessions.frameworkSessionRef, expectedRef)
                )
            )
            .returning({ id: chatSessions.id })
        return cleared.length > 0
    }

    async updateTitleIfEmpty(sessionId: string, title: string): Promise<void> {
        await this.db
            .update(chatSessions)
            .set({ title, updatedAt: new Date() })
            .where(
                and(eq(chatSessions.id, sessionId), isNull(chatSessions.title))
            )
    }

    async updateTitle(
        sessionId: string,
        title: string | null
    ): Promise<DbChatSession | null> {
        const [updated] = await this.db
            .update(chatSessions)
            .set({ title, updatedAt: new Date() })
            .where(eq(chatSessions.id, sessionId))
            .returning()
        return updated ?? null
    }

    async insertMessage(row: NewChatMessage): Promise<DbChatMessage> {
        const [created] = await this.db
            .insert(chatMessages)
            .values(sanitizeMessageRow(row))
            .returning()
        return created
    }

    async getMessage(
        sessionId: string,
        messageId: string
    ): Promise<DbChatMessage | null> {
        const rows = await this.db
            .select()
            .from(chatMessages)
            .where(
                and(
                    eq(chatMessages.sessionId, sessionId),
                    eq(chatMessages.id, messageId)
                )
            )
            .limit(1)
        return rows[0] ?? null
    }

    // Append blocks to a message's existing content (e.g. assistant-side
    // attachments produced after the turn's terminal event). Read-modify-write
    // is safe here because it runs after the turn is done — no concurrent
    // writer for this message.
    async appendMessageBlocks(
        messageId: string,
        blocks: ChatContentBlock[]
    ): Promise<void> {
        if (blocks.length === 0) return
        await this.db.transaction(async (tx) => {
            const [row] = await tx
                .select({ blocks: chatMessages.contentBlocksJson })
                .from(chatMessages)
                .where(eq(chatMessages.id, messageId))
                .limit(1)
            if (!row) return
            const existing = Array.isArray(row.blocks)
                ? (row.blocks as ChatContentBlock[])
                : []
            await tx
                .update(chatMessages)
                .set({
                    contentBlocksJson: sanitizeForJsonb([
                        ...existing,
                        ...blocks
                    ])
                })
                .where(eq(chatMessages.id, messageId))
        })
    }

    async rewriteMessageAndDeleteAfter(
        sessionId: string,
        messageId: string,
        contentBlocks: unknown
    ): Promise<RegenerateRewriteResult | null> {
        return this.db.transaction(async (tx) => {
            const rows = await tx
                .select()
                .from(chatMessages)
                .where(eq(chatMessages.sessionId, sessionId))
                .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
            const targetIndex = rows.findIndex((row) => row.id === messageId)
            if (targetIndex === -1) return null

            const deletedMessageIds = rows
                .slice(targetIndex + 1)
                .map((row) => row.id)

            if (deletedMessageIds.length > 0) {
                // Compaction takes message parents before stream rows. Match
                // its id order so a multi-message overlap cannot invert either
                // level of the lock hierarchy.
                await tx
                    .select({ id: chatMessages.id })
                    .from(chatMessages)
                    .where(inArray(chatMessages.id, deletedMessageIds))
                    .orderBy(asc(chatMessages.id))
                    .for('update')
                await tx
                    .delete(chatMessageSources)
                    .where(
                        and(
                            eq(chatMessageSources.sourceKind, 'live_stream'),
                            inArray(
                                chatMessageSources.messageId,
                                deletedMessageIds
                            )
                        )
                    )
                await tx
                    .delete(agentUsageEvents)
                    .where(
                        inArray(agentUsageEvents.messageId, deletedMessageIds)
                    )
                await tx
                    .delete(chatStreamEvents)
                    .where(
                        inArray(chatStreamEvents.messageId, deletedMessageIds)
                    )
                await tx
                    .delete(chatMessages)
                    .where(inArray(chatMessages.id, deletedMessageIds))
            }

            const [updated] = await tx
                .update(chatMessages)
                .set({ contentBlocksJson: sanitizeForJsonb(contentBlocks) })
                .where(
                    and(
                        eq(chatMessages.sessionId, sessionId),
                        eq(chatMessages.id, messageId)
                    )
                )
                .returning()

            await tx
                .update(chatSessions)
                .set({ frameworkSessionRef: null, updatedAt: new Date() })
                .where(eq(chatSessions.id, sessionId))

            await revokeActiveSharesTx(tx, sessionId)

            const historyRows = rows
                .slice(0, targetIndex)
                .concat(updated ? [updated] : [])

            return updated
                ? { userMessage: updated, deletedMessageIds, historyRows }
                : null
        })
    }

    async appendSessionMessages(
        sessionId: string,
        rows: NewChatMessage[]
    ): Promise<{ inserted: number }> {
        if (rows.length === 0) return { inserted: 0 }
        return this.db.transaction(async (tx) => {
            await insertMessagesTx(tx, rows)
            await tx
                .update(chatSessions)
                .set({ updatedAt: new Date() })
                .where(eq(chatSessions.id, sessionId))
            return { inserted: rows.length }
        })
    }

    // The guard re-reads the session's rows inside the transaction: the caller
    // decided to rewrite history based on a snapshot taken before a slow remote
    // read, and anything written in between (a fresh user prompt, a streaming
    // turn) must veto the replace instead of being deleted with the history.
    async replaceSessionMessages(
        sessionId: string,
        rows: NewChatMessage[],
        frameworkSessionRef?: string | null,
        guard?: (existing: DbChatMessage[]) => boolean,
        sources: NewChatMessageSource[] = []
    ): Promise<{
        replaced: number
        conflicted: boolean
        upsertedSources: number
    }> {
        return this.db.transaction(async (tx) => {
            const [session] = await tx
                .select({ inflightMessageId: chatSessions.inflightMessageId })
                .from(chatSessions)
                .where(eq(chatSessions.id, sessionId))
                .limit(1)
                .for('update')
            if (!session || session.inflightMessageId !== null)
                return {
                    replaced: 0,
                    conflicted: true,
                    upsertedSources: 0
                }
            if (guard) {
                const existing = await tx
                    .select()
                    .from(chatMessages)
                    .where(eq(chatMessages.sessionId, sessionId))
                if (!guard(existing))
                    return {
                        replaced: 0,
                        conflicted: true,
                        upsertedSources: 0
                    }
            }
            await tx
                .delete(chatMessages)
                .where(eq(chatMessages.sessionId, sessionId))
            await insertMessagesTx(tx, rows)
            await insertRecoveredTerminalsTx(tx, rows)
            await upsertMessageSourcesTx(tx, sources)
            await tx
                .update(chatSessions)
                .set({
                    ...(frameworkSessionRef !== undefined
                        ? { frameworkSessionRef }
                        : {}),
                    updatedAt: new Date()
                })
                .where(eq(chatSessions.id, sessionId))
            await revokeActiveSharesTx(tx, sessionId)
            return {
                replaced: rows.length,
                conflicted: false,
                upsertedSources: sources.length
            }
        })
    }

    async createSessionWithRecoveredMessages(input: {
        session: NewChatSession
        messages: NewChatMessage[]
        sources: NewChatMessageSource[]
    }): Promise<{ session: DbChatSession; upsertedSources: number }> {
        return this.db.transaction(async (tx) => {
            const [created] = await tx
                .insert(chatSessions)
                .values(input.session)
                .returning()
            await insertMessagesTx(tx, input.messages)
            await insertRecoveredTerminalsTx(tx, input.messages)
            await upsertMessageSourcesTx(tx, input.sources)
            return { session: created, upsertedSources: input.sources.length }
        })
    }

    // Append recovered messages onto an EXISTING session without disturbing
    // what is already there — used to fold a terminal TUI's own transcript
    // back into the cloud session. Locks the session and refuses while a live
    // turn holds it, the same idle contract as replaceSessionMessages; the
    // caller guarantees idempotency by only passing the diff against the
    // current cloud messages.
    async appendRecoveredMessages(
        sessionId: string,
        rows: NewChatMessage[],
        sources: NewChatMessageSource[]
    ): Promise<{
        appended: number
        conflicted: boolean
        upsertedSources: number
    }> {
        if (rows.length === 0)
            return { appended: 0, conflicted: false, upsertedSources: 0 }
        return this.db.transaction(async (tx) => {
            const [session] = await tx
                .select({ inflightMessageId: chatSessions.inflightMessageId })
                .from(chatSessions)
                .where(eq(chatSessions.id, sessionId))
                .limit(1)
                .for('update')
            if (!session || session.inflightMessageId !== null)
                return { appended: 0, conflicted: true, upsertedSources: 0 }

            // Idempotency: message rows carry random ids, so only the stable
            // per-transcript-line source_event_key can tell a re-sync from a
            // fresh one. Under the session lock, drop any message whose key is
            // already stored — this makes the append safe to fire on every
            // switch-back and to overlap (the lock serializes; the second sync
            // sees the first's keys) without ever duplicating a terminal
            // message.
            const incomingKeys = [
                ...new Set(
                    sources
                        .map((source) => source.sourceEventKey)
                        .filter((key): key is string => key != null)
                )
            ]
            const existingRows = incomingKeys.length
                ? await tx
                      .select({
                          sourceEventKey: chatMessageSources.sourceEventKey
                      })
                      .from(chatMessageSources)
                      .where(
                          and(
                              eq(chatMessageSources.sessionId, sessionId),
                              inArray(
                                  chatMessageSources.sourceEventKey,
                                  incomingKeys
                              )
                          )
                      )
                : []
            const existingKeys = new Set(
                existingRows
                    .map((row) => row.sourceEventKey)
                    .filter((key): key is string => key != null)
            )
            const { messageRows, sourceRows } = dedupRecoveredRowsBySourceKey(
                rows,
                sources,
                existingKeys
            )
            if (messageRows.length === 0)
                return { appended: 0, conflicted: false, upsertedSources: 0 }

            await insertMessagesTx(tx, messageRows)
            await insertRecoveredTerminalsTx(tx, messageRows)
            await upsertMessageSourcesTx(tx, sourceRows)
            await tx
                .update(chatSessions)
                .set({ updatedAt: new Date() })
                .where(eq(chatSessions.id, sessionId))
            return {
                appended: messageRows.length,
                conflicted: false,
                upsertedSources: sourceRows.length
            }
        })
    }

    async upsertMessageSources(
        rows: NewChatMessageSource[],
        fence?: TurnExecutionFence
    ): Promise<{ upserted: number; fenceLost: boolean }> {
        if (rows.length === 0) return { upserted: 0, fenceLost: false }
        const sessionId = rows[0].sessionId
        if (
            fence &&
            rows.some(
                (row) =>
                    row.messageId !== fence.messageId ||
                    row.sessionId !== sessionId
            )
        )
            return { upserted: 0, fenceLost: true }
        return this.db.transaction(async (tx) => {
            // The source cache is what an adoption rebuilds its seen-state
            // from, so a stale carrier writing into it after the handover
            // teaches the new owner that lines it never delivered are already
            // delivered. The locked check makes the upsert and takeover choose
            // one commit order.
            if (fence && !(await lockTurnSessionFence(tx, fence, sessionId)))
                return { upserted: 0, fenceLost: true }
            await upsertMessageSourcesTx(tx, rows)
            return { upserted: rows.length, fenceLost: false }
        })
    }

    async upsertMessageSourcesForIdleSession(
        sessionId: string,
        rows: NewChatMessageSource[],
        frameworkSessionRef?: string
    ): Promise<{ upserted: number; conflicted: boolean }> {
        if (rows.length === 0 && frameworkSessionRef === undefined)
            return { upserted: 0, conflicted: false }
        return this.db.transaction(async (tx) => {
            const [session] = await tx
                .select({ inflightMessageId: chatSessions.inflightMessageId })
                .from(chatSessions)
                .where(eq(chatSessions.id, sessionId))
                .limit(1)
                .for('update')
            if (!session || session.inflightMessageId !== null)
                return { upserted: 0, conflicted: true }
            await upsertMessageSourcesTx(tx, rows)
            if (frameworkSessionRef !== undefined)
                await tx
                    .update(chatSessions)
                    .set({ frameworkSessionRef, updatedAt: new Date() })
                    .where(eq(chatSessions.id, sessionId))
            return { upserted: rows.length, conflicted: false }
        })
    }

    async listMessageSources(
        sessionId: string
    ): Promise<DbChatMessageSource[]> {
        return this.db
            .select()
            .from(chatMessageSources)
            .where(eq(chatMessageSources.sessionId, sessionId))
            .orderBy(
                asc(chatMessageSources.sourceSeq),
                asc(chatMessageSources.createdAt)
            )
    }

    // How far a runner stream may be resumed for this turn. Skipping ahead is
    // only safe where BOTH hold, which is why this is not simply max(runner_seq):
    //
    //   1. the transport chunk ended on a line boundary — runner_seq is stamped
    //      only on such lines, because a chunk that ends mid-line also holds the
    //      HEAD of the next line, and resuming past it would deliver that line
    //      truncated (it would fail to parse and vanish silently);
    //   2. the events derived from it are already in chat_stream_events — token
    //      events are coalesced in the broadcaster, so a durable source row does
    //      NOT imply its events were written. Rows are written in emit order, so
    //      one durable event for a line proves everything emitted before that
    //      line is durable; we therefore stop short of the newest such line.
    //
    // 0 = no safe cursor, replay the whole turn (the historical behaviour).
    async safeResumeSeqForMessage(messageId: string): Promise<number> {
        const [row] = await this.db
            .select({
                value: sql<number | null>`max(${chatMessageSources.runnerSeq})`
            })
            .from(chatMessageSources)
            .where(
                and(
                    eq(chatMessageSources.messageId, messageId),
                    isNotNull(chatMessageSources.runnerSeq),
                    sql`${chatMessageSources.sourceSeq} < (
                        select coalesce(max(s.source_seq), 0)
                        from ${chatMessageSources} s
                        join ${chatStreamEvents} e
                          on e.source_event_key = s.source_event_key
                        where s.message_id = ${messageId}
                    )`
                )
            )
            .limit(1)
        return row?.value ?? 0
    }

    // Was this daemon seen within the window? Used where "online right now" is
    // the wrong question — immediately after an api restart nothing is online,
    // yet the daemon is about to re-dial and resume its turn.
    async daemonSeenWithin(
        daemonId: string | null,
        withinMs: number
    ): Promise<boolean> {
        if (!daemonId) return false
        const cutoff = new Date(Date.now() - withinMs)
        const [row] = await this.db
            .select({ id: runtimeHosts.id })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.id, daemonId),
                    or(
                        gt(runtimeHosts.rpcLastSeenAt, cutoff),
                        gt(runtimeHosts.lastSeenAt, cutoff)
                    )
                )
            )
            .limit(1)
        return !!row
    }

    // #674. Derive a bounded resume-attempt ordinal from durable transitions,
    // not process memory or a raw suspension count. If the newest suspension is
    // later than the newest persisted resuming status, advance once; otherwise
    // reuse that status's ordinal. That makes adjacent duplicate suspension
    // rows from today's unfenced cross-replica writers one presentation attempt
    // instead of several, while instances observing the same snapshot still
    // derive the same unique-index identity. Ownership, late stale writers and
    // their ordering stay #570.
    //
    // The suspension probe reads newest-first through (message_id, id). The
    // status aggregate is bounded by the five-row source-key identity in this
    // caller. max(id) tracks the latest status transition while max(ordinal)
    // preserves the monotonic bounded identity.
    async boundedResumeStatusOrdinal(
        messageId: string,
        sourceEventKey: string,
        maxOrdinal: number
    ): Promise<number> {
        if (maxOrdinal <= 0) return 0
        const rows = (await this.db.execute(sql`
            with latest_resume as (
                select max(id) as id,
                       max(source_event_ordinal) as ordinal
                from chat_stream_events
                where message_id = ${messageId}
                  and event_type = 'turn_status'
                  and source_event_key = ${sourceEventKey}
                  and source_event_ordinal is not null
            ), latest_suspension as (
                select id
                from chat_stream_events
                where message_id = ${messageId}
                  and event_type = 'suspended'
                order by id desc
                limit 1
            )
            select case
                when r.ordinal is null then 0
                when s.id is not null and s.id > r.id then
                    least(r.ordinal + 1, ${maxOrdinal})
                else least(r.ordinal, ${maxOrdinal})
            end::integer as value
            from (select 1) seed
            left join latest_resume r on true
            left join latest_suspension s on true
        `)) as unknown as Array<{ value: number }>
        return rows[0]?.value ?? 0
    }

    // The EXACT resume cursor, for turns whose output is token-level. Unlike
    // safeResumeSeqForMessage it needs no "stop one short" hedge, because the
    // watermark lives on the durable rows themselves: a row carrying seq S was
    // written after everything through S had been emitted, and rows land in emit
    // order, so a durable row proves all content through S is durable. Nothing
    // is skipped and nothing is re-sent.
    //
    // Both properties are required for a delta stream. Its rows are identified
    // by (source_event_key, ordinal), and the broadcaster's merge boundaries
    // shift between runs, so a re-sent delta row can collide with a row holding
    // DIFFERENT text and be dropped by the unique index — losing content. A
    // conservative cursor is therefore not safe here, only an exact one.
    async exactResumeSeqForMessage(messageId: string): Promise<number> {
        const [row] = await this.db
            .select({
                value: sql<number | null>`max(${chatStreamEvents.runnerSeq})`
            })
            .from(chatStreamEvents)
            .where(
                and(
                    eq(chatStreamEvents.messageId, messageId),
                    isNotNull(chatStreamEvents.runnerSeq)
                )
            )
            .limit(1)
        return row?.value ?? 0
    }

    // Per-message raw source rows in commit order — the seen-state input for
    // cross-process turn adoption (reconstructs delivered uuids + covered text).
    async listMessageSourceRows(
        messageId: string
    ): Promise<
        Array<{ rawText: string; externalId: string | null; sourceSeq: number }>
    > {
        const rows = await this.db
            .select({
                rawText: chatMessageSources.rawText,
                externalId: chatMessageSources.externalId,
                sourceSeq: chatMessageSources.sourceSeq
            })
            .from(chatMessageSources)
            .where(eq(chatMessageSources.messageId, messageId))
            .orderBy(asc(chatMessageSources.sourceSeq))
        return rows.map((r) => ({
            rawText: r.rawText ?? '',
            externalId: r.externalId,
            sourceSeq: r.sourceSeq
        }))
    }

    // Transcript-line uuids already owned by OTHER messages in this session.
    // An adopted turn must never emit one of these: a recovery that anchors at
    // a doppelgänger prompt (same text, earlier turn) while this turn's own
    // user line is not yet on disk would otherwise silently replay a previous
    // turn's content under the adopted message id. Identity check — no clocks.
    async listForeignSourceUuids(
        sessionId: string,
        excludeMessageId: string
    ): Promise<Set<string>> {
        const rows = await this.db
            .select({ externalId: chatMessageSources.externalId })
            .from(chatMessageSources)
            .where(
                and(
                    eq(chatMessageSources.sessionId, sessionId),
                    isNotNull(chatMessageSources.externalId),
                    ne(chatMessageSources.messageId, excludeMessageId)
                )
            )
        const uuids = new Set<string>()
        for (const row of rows) if (row.externalId) uuids.add(row.externalId)
        return uuids
    }

    async listMessages(sessionId: string): Promise<DbChatMessage[]> {
        return this.db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.sessionId, sessionId))
            .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    }

    async listMessagesWithUsage(sessionId: string): Promise<
        Array<{
            message: DbChatMessage
            usage: AgentUsageEventRow | null
        }>
    > {
        const rows = await this.db
            .select({
                message: chatMessages,
                usage: agentUsageEvents
            })
            .from(chatMessages)
            .leftJoin(
                agentUsageEvents,
                eq(agentUsageEvents.messageId, chatMessages.id)
            )
            .where(eq(chatMessages.sessionId, sessionId))
            .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
        return rows.map((r) => ({ message: r.message, usage: r.usage }))
    }

    // `notAfter` is an inclusive upper bound on (createdAt, id): chat session
    // shares use it to freeze the public transcript at the share-time cutoff.
    async listMessagePageWithUsage(
        sessionId: string,
        opts: {
            limit: number
            before?: MessageCursor | null
            notAfter?: MessageCursor | null
        }
    ): Promise<
        Array<{
            message: DbChatMessage
            usage: AgentUsageEventRow | null
        }>
    > {
        const before = opts.before ?? null
        const notAfter = opts.notAfter ?? null
        const conditions: SQL[] = [eq(chatMessages.sessionId, sessionId)]
        if (before) {
            const beforeCond = or(
                lt(chatMessages.createdAt, before.createdAt),
                and(
                    eq(chatMessages.createdAt, before.createdAt),
                    lt(chatMessages.id, before.id)
                )
            )
            if (beforeCond) conditions.push(beforeCond)
        }
        if (notAfter) {
            const notAfterCond = or(
                lt(chatMessages.createdAt, notAfter.createdAt),
                and(
                    eq(chatMessages.createdAt, notAfter.createdAt),
                    lte(chatMessages.id, notAfter.id)
                )
            )
            if (notAfterCond) conditions.push(notAfterCond)
        }
        const rows = await this.db
            .select({
                message: chatMessages,
                usage: agentUsageEvents
            })
            .from(chatMessages)
            .leftJoin(
                agentUsageEvents,
                eq(agentUsageEvents.messageId, chatMessages.id)
            )
            .where(and(...conditions))
            .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
            .limit(opts.limit)
        return rows.map((r) => ({ message: r.message, usage: r.usage }))
    }

    async latestMessageCursor(
        sessionId: string,
        opts: { excludeMessageId?: string | null } = {}
    ): Promise<MessageCursor | null> {
        const excludeMessageId = opts.excludeMessageId ?? null
        const rows = await this.db
            .select({
                id: chatMessages.id,
                createdAt: chatMessages.createdAt
            })
            .from(chatMessages)
            .where(
                excludeMessageId
                    ? and(
                          eq(chatMessages.sessionId, sessionId),
                          ne(chatMessages.id, excludeMessageId)
                      )
                    : eq(chatMessages.sessionId, sessionId)
            )
            .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
            .limit(1)
        return rows[0] ?? null
    }

    // Public /v1/conversations/{id}/messages page: like listMessagePageWithUsage
    // but with an OpenAI-style `after` cursor + selectable direction. Orders
    // DIRECTLY by created_at + id (no post-hoc reverse), so the caller emits
    // rows in `order` without re-sorting.
    async listSessionMessagesPageWithUsage(
        sessionId: string,
        opts: {
            limit: number
            after?: MessageCursor | null
            order: 'asc' | 'desc'
        }
    ): Promise<
        Array<{
            message: DbChatMessage
            usage: AgentUsageEventRow | null
        }>
    > {
        const after = opts.after ?? null
        const rows = await this.db
            .select({
                message: chatMessages,
                usage: agentUsageEvents
            })
            .from(chatMessages)
            .leftJoin(
                agentUsageEvents,
                eq(agentUsageEvents.messageId, chatMessages.id)
            )
            .where(
                and(
                    eq(chatMessages.sessionId, sessionId),
                    after
                        ? afterCondition(
                              chatMessages.createdAt,
                              chatMessages.id,
                              after,
                              opts.order
                          )
                        : undefined
                )
            )
            .orderBy(
                opts.order === 'asc'
                    ? asc(chatMessages.createdAt)
                    : desc(chatMessages.createdAt),
                opts.order === 'asc'
                    ? asc(chatMessages.id)
                    : desc(chatMessages.id)
            )
            .limit(opts.limit)
        return rows.map((r) => ({ message: r.message, usage: r.usage }))
    }

    async sessionHasMessages(sessionId: string): Promise<boolean> {
        const rows = await this.db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(eq(chatMessages.sessionId, sessionId))
            .limit(1)
        return rows.length > 0
    }

    async terminalErrorsForMessages(
        messageIds: string[]
    ): Promise<Map<string, Record<string, unknown>>> {
        if (messageIds.length === 0) return new Map()
        const rows = await this.db
            .selectDistinctOn([chatStreamEvents.messageId], {
                messageId: chatStreamEvents.messageId,
                payloadJson: chatStreamEvents.payloadJson
            })
            .from(chatStreamEvents)
            .where(
                and(
                    inArray(chatStreamEvents.messageId, messageIds),
                    eq(chatStreamEvents.eventType, 'error')
                )
            )
            .orderBy(chatStreamEvents.messageId, desc(chatStreamEvents.id))
        const map = new Map<string, Record<string, unknown>>()
        for (const row of rows)
            map.set(row.messageId, row.payloadJson as Record<string, unknown>)
        return map
    }

    async listAdminSessionsPage(opts: {
        limit: number
        after: AdminSessionCursor | null
        agentId: string | null
        userId: string | null
        running: boolean
        hasError: boolean
        idEquals: string | null
        titleQuery: string | null
    }): Promise<AdminSessionRow[]> {
        return this.db
            .select({
                session: chatSessions,
                userEmail: users.email,
                userDisplayName: users.displayName,
                agentName: agents.name,
                agentFramework: agents.framework,
                agentRuntime: agents.runtime
            })
            .from(chatSessions)
            .leftJoin(users, eq(chatSessions.userId, users.id))
            .leftJoin(agents, eq(chatSessions.agentId, agents.id))
            .where(
                and(
                    opts.agentId
                        ? eq(chatSessions.agentId, opts.agentId)
                        : undefined,
                    opts.userId
                        ? eq(chatSessions.userId, opts.userId)
                        : undefined,
                    opts.running
                        ? isNotNull(chatSessions.inflightMessageId)
                        : undefined,
                    opts.hasError
                        ? exists(
                              this.db
                                  .select({ one: sql`1` })
                                  .from(chatStreamEvents)
                                  .where(
                                      and(
                                          eq(
                                              chatStreamEvents.sessionId,
                                              chatSessions.id
                                          ),
                                          eq(
                                              chatStreamEvents.eventType,
                                              'error'
                                          )
                                      )
                                  )
                          )
                        : undefined,
                    opts.idEquals
                        ? eq(chatSessions.id, opts.idEquals)
                        : undefined,
                    opts.titleQuery
                        ? ilike(chatSessions.title, likeNeedle(opts.titleQuery))
                        : undefined,
                    opts.after
                        ? afterCondition(
                              chatSessions.updatedAt,
                              chatSessions.id,
                              {
                                  createdAt: opts.after.updatedAt,
                                  id: opts.after.id
                              },
                              'desc'
                          )
                        : undefined
                )
            )
            .orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id))
            .limit(opts.limit)
    }

    async sessionMessageStats(
        sessionIds: string[]
    ): Promise<
        Map<string, { messageCount: number; lastMessageAt: Date | null }>
    > {
        if (sessionIds.length === 0) return new Map()
        const rows = await this.db
            .select({
                sessionId: chatMessages.sessionId,
                messageCount: count(),
                lastMessageAt: max(chatMessages.createdAt)
            })
            .from(chatMessages)
            .where(inArray(chatMessages.sessionId, sessionIds))
            .groupBy(chatMessages.sessionId)
        return new Map(
            rows.map((r) => [
                r.sessionId,
                {
                    messageCount: Number(r.messageCount),
                    lastMessageAt: r.lastMessageAt
                }
            ])
        )
    }

    async adminSessionUsageSums(sessionIds: string[]): Promise<
        Map<
            string,
            {
                inputTokens: number
                outputTokens: number
                costUsd: number | null
            }
        >
    > {
        if (sessionIds.length === 0) return new Map()
        const rows = await this.db
            .select({
                sessionId: agentUsageEvents.sessionId,
                inputTokens: sql<string>`coalesce(sum(${agentUsageEvents.inputTokens}), 0)`,
                outputTokens: sql<string>`coalesce(sum(${agentUsageEvents.outputTokens}), 0)`,
                costUsd: sql<string | null>`sum(${agentUsageEvents.costUsd})`
            })
            .from(agentUsageEvents)
            .where(inArray(agentUsageEvents.sessionId, sessionIds))
            .groupBy(agentUsageEvents.sessionId)
        const map = new Map<
            string,
            {
                inputTokens: number
                outputTokens: number
                costUsd: number | null
            }
        >()
        for (const row of rows) {
            if (row.sessionId === null) continue
            map.set(row.sessionId, {
                inputTokens: Number(row.inputTokens),
                outputTokens: Number(row.outputTokens),
                costUsd: row.costUsd === null ? null : Number(row.costUsd)
            })
        }
        return map
    }

    async latestTurnExecutionsBySession(
        sessionIds: string[]
    ): Promise<Map<string, TurnExecutionRow>> {
        if (sessionIds.length === 0) return new Map()
        const rows = await this.db
            .selectDistinctOn([turnExecutions.sessionId])
            .from(turnExecutions)
            .where(inArray(turnExecutions.sessionId, sessionIds))
            .orderBy(
                turnExecutions.sessionId,
                desc(turnExecutions.createdAt),
                desc(turnExecutions.messageId)
            )
        return new Map(rows.map((r) => [r.sessionId, r]))
    }

    // Runtimes outside the durable execution protocol have no turn_executions
    // row, so their failures are visible only on the latest assistant message.
    async latestAssistantMessagesBySession(
        sessionIds: string[]
    ): Promise<Map<string, DbChatMessage>> {
        if (sessionIds.length === 0) return new Map()
        const rows = await this.db
            .selectDistinctOn([chatMessages.sessionId])
            .from(chatMessages)
            .where(
                and(
                    inArray(chatMessages.sessionId, sessionIds),
                    eq(chatMessages.role, 'assistant')
                )
            )
            .orderBy(
                chatMessages.sessionId,
                desc(chatMessages.createdAt),
                desc(chatMessages.id)
            )
        return new Map(rows.map((r) => [r.sessionId, r]))
    }

    async listTurnExecutionsByMessageIds(
        messageIds: string[]
    ): Promise<TurnExecutionRow[]> {
        if (messageIds.length === 0) return []
        return this.db
            .select()
            .from(turnExecutions)
            .where(inArray(turnExecutions.messageId, messageIds))
    }

    async listAssistantTurnsWithUsage(
        sessionId: string,
        limit: number
    ): Promise<
        Array<{
            message: DbChatMessage
            usage: AgentUsageEventRow | null
        }>
    > {
        const rows = await this.db
            .select({
                message: chatMessages,
                usage: agentUsageEvents
            })
            .from(chatMessages)
            .leftJoin(
                agentUsageEvents,
                eq(agentUsageEvents.messageId, chatMessages.id)
            )
            .where(
                and(
                    eq(chatMessages.sessionId, sessionId),
                    eq(chatMessages.role, 'assistant')
                )
            )
            .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
            .limit(limit)
        return rows.map((r) => ({ message: r.message, usage: r.usage }))
    }

    async countSessionEventsByType(
        sessionId: string
    ): Promise<Record<string, number>> {
        const rows = await this.db
            .select({
                eventType: chatStreamEvents.eventType,
                total: count()
            })
            .from(chatStreamEvents)
            .where(eq(chatStreamEvents.sessionId, sessionId))
            .groupBy(chatStreamEvents.eventType)
        const counts: Record<string, number> = {}
        for (const row of rows) counts[row.eventType] = Number(row.total)
        return counts
    }

    async listAdminSessionStreamEvents(
        sessionId: string,
        opts: {
            limit: number
            afterId: bigint | null
            order: 'asc' | 'desc'
            types: string[] | null
            messageId: string | null
        }
    ): Promise<Array<typeof chatStreamEvents.$inferSelect>> {
        const types = opts.types as
            | (typeof chatStreamEvents.$inferSelect)['eventType'][]
            | null
        return this.db
            .select()
            .from(chatStreamEvents)
            .where(
                and(
                    eq(chatStreamEvents.sessionId, sessionId),
                    opts.messageId
                        ? eq(chatStreamEvents.messageId, opts.messageId)
                        : undefined,
                    types && types.length > 0
                        ? inArray(chatStreamEvents.eventType, types)
                        : undefined,
                    opts.afterId === null
                        ? undefined
                        : opts.order === 'asc'
                          ? gt(chatStreamEvents.id, opts.afterId)
                          : lt(chatStreamEvents.id, opts.afterId)
                )
            )
            .orderBy(
                opts.order === 'asc'
                    ? asc(chatStreamEvents.id)
                    : desc(chatStreamEvents.id)
            )
            .limit(opts.limit)
    }

    async listFirstUserMessages(
        sessionIds: string[]
    ): Promise<DbChatMessage[]> {
        if (sessionIds.length === 0) return []
        return this.db
            .selectDistinctOn([chatMessages.sessionId])
            .from(chatMessages)
            .where(
                and(
                    inArray(chatMessages.sessionId, sessionIds),
                    eq(chatMessages.role, 'user')
                )
            )
            .orderBy(chatMessages.sessionId, asc(chatMessages.createdAt))
    }

    async insertStreamEvent(
        row: NewChatStreamEventRow,
        terminalContent?: TerminalStreamContent,
        fence?: TurnExecutionFence
    ): Promise<{ id: bigint | null; fenceLost: boolean }> {
        if (fence && fence.messageId !== row.messageId)
            return { id: null, fenceLost: true }
        // Serialize inserts per session so event ids commit in order;
        // cross-instance pumps advance an id cursor and would silently
        // skip a lower id that commits after a higher one.
        //
        // A non-terminal row needs nothing but that ordering, so it takes the
        // lock and writes the row in a single statement rather than the four
        // (BEGIN / lock / INSERT / COMMIT) this used to cost — 6 protocol
        // exchanges down to 2, see nonTerminalStreamEventInsert. This is the
        // whole streaming hot path: one row per 120ms token-merge window per
        // live turn, plus one per tool_call and tool_result.
        if (row.eventType !== 'done' && row.eventType !== 'error') {
            const created = (await this.db.execute(
                nonTerminalStreamEventInsert(row, fence)
            )) as unknown as Array<{ id: string | number | bigint }>
            // No row back means ON CONFLICT DO NOTHING dropped it. Callers read
            // that null as "deduped away" — sse-broadcaster reports `persisted`
            // from it and the turn_status emitter gates on it — so it must stay
            // distinguishable from a real id.
            const id = created[0]?.id
            if (id !== undefined) return { id: BigInt(id), fenceLost: false }
            // The statement's own predicate already rejected the row
            // atomically; this only classifies WHY, for a caller that has to
            // choose between "keep streaming" and "stop, someone else owns
            // this turn". Sound as a follow-up read because generation is
            // monotonic: once it moved past ours it never comes back, so a
            // fence that reads stale here was already stale at insert time.
            // Off the hot path — a non-terminal row that lands returns above.
            return {
                id: null,
                fenceLost: fence ? !(await this.turnFenceHolds(fence)) : false
            }
        }
        // A terminal row keeps the explicit transaction. It is the single
        // chokepoint where the row, the cleared inflight claim and the closed
        // turn_executions record have to become visible together.
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext('chat_stream_events'), hashtext(${row.sessionId}))`
            )
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext('chat_message_content'), hashtext(${row.messageId}))`
            )
            // Ahead of the existing-terminal probe: a stale writer must learn
            // it lost the turn, not that someone else already closed it. The
            // tuple lock is held through the terminal row, final content,
            // session release and execution close, so a takeover can only
            // linearize wholly before or wholly after this transaction.
            if (fence) {
                if (!(await lockTurnSessionFence(tx, fence, row.sessionId)))
                    return { id: null, fenceLost: true }
            } else {
                // Reconciliation paths that genuinely have no execution row
                // remain supported. If an owner exists, however, an unfenced
                // boot/subscribe/cancel writer has no authority to close it.
                // upsertTurnExecution takes the same stream advisory lock, so
                // the absent-row case cannot race a first stamp into the gap.
                const execution = await lockTurnExecution(tx, row.messageId)
                if (
                    execution &&
                    execution.state !== 'done' &&
                    execution.state !== 'failed'
                )
                    return { id: null, fenceLost: true }
            }
            const [existingTerminal] = await tx
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(
                    and(
                        eq(chatStreamEvents.messageId, row.messageId),
                        inArray(chatStreamEvents.eventType, ['done', 'error'])
                    )
                )
                .limit(1)
            if (existingTerminal) return { id: null, fenceLost: false }
            let id: bigint | null
            const terminalRow = {
                ...row,
                // The caller's seq was sampled before this transaction took
                // the per-session lock. A peer can commit an already-admitted
                // row in that gap, so derive the terminal's seq under the
                // lock or the winning terminal can collide with that row.
                seq: sql<number>`coalesce((
                    select max(${chatStreamEvents.seq})
                    from ${chatStreamEvents}
                    where ${chatStreamEvents.messageId} = ${row.messageId}
                ), 0) + 1`
            }
            if (row.sourceEventKey == null) {
                const created = await tx
                    .insert(chatStreamEvents)
                    .values(terminalRow)
                    .returning({ id: chatStreamEvents.id })
                id = created[0]?.id ?? null
            } else {
                const created = await tx
                    .insert(chatStreamEvents)
                    .values(terminalRow)
                    .onConflictDoNothing({
                        target: [
                            chatStreamEvents.messageId,
                            chatStreamEvents.sourceEventKey,
                            chatStreamEvents.sourceEventOrdinal
                        ],
                        where: sql`${chatStreamEvents.sourceEventKey} is not null`
                    })
                    .returning({ id: chatStreamEvents.id })
                id = created[0]?.id ?? null
            }
            // A source-key collision with a non-terminal row inserted no
            // terminal. It must be side-effect-free: clearing the claim or
            // replacing final content here would make a live turn look closed
            // without the durable row that recovery and telemetry require.
            if (id === null) return { id: null, fenceLost: false }
            {
                const content = terminalContent ?? { replayFromStream: true }
                let resolvedContent: Exclude<
                    TerminalStreamContent,
                    { replayFromStream: true }
                >
                if ('replayFromStream' in content) {
                    const contentRows = await tx
                        .select({
                            id: chatStreamEvents.id,
                            eventType: chatStreamEvents.eventType,
                            payloadJson: chatStreamEvents.payloadJson
                        })
                        .from(chatStreamEvents)
                        .where(
                            and(
                                eq(chatStreamEvents.messageId, row.messageId),
                                inArray(chatStreamEvents.eventType, [
                                    'token',
                                    'thinking',
                                    'tool_call',
                                    'tool_result',
                                    'replace'
                                ])
                            )
                        )
                        .orderBy(asc(chatStreamEvents.id))
                    const blocks = createAssistantBlockBuffer(
                        this.logger,
                        row.messageId,
                        contentRows.map((contentRow) => ({
                            id: BigInt(contentRow.id),
                            eventType: contentRow.eventType,
                            payloadJson: contentRow.payloadJson
                        }))
                    )
                    blocks.endInput()
                    resolvedContent = {
                        contentBlocksJson: blocks.blocks,
                        contentCheckpointEventId: null
                    }
                } else resolvedContent = content
                await tx
                    .update(chatMessages)
                    .set(resolvedContent)
                    .where(eq(chatMessages.id, row.messageId))
            }
            // Release the per-session turn lock when this turn terminates. Every
            // terminalization path (normal done/error, bootstrap orphan reconcile,
            // dead-turn sweep) funnels its done/error event through here, so this
            // is the single chokepoint that clears the claim — keyed by the message
            // id stored at claim time so it never clears a newer turn's claim.
            if (row.eventType === 'done' || row.eventType === 'error') {
                await tx
                    .update(chatSessions)
                    .set({ inflightMessageId: null, updatedAt: new Date() })
                    .where(
                        and(
                            eq(chatSessions.id, row.sessionId),
                            eq(chatSessions.inflightMessageId, row.messageId)
                        )
                    )
                // Close the execution record in the same transaction so a turn
                // is never both terminal and adoptable. No-op for turns without
                // a record — only recoverable remote and daemon-carried turns
                // get one.
                await tx
                    .update(turnExecutions)
                    .set({
                        state: row.eventType === 'done' ? 'done' : 'failed',
                        updatedAt: new Date()
                    })
                    .where(
                        fence
                            ? and(
                                  eq(turnExecutions.messageId, row.messageId),
                                  eq(turnExecutions.ownerId, fence.ownerId),
                                  eq(
                                      turnExecutions.generation,
                                      fence.generation
                                  )
                              )
                            : eq(turnExecutions.messageId, row.messageId)
                    )
            }
            return { id, fenceLost: false }
        })
    }

    // Does the writer still hold the turn? Only the current (owner, generation)
    // of the execution row passes. A turn with no row has no owner to lose it
    // to and is not fenced, so callers pass no fence for one.
    async turnFenceHolds(fence: TurnExecutionFence): Promise<boolean> {
        return fenceHolds(this.db as unknown as DatabaseTx, fence)
    }

    // Atomically claim the session's single turn slot. Returns true if claimed
    // (idle -> messageId), false if another turn already holds it. Cross-instance
    // safe via the compare-and-set against a NULL inflight_message_id.
    async claimInflightTurn(
        sessionId: string,
        messageId: string
    ): Promise<boolean> {
        const claimed = await this.db
            .update(chatSessions)
            .set({ inflightMessageId: messageId, updatedAt: new Date() })
            .where(
                and(
                    eq(chatSessions.id, sessionId),
                    isNull(chatSessions.inflightMessageId)
                )
            )
            .returning({ id: chatSessions.id })
        return claimed.length > 0
    }

    // Release a claim we hold (matched by messageId so a late release can never
    // clear a newer turn's claim). Used when turn setup fails after claiming.
    async releaseInflightTurn(
        sessionId: string,
        messageId: string,
        fence?: TurnExecutionFence
    ): Promise<boolean> {
        if (fence && fence.messageId !== messageId) return false
        if (fence)
            return this.db.transaction(async (tx) => {
                await tx.execute(
                    sql`select pg_advisory_xact_lock(hashtext('chat_stream_events'), hashtext(${sessionId}))`
                )
                if (!(await lockTurnSessionFence(tx, fence, sessionId)))
                    return false
                const rows = await tx
                    .update(chatSessions)
                    .set({ inflightMessageId: null, updatedAt: new Date() })
                    .where(
                        and(
                            eq(chatSessions.id, sessionId),
                            eq(chatSessions.inflightMessageId, messageId)
                        )
                    )
                    .returning({ id: chatSessions.id })
                return rows.length > 0
            })
        const rows = await this.db
            .update(chatSessions)
            .set({ inflightMessageId: null, updatedAt: new Date() })
            .where(
                and(
                    eq(chatSessions.id, sessionId),
                    eq(chatSessions.inflightMessageId, messageId)
                )
            )
            .returning({ id: chatSessions.id })
        return rows.length > 0
    }

    // Bootstrap safety net: clear claims whose message no longer exists or already
    // has a terminal event (e.g. a crash between claim and the first stream event).
    // Never clears a claim pointing at a live inflight message. The `updated_at` age
    // gate additionally protects the brief claim-before-user-message-insert window on
    // ANOTHER live instance: a just-claimed session has a fresh updated_at and so is
    // never swept here, even though its assistant message row does not exist yet.
    async clearStaleInflightClaims(): Promise<number> {
        const cleared = await this.db
            .update(chatSessions)
            .set({ inflightMessageId: null, updatedAt: new Date() })
            .where(
                and(
                    isNotNull(chatSessions.inflightMessageId),
                    lt(
                        chatSessions.updatedAt,
                        sql`now() - interval '15 minutes'`
                    ),
                    notExists(
                        this.db
                            .select({ one: sql`1` })
                            .from(chatMessages)
                            .where(
                                and(
                                    eq(
                                        chatMessages.id,
                                        chatSessions.inflightMessageId
                                    ),
                                    notExists(
                                        this.db
                                            .select({ one: sql`1` })
                                            .from(chatStreamEvents)
                                            .where(
                                                and(
                                                    eq(
                                                        chatStreamEvents.messageId,
                                                        chatMessages.id
                                                    ),
                                                    inArray(
                                                        chatStreamEvents.eventType,
                                                        ['done', 'error']
                                                    )
                                                )
                                            )
                                    )
                                )
                            )
                    )
                )
            )
            .returning({ id: chatSessions.id })
        return cleared.length
    }

    // --- turn execution records + per-turn lease (adoption) ---

    // Called at turn start. A first dispatch may only create generation 1; it
    // never reuses or takes an existing execution, even if owner_id happens to
    // match. Resume/adoption are the only ownership transitions and use their
    // generation-bumping claim CASes, so a repeated initial stamp cannot create
    // two carriers under the same token.
    async upsertTurnExecution(row: {
        messageId: string
        sessionId: string
        agentId: string
        runtime: 'sprites' | 'daemon' | 'k8s' | 'external'
        spriteName?: string | null
        ownerId: string
        leaseSeconds: number
    }): Promise<TurnExecutionFence | null> {
        const now = new Date()
        return this.db.transaction(async (tx) => {
            // The same first lock as event/terminal writes. It closes the only
            // gap a row lock cannot: an unfenced reconciler observing that no
            // execution tuple exists while the first owner inserts one.
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext('chat_stream_events'), hashtext(${row.sessionId}))`
            )
            const [terminal] = await tx
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(
                    and(
                        eq(chatStreamEvents.messageId, row.messageId),
                        inArray(chatStreamEvents.eventType, ['done', 'error'])
                    )
                )
                .limit(1)
            if (terminal) return null
            const [stamped] = await tx
                .insert(turnExecutions)
                .values({
                    messageId: row.messageId,
                    sessionId: row.sessionId,
                    agentId: row.agentId,
                    runtime: row.runtime,
                    spriteName: row.spriteName,
                    ownerId: row.ownerId,
                    leaseExpiresAt: sql`now() + make_interval(secs => ${row.leaseSeconds})`,
                    state: 'running',
                    createdAt: now,
                    updatedAt: now
                })
                .onConflictDoNothing()
                .returning({
                    ownerId: turnExecutions.ownerId,
                    generation: turnExecutions.generation,
                    state: turnExecutions.state
                })
            return stamped
                ? {
                      messageId: row.messageId,
                      ownerId: row.ownerId,
                      generation: stamped.generation
                  }
                : null
        })
    }

    // Records the sprite exec session id once the session_info frame lands, so a
    // fresh instance can re-attach to this exec by id after adopting the turn.
    // The exact owner may finish this during handoff's drain grace; takeover
    // still bumps generation before a new carrier can expose the row.
    async setTurnExecSession(
        messageId: string,
        spriteName: string,
        execSessionId: string,
        fence: TurnExecutionFence
    ): Promise<boolean> {
        if (fence.messageId !== messageId) return false
        const rows = await this.db
            .update(turnExecutions)
            .set({ spriteName, execSessionId, updatedAt: new Date() })
            .where(
                and(
                    eq(turnExecutions.messageId, messageId),
                    eq(turnExecutions.ownerId, fence.ownerId),
                    eq(turnExecutions.generation, fence.generation),
                    inArray(turnExecutions.state, [
                        'running',
                        'adopting',
                        'handoff'
                    ])
                )
            )
            .returning({ messageId: turnExecutions.messageId })
        return rows.length > 0
    }

    // External runtime twin of setTurnExecSession: records the upstream handles
    // as the stream reveals them. Each half is written only when present, so a
    // later ref-bearing chunk carrying just one of them can never blank the
    // other — and an upsert racing a re-stamp cannot lose an already-known id.
    // Like stream rows, an exact-generation write may drain after handoff.
    //
    // Reports whether a row actually took the write. The relay awaits this as a
    // durability barrier, and an UPDATE that matched nothing — the execution
    // stamp failed or the row was removed — leaves the turn with no recovery
    // handle while the statement itself succeeds. `true` for a call with no
    // known halves: there is nothing to persist and nothing to lose.
    async setTurnUpstreamRef(
        messageId: string,
        ref: { taskId?: string | null; upstreamMessageId?: string | null },
        fence: TurnExecutionFence
    ): Promise<{ written: boolean; fenceLost: boolean }> {
        if (fence.messageId !== messageId)
            return { written: false, fenceLost: true }
        const set: Record<string, unknown> = { updatedAt: new Date() }
        if (ref.taskId) set.upstreamTaskId = ref.taskId
        if (ref.upstreamMessageId) set.upstreamMessageId = ref.upstreamMessageId
        if (Object.keys(set).length === 1)
            return { written: true, fenceLost: false }
        const rows = await this.db
            .update(turnExecutions)
            .set(set)
            .where(
                and(
                    eq(turnExecutions.messageId, messageId),
                    eq(turnExecutions.ownerId, fence.ownerId),
                    eq(turnExecutions.generation, fence.generation),
                    inArray(turnExecutions.state, [
                        'running',
                        'adopting',
                        'handoff'
                    ])
                )
            )
            .returning({ messageId: turnExecutions.messageId })
        if (rows.length > 0) return { written: true, fenceLost: false }
        return {
            written: false,
            fenceLost: !(await this.turnFenceHolds(fence))
        }
    }

    // Extend the lease while the owner keeps relaying. Only the holder can renew
    // and only a live (running/adopting) turn — a handoff/terminal row is left
    // for the adoption sweep or is already finished. Generation-conditional: a
    // renew from the generation that was superseded would silently keep the
    // OLD carrier's timer alive over the new owner's lease.
    async renewTurnLease(
        messageId: string,
        ownerId: string,
        leaseSeconds: number,
        generation: number
    ): Promise<boolean> {
        const rows = await this.db
            .update(turnExecutions)
            .set({
                leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(turnExecutions.messageId, messageId),
                    eq(turnExecutions.ownerId, ownerId),
                    eq(turnExecutions.generation, generation),
                    inArray(turnExecutions.state, ['running', 'adopting'])
                )
            )
            .returning({ messageId: turnExecutions.messageId })
        return rows.length > 0
    }

    // Graceful shutdown: mark this instance's live turns as handed off and expire
    // their leases now so a peer adopts them within one sweep instead of waiting
    // out the TTL. An observed but unconfirmed ref is folded into the same
    // transaction, so the handoff can never expose that turn without the ref.
    async handoffOwnedTurns(
        fences: TurnExecutionFence[],
        upstreamRefs: Array<{
            messageId: string
            taskId?: string | null
            upstreamMessageId?: string | null
        }> = []
    ): Promise<string[]> {
        return this.db.transaction(async (tx) => {
            const rows: Array<{ messageId: string }> = []
            const refs = new Map(
                upstreamRefs.map((ref) => [ref.messageId, ref])
            )
            for (const fence of fences) {
                const ref = refs.get(fence.messageId)
                const handed = await tx
                    .update(turnExecutions)
                    .set({
                        state: 'handoff',
                        leaseExpiresAt: sql`now() + make_interval(secs => ${HANDOFF_DRAIN_GRACE_SECONDS})`,
                        updatedAt: new Date(),
                        ...(ref?.taskId ? { upstreamTaskId: ref.taskId } : {}),
                        ...(ref?.upstreamMessageId
                            ? {
                                  upstreamMessageId: ref.upstreamMessageId
                              }
                            : {})
                    })
                    .where(
                        and(
                            eq(turnExecutions.messageId, fence.messageId),
                            eq(turnExecutions.ownerId, fence.ownerId),
                            eq(turnExecutions.generation, fence.generation),
                            inArray(turnExecutions.state, [
                                'running',
                                'adopting'
                            ])
                        )
                    )
                    .returning({ messageId: turnExecutions.messageId })
                rows.push(...handed)
            }
            return rows.map((row) => row.messageId)
        })
    }

    // Shutdown raced a single adoption claim before its handler started. Give
    // only that claim back; bulk handoff here would expose unrelated turns that
    // are still using the graceful drain window. Generation-conditional for the
    // same reason renew is: a claim that has already been superseded must not
    // reopen the new owner's turn for adoption.
    async handoffOwnedTurn(
        messageId: string,
        ownerId: string,
        generation: number
    ): Promise<boolean> {
        const rows = await this.db
            .update(turnExecutions)
            .set({
                state: 'handoff',
                leaseExpiresAt: sql`now() + make_interval(secs => ${HANDOFF_DRAIN_GRACE_SECONDS})`,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(turnExecutions.messageId, messageId),
                    eq(turnExecutions.ownerId, ownerId),
                    eq(turnExecutions.generation, generation),
                    inArray(turnExecutions.state, ['running', 'adopting'])
                )
            )
            .returning({ messageId: turnExecutions.messageId })
        return rows.length > 0
    }

    // Non-terminal turns whose lease has lapsed (or were explicitly handed off):
    // adoption candidates. Terminal rows are excluded by the partial index +
    // the not-terminal guard. Scoped to the runtimes that have a recovery
    // generator: sprites re-read the framework transcript, external turns poll
    // the upstream (#670). `daemon` stays out — it resumes over its own
    // reverse-WS path, and the lease it now holds (#570) exists so that resume
    // can fence its predecessor, not so a sweep with no way to reach the daemon
    // can replay the turn from a transcript.
    async listAdoptableTurnExecutions(
        limit: number,
        options?: { daemonOnlineMs?: number; now?: Date }
    ): Promise<TurnExecutionRow[]> {
        const now = options?.now ?? new Date()
        const onlineCutoff = new Date(
            now.getTime() -
                (options?.daemonOnlineMs ?? DAEMON_ONLINE_THRESHOLD_MS)
        )
        return this.db
            .select()
            .from(turnExecutions)
            .where(
                and(
                    inArray(turnExecutions.runtime, ['sprites', 'external']),
                    inArray(turnExecutions.state, [
                        'running',
                        'handoff',
                        'adopting'
                    ]),
                    lt(turnExecutions.leaseExpiresAt, sql`now()`),
                    // A sprite turn can be carried by the sprite's own runner
                    // over the daemon transport. That turn is resumed by
                    // the reverse-WS path the moment the runner reconnects, and
                    // that path does NOT hold this lease — so without this the
                    // sweep claims the turn ~90s later and replays it from the
                    // transcript on top of the live resumed stream. The two
                    // writers land on different instances, so the in-process
                    // runningAdapters guard cannot see it.
                    //
                    // Liveness, not existence: once the runner is really gone
                    // the exemption lapses and the turn becomes adoptable again,
                    // which is the intended degrade path.
                    notExists(
                        this.db
                            .select({ one: sql`1` })
                            .from(chatMessages)
                            .innerJoin(
                                runtimeHosts,
                                eq(runtimeHosts.id, chatMessages.daemonId)
                            )
                            .where(
                                and(
                                    eq(
                                        chatMessages.id,
                                        turnExecutions.messageId
                                    ),
                                    isNotNull(chatMessages.daemonExecRef),
                                    gt(runtimeHosts.rpcLastSeenAt, onlineCutoff)
                                )
                            )
                    ),
                    notExists(
                        this.db
                            .select({ one: sql`1` })
                            .from(chatStreamEvents)
                            .where(
                                and(
                                    eq(
                                        chatStreamEvents.messageId,
                                        turnExecutions.messageId
                                    ),
                                    inArray(chatStreamEvents.eventType, [
                                        'done',
                                        'error'
                                    ])
                                )
                            )
                    )
                )
            )
            .orderBy(asc(turnExecutions.leaseExpiresAt))
            .limit(limit)
    }

    // CAS-claim a lapsed turn for adoption: only one instance wins because the
    // WHERE still requires the lease to be expired at UPDATE time. Bumps
    // adopt_count so the caller can cap retries on a turn that never converges,
    // and generation so the previous owner's in-flight writes are fenced out
    // the moment this commits.
    async claimTurnForAdoption(
        messageId: string,
        ownerId: string,
        leaseSeconds: number
    ): Promise<TurnExecutionRow | null> {
        const rows = await this.db
            .update(turnExecutions)
            .set({
                ownerId,
                state: 'adopting',
                generation: sql`${turnExecutions.generation} + 1`,
                leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
                adoptCount: sql`${turnExecutions.adoptCount} + 1`,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(turnExecutions.messageId, messageId),
                    inArray(turnExecutions.state, [
                        'running',
                        'handoff',
                        'adopting'
                    ]),
                    inArray(turnExecutions.runtime, ['sprites', 'external']),
                    lt(turnExecutions.leaseExpiresAt, sql`now()`)
                )
            )
            .returning()
        return rows[0] ?? null
    }

    // Claim a lapsed execution for an authoritative retryable terminal. Unlike
    // transcript adoption this does not consume an adopt attempt, but it uses
    // the same expired-lease CAS and generation bump. A matched hello can still
    // preempt the resulting `adopting` carrier before its terminal locks the
    // tuple; whichever write locks first is the linearization order.
    async claimTurnForReconciliation(
        messageId: string,
        ownerId: string,
        leaseSeconds: number
    ): Promise<TurnExecutionRow | null> {
        const rows = await this.db
            .update(turnExecutions)
            .set({
                ownerId,
                state: 'adopting',
                generation: sql`${turnExecutions.generation} + 1`,
                leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(turnExecutions.messageId, messageId),
                    inArray(turnExecutions.state, [
                        'running',
                        'handoff',
                        'adopting'
                    ]),
                    lt(turnExecutions.leaseExpiresAt, sql`now()`)
                )
            )
            .returning()
        return rows[0] ?? null
    }

    // A matched hello may take an expired owner, a drained handoff, or a
    // fence-aware transcript adoption. It may not preempt a live dispatch or
    // another live resume: two equal authoritative carriers repeatedly bumping
    // each other would create the dual consumer this fence exists to prevent.
    //
    // generation=1 is also the rolling-deploy compatibility marker for an
    // adoption claimed by pre-fence code: that code cannot honor a generation
    // bump, so its live lease is allowed to drain instead of being preempted.
    // A fence-aware adoption always bumped an existing row and is >1.
    async claimTurnForResume(input: {
        messageId: string
        sessionId: string
        daemonId: string
        daemonExecRef: string
        ownerId: string
        leaseSeconds: number
    }): Promise<ResumeTurnClaim> {
        return this.db.transaction(async (tx) => {
            // Claims and event/terminal admission use the same first lock. It
            // both preserves per-session ordering and serializes the legacy
            // no-execution-row case with a terminal or first stamp.
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext('chat_stream_events'), hashtext(${input.sessionId}))`
            )
            const [message] = await tx
                .select({
                    id: chatMessages.id,
                    inflightMessageId: chatSessions.inflightMessageId
                })
                .from(chatMessages)
                .innerJoin(
                    chatSessions,
                    eq(chatSessions.id, chatMessages.sessionId)
                )
                .where(
                    and(
                        eq(chatMessages.id, input.messageId),
                        eq(chatMessages.sessionId, input.sessionId),
                        eq(chatMessages.daemonId, input.daemonId),
                        eq(chatMessages.daemonExecRef, input.daemonExecRef)
                    )
                )
                .limit(1)
            if (!message) return { outcome: 'mismatch' }
            const [terminal] = await tx
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(
                    and(
                        eq(chatStreamEvents.messageId, input.messageId),
                        inArray(chatStreamEvents.eventType, ['done', 'error'])
                    )
                )
                .limit(1)
            if (terminal) return { outcome: 'terminal' }
            if (message.inflightMessageId !== input.messageId)
                return { outcome: 'mismatch' }

            const current = await lockTurnExecution(tx, input.messageId)
            // A missing row is a pre-fence daemon turn from an older replica.
            // That carrier cannot honor generation, so manufacturing a row and
            // claiming it during a rolling deploy would still let its unfenced
            // writes land after this takeover. New dispatches stamp before any
            // adapter work, making "missing" a compatibility case rather than
            // a normal recovery path; defer it to legacy convergence.
            if (!current) return { outcome: 'busy' }
            if (current.sessionId !== input.sessionId)
                return { outcome: 'mismatch' }
            if (current.state === 'done' || current.state === 'failed')
                return { outcome: 'terminal' }

            const [claimed] = await tx
                .update(turnExecutions)
                .set({
                    ownerId: input.ownerId,
                    state: 'running',
                    generation: sql`${turnExecutions.generation} + 1`,
                    leaseExpiresAt: sql`now() + make_interval(secs => ${input.leaseSeconds})`,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(turnExecutions.messageId, input.messageId),
                        eq(turnExecutions.generation, current.generation),
                        or(
                            lt(turnExecutions.leaseExpiresAt, sql`now()`),
                            and(
                                eq(turnExecutions.state, 'adopting'),
                                gt(turnExecutions.generation, 1)
                            )
                        )
                    )
                )
                .returning()
            return claimed
                ? { outcome: 'claimed', row: claimed }
                : { outcome: 'busy' }
        })
    }

    async getTurnExecution(
        messageId: string
    ): Promise<TurnExecutionRow | null> {
        const [row] = await this.db
            .select()
            .from(turnExecutions)
            .where(eq(turnExecutions.messageId, messageId))
            .limit(1)
        return row ?? null
    }

    async maxStreamEventSeq(messageId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: max(chatStreamEvents.seq) })
            .from(chatStreamEvents)
            .where(eq(chatStreamEvents.messageId, messageId))
            .limit(1)
        return row?.value ?? 0
    }

    // Owner-side convergence read for turns running in THIS process: the
    // durable flag is the only record a cancel leaves when the NOTIFY that was
    // supposed to reach the owner never arrives. Batched and keyed on the
    // primary key, so one round trip covers every live turn.
    async findCancelRequestedMessageIds(
        messageIds: string[]
    ): Promise<string[]> {
        if (messageIds.length === 0) return []
        const rows = await this.db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(
                and(
                    inArray(chatMessages.id, messageIds),
                    isNotNull(chatMessages.cancelRequestedAt)
                )
            )
        return rows.map((row) => row.id)
    }

    async markCancelRequested(messageId: string): Promise<void> {
        await this.db
            .update(chatMessages)
            .set({ cancelRequestedAt: new Date() })
            .where(
                and(
                    eq(chatMessages.id, messageId),
                    isNull(chatMessages.cancelRequestedAt)
                )
            )
    }

    async getMessageById(messageId: string): Promise<DbChatMessage | null> {
        const [row] = await this.db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.id, messageId))
            .limit(1)
        return row ?? null
    }

    // The user message that triggered an assistant turn: the pair is inserted
    // user-first and the session turn lock admits one turn at a time, so the
    // newest user row at-or-before the assistant row's created_at is its
    // prompt. Adoption recomputes the prompt-as-sent from it so recovery can
    // anchor the turn even when no output line was cached before the crash.
    async latestUserMessageBefore(
        sessionId: string,
        at: Date
    ): Promise<DbChatMessage | null> {
        const [row] = await this.db
            .select()
            .from(chatMessages)
            .where(
                and(
                    eq(chatMessages.sessionId, sessionId),
                    eq(chatMessages.role, 'user'),
                    lte(chatMessages.createdAt, at)
                )
            )
            .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
            .limit(1)
        return row ?? null
    }

    async getSessionById(sessionId: string): Promise<DbChatSession | null> {
        const [row] = await this.db
            .select()
            .from(chatSessions)
            .where(eq(chatSessions.id, sessionId))
            .limit(1)
        return row ?? null
    }

    async findTerminalStreamEvent(messageId: string): Promise<{
        eventType: 'done' | 'error'
        payloadJson: Record<string, unknown>
    } | null> {
        const [row] = await this.db
            .select({
                eventType: chatStreamEvents.eventType,
                payloadJson: chatStreamEvents.payloadJson
            })
            .from(chatStreamEvents)
            .where(
                and(
                    eq(chatStreamEvents.messageId, messageId),
                    inArray(chatStreamEvents.eventType, ['done', 'error'])
                )
            )
            .orderBy(desc(chatStreamEvents.id))
            .limit(1)
        if (!row) return null
        return {
            eventType: row.eventType as 'done' | 'error',
            payloadJson: row.payloadJson as Record<string, unknown>
        }
    }

    async listStreamEventsSince(
        messageId: string,
        afterId: bigint
    ): Promise<Array<typeof chatStreamEvents.$inferSelect>> {
        return this.db
            .select()
            .from(chatStreamEvents)
            .where(
                and(
                    eq(chatStreamEvents.messageId, messageId),
                    gt(chatStreamEvents.id, afterId)
                )
            )
            .orderBy(asc(chatStreamEvents.id))
    }

    async listSessionStreamEventsSince(
        sessionId: string,
        afterId: bigint,
        limit: number
    ): Promise<Array<typeof chatStreamEvents.$inferSelect>> {
        return this.db
            .select()
            .from(chatStreamEvents)
            .where(
                and(
                    eq(chatStreamEvents.sessionId, sessionId),
                    gt(chatStreamEvents.id, afterId)
                )
            )
            .orderBy(asc(chatStreamEvents.id))
            .limit(limit)
    }

    async minStreamEventId(messageId: string): Promise<bigint | null> {
        const [row] = await this.db
            .select({ value: min(chatStreamEvents.id) })
            .from(chatStreamEvents)
            .where(eq(chatStreamEvents.messageId, messageId))
            .limit(1)
        const value = row?.value
        return value == null ? null : BigInt(value)
    }

    async maxSessionStreamEventId(sessionId: string): Promise<bigint> {
        const [row] = await this.db
            .select({ value: max(chatStreamEvents.id) })
            .from(chatStreamEvents)
            .where(eq(chatStreamEvents.sessionId, sessionId))
            .limit(1)
        const value = row?.value
        return value == null ? 0n : BigInt(value)
    }

    async streamReplayCursor(
        sessionId: string,
        messageId: string
    ): Promise<bigint> {
        const messageMin = this.db
            .select({ value: min(chatStreamEvents.id) })
            .from(chatStreamEvents)
            .where(
                and(
                    eq(chatStreamEvents.sessionId, sessionId),
                    eq(chatStreamEvents.messageId, messageId)
                )
            )
            .limit(1)
        const [row] = await this.db
            .select({
                messageMin: sql<bigint | null>`(${messageMin})`,
                sessionMax: max(chatStreamEvents.id)
            })
            .from(chatStreamEvents)
            .where(eq(chatStreamEvents.sessionId, sessionId))
        if (row?.messageMin != null) return BigInt(row.messageMin) - 1n
        return row?.sessionMax == null ? 0n : BigInt(row.sessionMax)
    }

    async streamAttachAnchor(sessionId: string): Promise<{
        inflightMessageId: string | null
        maxEventId: bigint
    }> {
        const latestInflight = this.db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(
                and(
                    eq(chatMessages.sessionId, sessionId),
                    eq(chatMessages.role, 'assistant'),
                    this.noTerminalStreamEvent()
                )
            )
            .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
            .limit(1)
        const [row] = await this.db
            .select({
                inflightMessageId: sql<string | null>`(${latestInflight})`,
                maxEventId: max(chatStreamEvents.id)
            })
            .from(chatStreamEvents)
            .where(eq(chatStreamEvents.sessionId, sessionId))
        return {
            inflightMessageId: row?.inflightMessageId ?? null,
            maxEventId: row?.maxEventId == null ? 0n : BigInt(row.maxEventId)
        }
    }

    // The two halves of the dead-turn predicate, defined once and shared by
    // every query that asks "is this assistant turn still in flight / dead":
    // listOrphanedAssistantMessages (boot), latestDeadInflightMessage +
    // deadInflightMessageById (subscribe/A2A), and latestInflightMessageId.

    // Half 1 — no terminal yet: the message has no done/error stream event.
    private noTerminalStreamEvent(): SQL {
        return notExists(
            this.db
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(
                    and(
                        eq(chatStreamEvents.messageId, chatMessages.id),
                        inArray(chatStreamEvents.eventType, ['done', 'error'])
                    )
                )
        )
    }

    // Half 2 — not resumable by a live daemon: a turn is dead-eligible UNLESS
    // it is a daemon turn whose host was seen within the grace window (that
    // host resumes it over the reverse-WS path, so it must never be
    // terminalized). Non-daemon turns (daemon_exec_ref IS NULL) short-circuit
    // to eligible. Kept as one definition so the daemon-liveness semantics
    // can't drift between the three dead-turn queries that share it.
    private notResumableByLiveDaemon(graceCutoff: Date): SQL {
        return sql`(${chatMessages.daemonExecRef} is null or not exists (
                        select 1 from ${runtimeHosts}
                        where ${runtimeHosts.id} = ${chatMessages.daemonId}
                          and ${runtimeHosts.lastSeenAt} > ${graceCutoff.toISOString()}::timestamptz
                    ))`
    }

    async listOrphanedAssistantMessages(options?: {
        daemonGraceMs?: number
        messageGraceMs?: number
        now?: Date
    }): Promise<
        Array<{ messageId: string; sessionId: string; lastSeq: number }>
    > {
        const graceMs = options?.daemonGraceMs ?? 24 * 60 * 60 * 1000
        const messageGraceMs =
            options?.messageGraceMs ?? ORPHANED_ASSISTANT_MESSAGE_GRACE_MS
        const now = options?.now ?? new Date()
        const graceCutoff = new Date(now.getTime() - graceMs)
        const messageCutoff = new Date(now.getTime() - messageGraceMs)
        const rows = await this.db
            .select({
                messageId: chatMessages.id,
                sessionId: chatMessages.sessionId,
                lastSeq: max(chatStreamEvents.seq)
            })
            .from(chatMessages)
            .leftJoin(
                chatStreamEvents,
                eq(chatStreamEvents.messageId, chatMessages.id)
            )
            .where(
                and(
                    eq(chatMessages.role, 'assistant'),
                    lt(chatMessages.createdAt, messageCutoff),
                    this.noTerminalStreamEvent(),
                    this.notResumableByLiveDaemon(graceCutoff)
                )
            )
            .groupBy(chatMessages.id, chatMessages.sessionId)
        return rows.map((row) => ({
            messageId: row.messageId,
            sessionId: row.sessionId,
            lastSeq: row.lastSeq ?? 0
        }))
    }

    async latestInflightMessageId(sessionId: string): Promise<string | null> {
        const rows = await this.db
            .select({
                id: chatMessages.id
            })
            .from(chatMessages)
            .where(
                and(
                    eq(chatMessages.sessionId, sessionId),
                    eq(chatMessages.role, 'assistant'),
                    this.noTerminalStreamEvent()
                )
            )
            .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
            .limit(1)
        return rows[0]?.id ?? null
    }

    // The subscribe-time companion to listOrphanedAssistantMessages: the latest
    // assistant turn in this session that has NO terminal AND is not resumable —
    // an in-process turn whose API process died, or a daemon turn whose host has
    // gone silent past the grace window. Unlike the bootstrap sweep there is no
    // message-age guard, so a turn that just died clears on the next reload
    // rather than ~24h later; the daemon-liveness predicate is identical, so a
    // daemon that is merely disconnected and will resume is never reported dead.
    async latestDeadInflightMessage(
        sessionId: string,
        options?: { daemonGraceMs?: number; now?: Date }
    ): Promise<{ messageId: string; lastSeq: number } | null> {
        const graceMs =
            options?.daemonGraceMs ?? ORPHANED_ASSISTANT_MESSAGE_GRACE_MS
        const now = options?.now ?? new Date()
        const graceCutoff = new Date(now.getTime() - graceMs)
        const rows = await this.db
            .select({
                messageId: chatMessages.id,
                lastSeq: max(chatStreamEvents.seq)
            })
            .from(chatMessages)
            .leftJoin(
                chatStreamEvents,
                eq(chatStreamEvents.messageId, chatMessages.id)
            )
            .where(
                and(
                    eq(chatMessages.sessionId, sessionId),
                    eq(chatMessages.role, 'assistant'),
                    this.noTerminalStreamEvent(),
                    this.notResumableByLiveDaemon(graceCutoff)
                )
            )
            .groupBy(chatMessages.id, chatMessages.createdAt)
            .orderBy(desc(chatMessages.createdAt))
            .limit(1)
        const row = rows[0]
        if (!row) return null
        return { messageId: row.messageId, lastSeq: row.lastSeq ?? 0 }
    }

    // The message-scoped twin of latestDeadInflightMessage: resolve dead-turn
    // state for ONE assistant message id (an A2A task maps to a single assistant
    // turn) instead of the session's latest. Same terminal + daemon-liveness
    // predicate; also returns sessionId since the caller only has the message id.
    async deadInflightMessageById(
        assistantMessageId: string,
        options?: { daemonGraceMs?: number; now?: Date }
    ): Promise<{
        messageId: string
        sessionId: string
        lastSeq: number
    } | null> {
        const graceMs =
            options?.daemonGraceMs ?? ORPHANED_ASSISTANT_MESSAGE_GRACE_MS
        const now = options?.now ?? new Date()
        const graceCutoff = new Date(now.getTime() - graceMs)
        const rows = await this.db
            .select({
                messageId: chatMessages.id,
                sessionId: chatMessages.sessionId,
                lastSeq: max(chatStreamEvents.seq)
            })
            .from(chatMessages)
            .leftJoin(
                chatStreamEvents,
                eq(chatStreamEvents.messageId, chatMessages.id)
            )
            .where(
                and(
                    eq(chatMessages.id, assistantMessageId),
                    eq(chatMessages.role, 'assistant'),
                    this.noTerminalStreamEvent(),
                    this.notResumableByLiveDaemon(graceCutoff)
                )
            )
            .groupBy(
                chatMessages.id,
                chatMessages.sessionId,
                chatMessages.createdAt
            )
            .limit(1)
        const row = rows[0]
        if (!row) return null
        return {
            messageId: row.messageId,
            sessionId: row.sessionId,
            lastSeq: row.lastSeq ?? 0
        }
    }
}

// User input and recovered agent transcripts can carry NUL or lone UTF-16
// surrogates, which Postgres rejects on jsonb writes; sanitize every message
// row at this chokepoint so no caller has to remember to.
const sanitizeMessageRow = (row: NewChatMessage): NewChatMessage => ({
    ...row,
    contentBlocksJson: sanitizeForJsonb(row.contentBlocksJson),
    capabilityEventsJson: sanitizeForJsonb(row.capabilityEventsJson)
})

// postgres.js rejects statements above 65534 bind parameters; recovered
// sessions can carry thousands of rows, so bulk writes must stay chunked
// well under ceil(65534 / column count) for their table.
const MESSAGE_INSERT_CHUNK = 4000
const SOURCE_UPSERT_CHUNK = 2000

const chunkRows = <T>(rows: T[], size: number): T[][] => {
    const out: T[][] = []
    for (let i = 0; i < rows.length; i += size)
        out.push(rows.slice(i, i + size))
    return out
}

const insertMessagesTx = async (
    tx: DatabaseTx,
    rows: NewChatMessage[]
): Promise<void> => {
    for (const chunk of chunkRows(rows, MESSAGE_INSERT_CHUNK))
        await tx.insert(chatMessages).values(chunk.map(sanitizeMessageRow))
}

// Recovery-written assistant rows never had a live stream, so nothing else
// ever closes them. Without a done/error row the dead-turn predicate
// (noTerminalStreamEvent) reads each one as an interrupted inflight turn, and
// the next page load stamps a retryable server_restart over a turn that in
// fact completed in the TUI. Stamping the terminal in the same transaction
// means no reader can ever observe a recovered assistant message without it.
const insertRecoveredTerminalsTx = async (
    tx: DatabaseTx,
    rows: NewChatMessage[]
): Promise<void> => {
    const terminals = rows
        .filter((row) => row.role === 'assistant')
        .map(
            (row): NewChatStreamEventRow => ({
                sessionId: row.sessionId,
                messageId: row.id,
                seq: 1,
                eventType: 'done',
                payloadJson: { type: 'done', finalMessageId: row.id },
                createdAt: row.createdAt ?? new Date()
            })
        )
    if (terminals.length === 0) return
    await tx.insert(chatStreamEvents).values(terminals)
}

const fenceHolds = async (
    tx: DatabaseTx,
    fence: TurnExecutionFence
): Promise<boolean> => {
    const [row] = await tx
        .select({ messageId: turnExecutions.messageId })
        .from(turnExecutions)
        .where(
            and(
                eq(turnExecutions.messageId, fence.messageId),
                eq(turnExecutions.ownerId, fence.ownerId),
                eq(turnExecutions.generation, fence.generation)
            )
        )
        .limit(1)
    return row !== undefined
}

// Owned write lock order is stream advisory (events/claims), content advisory
// (content/terminal), execution tuple, then session/message rows. A path may
// start later in that order but never acquire an earlier lock afterwards.
// Idle transcript rebuilds take the session row alone and proceed only when
// inflight_message_id is null, which excludes every execution-tuple holder.
const lockTurnFence = async (
    tx: DatabaseTx,
    fence: TurnExecutionFence
): Promise<boolean> => {
    const [row] = await tx
        .select({ messageId: turnExecutions.messageId })
        .from(turnExecutions)
        .where(
            and(
                eq(turnExecutions.messageId, fence.messageId),
                eq(turnExecutions.ownerId, fence.ownerId),
                eq(turnExecutions.generation, fence.generation)
            )
        )
        .limit(1)
        .for('update')
    return row !== undefined
}

const lockTurnSessionFence = async (
    tx: DatabaseTx,
    fence: TurnExecutionFence,
    sessionId: string
): Promise<boolean> => {
    const [row] = await tx
        .select({ messageId: turnExecutions.messageId })
        .from(turnExecutions)
        .where(
            and(
                eq(turnExecutions.messageId, fence.messageId),
                eq(turnExecutions.sessionId, sessionId),
                eq(turnExecutions.ownerId, fence.ownerId),
                eq(turnExecutions.generation, fence.generation)
            )
        )
        .limit(1)
        .for('update')
    return row !== undefined
}

const lockTurnExecution = async (
    tx: DatabaseTx,
    messageId: string
): Promise<TurnExecutionRow | null> => {
    const [row] = await tx
        .select()
        .from(turnExecutions)
        .where(eq(turnExecutions.messageId, messageId))
        .limit(1)
        .for('update')
    return row ?? null
}

const upsertMessageSourcesTx = async (
    tx: DatabaseTx,
    rows: NewChatMessageSource[]
): Promise<void> => {
    const now = new Date()
    for (const chunk of chunkRows(rows, SOURCE_UPSERT_CHUNK))
        await tx
            .insert(chatMessageSources)
            .values(chunk)
            .onConflictDoUpdate({
                target: chatMessageSources.sourceEventKey,
                set: {
                    messageId: sql`coalesce(${chatMessageSources.messageId}, excluded.message_id)`,
                    sessionId: sql`excluded.session_id`,
                    sourceKind: sql`excluded.source_kind`,
                    framework: sql`excluded.framework`,
                    runtime: sql`excluded.runtime`,
                    sourceRef: sql`coalesce(${chatMessageSources.sourceRef}, excluded.source_ref)`,
                    sourceFile: sql`coalesce(${chatMessageSources.sourceFile}, excluded.source_file)`,
                    externalId: sql`coalesce(${chatMessageSources.externalId}, excluded.external_id)`,
                    parentExternalId: sql`coalesce(${chatMessageSources.parentExternalId}, excluded.parent_external_id)`,
                    rawText: sql`case when ${chatMessageSources.rawText} is null and excluded.raw_text is not null then excluded.raw_text else ${chatMessageSources.rawText} end`,
                    rawJson: sql`case when ${chatMessageSources.rawJson} is null and excluded.raw_json is not null then excluded.raw_json else ${chatMessageSources.rawJson} end`,
                    rawSha256: sql`coalesce(${chatMessageSources.rawSha256}, excluded.raw_sha256)`,
                    rawBytes: sql`coalesce(${chatMessageSources.rawBytes}, excluded.raw_bytes)`,
                    parserName: sql`excluded.parser_name`,
                    parserVersion: sql`excluded.parser_version`,
                    parsedAt: sql`excluded.parsed_at`,
                    rawClearedAt: sql`case when (${chatMessageSources.rawText} is null and ${chatMessageSources.rawJson} is null) and (excluded.raw_text is not null or excluded.raw_json is not null) then null else ${chatMessageSources.rawClearedAt} end`,
                    updatedAt: now
                }
            })
}

// Shared links freeze the transcript at share time; a history rewrite would
// silently change what an already-published link shows, so revoke instead.
type DatabaseTx = Parameters<Parameters<Database['transaction']>[0]>[0]

const revokeActiveSharesTx = async (
    tx: DatabaseTx,
    sessionId: string
): Promise<void> => {
    await tx
        .update(chatSessionShares)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
            and(
                eq(chatSessionShares.sessionId, sessionId),
                isNull(chatSessionShares.revokedAt)
            )
        )
}

// Composite (created_at, id) cursor comparison for OpenAI `after` pagination:
// desc → rows strictly older than the cursor; asc → strictly newer. Keeps
// pagination chronological without relying on id string ordering.
const afterCondition = (
    createdAtCol: AnyColumn,
    idCol: AnyColumn,
    cursor: MessageCursor,
    order: 'asc' | 'desc'
): SQL | undefined =>
    order === 'asc'
        ? or(
              gt(createdAtCol, cursor.createdAt),
              and(eq(createdAtCol, cursor.createdAt), gt(idCol, cursor.id))
          )
        : or(
              lt(createdAtCol, cursor.createdAt),
              and(eq(createdAtCol, cursor.createdAt), lt(idCol, cursor.id))
          )
