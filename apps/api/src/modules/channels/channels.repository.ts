import { Inject, Injectable } from '@nestjs/common'
import {
    and,
    asc,
    desc,
    eq,
    gte,
    inArray,
    isNotNull,
    isNull,
    like,
    lt,
    lte,
    ne,
    or,
    sql
} from 'drizzle-orm'
import {
    automations,
    channels,
    channelDeliveries,
    channelLeases,
    channelProviderStates,
    channelSessions,
    chatSessions,
    users,
    type ChannelDeliveryRow,
    type ChannelProviderStateRow,
    type ChannelRow,
    type ChannelSessionRow,
    type Database,
    type NewChannelDeliveryRow,
    type NewChannelProviderStateRow,
    type NewChannelRow,
    type NewChannelSessionRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

export interface ChannelSessionWithChatTitle {
    session: ChannelSessionRow
    chatTitle: string | null
}

export interface ListScopeSessionsOpts {
    includeArchived?: boolean
    archivedSince?: Date
}

export interface SwapActiveResult {
    activated: ChannelSessionRow
    deactivated: ChannelSessionRow | null
}

const RECONNECT_BASE_DELAY_S = 30
const RECONNECT_MAX_DELAY_S = 600

// SET expressions read the pre-update row, so the exponent uses the attempt
// count from before this statement's own increment.
const reconnectBackoffExpr = () =>
    sql`now() + make_interval(secs => least(${RECONNECT_MAX_DELAY_S}::int, ${RECONNECT_BASE_DELAY_S}::int * power(2, least(${channels.reconnectAttempts}, 6))))`

export const INFLIGHT_QUEUE_REASON = 'inflight_turn'

export interface ArchiveResult {
    archived: ChannelSessionRow
    fallbackActivated: ChannelSessionRow | null
}

@Injectable()
export class ChannelsRepository {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    // ADR-0023: deletion-pending owners receive no channel traffic.
    async isOwnerDeactivated(userId: string): Promise<boolean> {
        const [row] = await this.db
            .select({ deactivatedAt: users.deactivatedAt })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        return row?.deactivatedAt != null
    }

    async listByUser(userId: string): Promise<ChannelRow[]> {
        return this.db
            .select()
            .from(channels)
            .where(eq(channels.userId, userId))
            .orderBy(desc(channels.updatedAt), desc(channels.createdAt))
    }

    async listAll(): Promise<ChannelRow[]> {
        return this.db
            .select()
            .from(channels)
            .orderBy(desc(channels.updatedAt), desc(channels.createdAt))
    }

    async getById(id: string): Promise<ChannelRow | null> {
        const rows = await this.db
            .select()
            .from(channels)
            .where(eq(channels.id, id))
            .limit(1)
        return rows[0] ?? null
    }

    async getOwned(id: string, userId: string): Promise<ChannelRow | null> {
        const rows = await this.db
            .select()
            .from(channels)
            .where(and(eq(channels.id, id), eq(channels.userId, userId)))
            .limit(1)
        return rows[0] ?? null
    }

    async listActive(): Promise<ChannelRow[]> {
        return this.db
            .select()
            .from(channels)
            .where(eq(channels.status, 'active'))
    }

    // The lease tick's working set: only statuses the manager schedules.
    // Unlike listAll this hits channels_status_idx and skips the sort.
    async listSchedulable(): Promise<ChannelRow[]> {
        return this.db
            .select()
            .from(channels)
            .where(inArray(channels.status, ['active', 'error']))
    }

    async insert(row: NewChannelRow): Promise<ChannelRow> {
        const [inserted] = await this.db
            .insert(channels)
            .values(row)
            .returning()
        return inserted
    }

    async update(
        id: string,
        patch: Partial<NewChannelRow>
    ): Promise<ChannelRow | null> {
        const [updated] = await this.db
            .update(channels)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(channels.id, id))
            .returning()
        return updated ?? null
    }

    // Rebind atomically with the session sweep: a window where the channel
    // already points at the new agent while an old-agent session is still
    // active would route inbound turns into a chat session the new agent
    // cannot access. Archiving (not deleting) keeps scope history readable,
    // and /switch + makeActive both refuse archived sessions, so nothing can
    // reactivate a stale-agent session afterwards. Automations of other
    // agents lose their delivery pair the same way a channel delete would
    // (FK set-null), preserving the delivery-channel-matches-agent invariant.
    async rebindAgent(
        id: string,
        agentId: string
    ): Promise<ChannelRow | null> {
        return this.db.transaction(async (tx) => {
            const now = new Date()
            const [updated] = await tx
                .update(channels)
                .set({ agentId, updatedAt: now })
                .where(eq(channels.id, id))
                .returning()
            if (!updated) return null
            await tx
                .update(channelSessions)
                .set({ isActive: false, archivedAt: now, updatedAt: now })
                .where(
                    and(
                        eq(channelSessions.channelId, id),
                        isNull(channelSessions.archivedAt)
                    )
                )
            await tx
                .update(automations)
                .set({
                    deliveryChannelId: null,
                    deliveryTarget: null,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(automations.deliveryChannelId, id),
                        ne(automations.agentId, agentId)
                    )
                )
            return updated
        })
    }

    async delete(id: string): Promise<void> {
        await this.db.delete(channels).where(eq(channels.id, id))
    }

    async markChannelConnected(id: string): Promise<void> {
        const now = new Date()
        await this.db
            .update(channels)
            .set({
                status: 'active',
                lastConnectedAt: now,
                lastErrorAt: null,
                lastErrorMessage: null,
                reconnectAttempts: 0,
                nextReconnectAt: null,
                updatedAt: now
            })
            .where(eq(channels.id, id))
    }

    // Backoff is computed SQL-side from the stored attempt count so concurrent
    // reporters (start failure + provider status callback) cannot lose updates.
    async markChannelError(id: string, message: string): Promise<number | null> {
        const [updated] = await this.db
            .update(channels)
            .set({
                status: 'error',
                lastErrorAt: new Date(),
                lastErrorMessage: message,
                reconnectAttempts: sql`${channels.reconnectAttempts} + 1`,
                nextReconnectAt: reconnectBackoffExpr(),
                updatedAt: new Date()
            })
            .where(eq(channels.id, id))
            .returning({ attempts: channels.reconnectAttempts })
        return updated?.attempts ?? null
    }

    // Pre-writes the backoff window before a reconnect start, so a handle that
    // never reaches a terminal status (stuck connecting) cannot be re-bounced
    // on every lease tick. Leaves the error fields alone — the original cause
    // stays visible — and no-ops when the row already left error status.
    async armChannelReconnect(id: string): Promise<number | null> {
        const [updated] = await this.db
            .update(channels)
            .set({
                reconnectAttempts: sql`${channels.reconnectAttempts} + 1`,
                nextReconnectAt: reconnectBackoffExpr(),
                updatedAt: new Date()
            })
            .where(and(eq(channels.id, id), eq(channels.status, 'error')))
            .returning({ attempts: channels.reconnectAttempts })
        return updated?.attempts ?? null
    }

    async findActiveSession(
        channelId: string,
        scopeKey: string
    ): Promise<ChannelSessionRow | null> {
        const rows = await this.db
            .select()
            .from(channelSessions)
            .where(
                and(
                    eq(channelSessions.channelId, channelId),
                    eq(channelSessions.scopeKey, scopeKey),
                    eq(channelSessions.isActive, true),
                    isNull(channelSessions.archivedAt)
                )
            )
            .limit(1)
        return rows[0] ?? null
    }

    async findSessionById(id: string): Promise<ChannelSessionRow | null> {
        const rows = await this.db
            .select()
            .from(channelSessions)
            .where(eq(channelSessions.id, id))
            .limit(1)
        return rows[0] ?? null
    }

    async listScopeSessions(
        channelId: string,
        scopeKey: string,
        opts: ListScopeSessionsOpts = {}
    ): Promise<ChannelSessionRow[]> {
        const filters = [
            eq(channelSessions.channelId, channelId),
            eq(channelSessions.scopeKey, scopeKey)
        ]
        if (!opts.includeArchived) {
            if (opts.archivedSince)
                filters.push(
                    or(
                        isNull(channelSessions.archivedAt),
                        gte(channelSessions.archivedAt, opts.archivedSince)
                    )!
                )
            else filters.push(isNull(channelSessions.archivedAt))
        }
        return this.db
            .select()
            .from(channelSessions)
            .where(and(...filters))
            .orderBy(
                asc(channelSessions.createdAt),
                asc(channelSessions.id)
            )
    }

    async listScopeSessionsWithChatTitle(
        channelId: string,
        scopeKey: string,
        opts: ListScopeSessionsOpts = {}
    ): Promise<ChannelSessionWithChatTitle[]> {
        const filters = [
            eq(channelSessions.channelId, channelId),
            eq(channelSessions.scopeKey, scopeKey)
        ]
        if (!opts.includeArchived) {
            if (opts.archivedSince)
                filters.push(
                    or(
                        isNull(channelSessions.archivedAt),
                        gte(channelSessions.archivedAt, opts.archivedSince)
                    )!
                )
            else filters.push(isNull(channelSessions.archivedAt))
        }
        const rows = await this.db
            .select({
                session: channelSessions,
                chatTitle: chatSessions.title
            })
            .from(channelSessions)
            .leftJoin(
                chatSessions,
                eq(channelSessions.chatSessionId, chatSessions.id)
            )
            .where(and(...filters))
            .orderBy(
                asc(channelSessions.createdAt),
                asc(channelSessions.id)
            )
        return rows.map((r) => ({
            session: r.session,
            chatTitle: r.chatTitle
        }))
    }

    async insertSession(row: NewChannelSessionRow): Promise<ChannelSessionRow> {
        const [inserted] = await this.db
            .insert(channelSessions)
            .values(row)
            .returning()
        return inserted
    }

    async forkActiveSession(
        channelId: string,
        scopeKey: string,
        newRow: NewChannelSessionRow
    ): Promise<{ inserted: ChannelSessionRow; replaced: ChannelSessionRow | null }> {
        return this.db.transaction(async (tx) => {
            const [replaced] = await tx
                .update(channelSessions)
                .set({ isActive: false, updatedAt: new Date() })
                .where(
                    and(
                        eq(channelSessions.channelId, channelId),
                        eq(channelSessions.scopeKey, scopeKey),
                        eq(channelSessions.isActive, true),
                        isNull(channelSessions.archivedAt)
                    )
                )
                .returning()
            const [inserted] = await tx
                .insert(channelSessions)
                .values({ ...newRow, isActive: true, archivedAt: null })
                .returning()
            return { inserted, replaced: replaced ?? null }
        })
    }

    async swapActiveSession(
        channelId: string,
        scopeKey: string,
        targetId: string
    ): Promise<SwapActiveResult> {
        return this.db.transaction(async (tx) => {
            const [target] = await tx
                .select()
                .from(channelSessions)
                .where(eq(channelSessions.id, targetId))
                .limit(1)
            if (!target)
                throw new Error(`channel_session ${targetId} not found`)
            if (target.channelId !== channelId || target.scopeKey !== scopeKey)
                throw new Error(
                    `channel_session ${targetId} not in scope ${channelId}/${scopeKey}`
                )
            if (target.archivedAt !== null)
                throw new Error(
                    `channel_session ${targetId} is archived; cannot reactivate`
                )

            const now = new Date()
            const [deactivated] = await tx
                .update(channelSessions)
                .set({ isActive: false, updatedAt: now })
                .where(
                    and(
                        eq(channelSessions.channelId, channelId),
                        eq(channelSessions.scopeKey, scopeKey),
                        eq(channelSessions.isActive, true),
                        isNull(channelSessions.archivedAt),
                        ne(channelSessions.id, targetId)
                    )
                )
                .returning()
            const [activated] = await tx
                .update(channelSessions)
                .set({ isActive: true, updatedAt: now })
                .where(eq(channelSessions.id, targetId))
                .returning()
            return { activated, deactivated: deactivated ?? null }
        })
    }

    async archiveSession(
        id: string,
        opts: { activateFallback?: boolean } = {}
    ): Promise<ArchiveResult> {
        return this.db.transaction(async (tx) => {
            const now = new Date()
            const [archived] = await tx
                .update(channelSessions)
                .set({ isActive: false, archivedAt: now, updatedAt: now })
                .where(eq(channelSessions.id, id))
                .returning()
            if (!archived)
                throw new Error(`channel_session ${id} not found`)
            if (!opts.activateFallback)
                return { archived, fallbackActivated: null }
            const [candidate] = await tx
                .select()
                .from(channelSessions)
                .where(
                    and(
                        eq(channelSessions.channelId, archived.channelId),
                        eq(channelSessions.scopeKey, archived.scopeKey),
                        isNull(channelSessions.archivedAt),
                        eq(channelSessions.isActive, false)
                    )
                )
                .orderBy(desc(channelSessions.createdAt))
                .limit(1)
            if (!candidate) return { archived, fallbackActivated: null }
            const [fallback] = await tx
                .update(channelSessions)
                .set({ isActive: true, updatedAt: now })
                .where(eq(channelSessions.id, candidate.id))
                .returning()
            return { archived, fallbackActivated: fallback }
        })
    }

    async renameSession(
        id: string,
        displayName: string | null
    ): Promise<ChannelSessionRow | null> {
        const [updated] = await this.db
            .update(channelSessions)
            .set({ displayName, updatedAt: new Date() })
            .where(eq(channelSessions.id, id))
            .returning()
        return updated ?? null
    }

    async touchSessionInbound(id: string, when: Date): Promise<void> {
        await this.db
            .update(channelSessions)
            .set({ lastInboundAt: when, updatedAt: when })
            .where(eq(channelSessions.id, id))
    }

    async touchSessionOutbound(id: string, when: Date): Promise<void> {
        await this.db
            .update(channelSessions)
            .set({ lastOutboundAt: when, updatedAt: when })
            .where(eq(channelSessions.id, id))
    }

    async countScopesForChannel(channelId: string): Promise<number> {
        const [row] = await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(channelSessions)
            .where(eq(channelSessions.channelId, channelId))
        return row?.count ?? 0
    }

    async listSessionsForChannel(
        channelId: string,
        opts: {
            scopeKey?: string
            includeArchived?: boolean
        } = {}
    ): Promise<ChannelSessionWithChatTitle[]> {
        const filters = [eq(channelSessions.channelId, channelId)]
        if (opts.scopeKey)
            filters.push(eq(channelSessions.scopeKey, opts.scopeKey))
        if (!opts.includeArchived)
            filters.push(isNull(channelSessions.archivedAt))
        const rows = await this.db
            .select({
                session: channelSessions,
                chatTitle: chatSessions.title
            })
            .from(channelSessions)
            .leftJoin(
                chatSessions,
                eq(channelSessions.chatSessionId, chatSessions.id)
            )
            .where(and(...filters))
            .orderBy(
                asc(channelSessions.scopeKey),
                asc(channelSessions.createdAt),
                asc(channelSessions.id)
            )
        return rows.map((r) => ({
            session: r.session,
            chatTitle: r.chatTitle
        }))
    }

    async insertDelivery(
        row: NewChannelDeliveryRow
    ): Promise<ChannelDeliveryRow> {
        const [inserted] = await this.db
            .insert(channelDeliveries)
            .values(row)
            .returning()
        return inserted
    }

    async insertInboundEvent(row: {
        channelId: string
        providerEventId: string | null
        eventJson: Record<string, unknown>
        summaryText: string | null
        createdAt: Date
    }): Promise<{ delivery: ChannelDeliveryRow; created: boolean }> {
        try {
            const [inserted] = await this.db
                .insert(channelDeliveries)
                .values({
                    channelId: row.channelId,
                    chatSessionId: null,
                    chatMessageId: null,
                    direction: 'inbound',
                    scopeKey: 'pending',
                    providerEventId: row.providerEventId,
                    providerMessageId: row.providerEventId,
                    eventJson: row.eventJson,
                    summaryText: row.summaryText,
                    status: 'queued',
                    errorMessage: null,
                    createdAt: row.createdAt,
                    updatedAt: row.createdAt
                })
                .returning()
            return { delivery: inserted, created: true }
        } catch (err) {
            if (!row.providerEventId || !isUniqueViolation(err)) throw err
            const existing = await this.findInboundEvent(
                row.channelId,
                row.providerEventId
            )
            if (!existing) throw err
            return { delivery: existing, created: false }
        }
    }

    async findInboundEvent(
        channelId: string,
        providerEventId: string
    ): Promise<ChannelDeliveryRow | null> {
        const rows = await this.db
            .select()
            .from(channelDeliveries)
            .where(
                and(
                    eq(channelDeliveries.channelId, channelId),
                    eq(channelDeliveries.direction, 'inbound'),
                    eq(channelDeliveries.providerEventId, providerEventId)
                )
            )
            .limit(1)
        return rows[0] ?? null
    }

    // The durable reply-expectation row for a turn, if one was recorded.
    // Used by crash recovery to make pending-row creation idempotent.
    async findOutboundByChatMessageId(
        channelId: string,
        chatMessageId: string
    ): Promise<ChannelDeliveryRow | null> {
        const rows = await this.db
            .select()
            .from(channelDeliveries)
            .where(
                and(
                    eq(channelDeliveries.channelId, channelId),
                    eq(channelDeliveries.direction, 'outbound'),
                    eq(channelDeliveries.chatMessageId, chatMessageId)
                )
            )
            .limit(1)
        return rows[0] ?? null
    }

    async findLatestDeliveryByProviderMessageId(
        channelId: string,
        providerMessageId: string
    ): Promise<ChannelDeliveryRow | null> {
        const rows = await this.db
            .select()
            .from(channelDeliveries)
            .where(
                and(
                    eq(channelDeliveries.channelId, channelId),
                    eq(
                        channelDeliveries.providerMessageId,
                        providerMessageId
                    )
                )
            )
            .orderBy(desc(channelDeliveries.createdAt))
            .limit(1)
        return rows[0] ?? null
    }

    async updateDelivery(
        id: bigint,
        patch: Partial<NewChannelDeliveryRow>
    ): Promise<ChannelDeliveryRow | null> {
        const [updated] = await this.db
            .update(channelDeliveries)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(channelDeliveries.id, id))
            .returning()
        return updated ?? null
    }

    async claimInboundEvent(
        id: bigint,
        staleBefore: Date
    ): Promise<ChannelDeliveryRow | null> {
        const [claimed] = await this.db
            .update(channelDeliveries)
            .set({
                status: 'processing',
                errorMessage: null,
                attemptCount: sql`${channelDeliveries.attemptCount} + 1`,
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(channelDeliveries.id, id),
                    eq(channelDeliveries.direction, 'inbound'),
                    or(
                        eq(channelDeliveries.status, 'queued'),
                        eq(channelDeliveries.status, 'failed'),
                        and(
                            eq(channelDeliveries.status, 'processing'),
                            lt(channelDeliveries.updatedAt, staleBefore)
                        )
                    )
                )
            )
            .returning()
        return claimed ?? null
    }

    async listRecoverableInboundEvents(
        staleBefore: Date,
        limit = 100
    ): Promise<ChannelDeliveryRow[]> {
        return this.db
            .select()
            .from(channelDeliveries)
            .where(
                and(
                    eq(channelDeliveries.direction, 'inbound'),
                    or(
                        eq(channelDeliveries.status, 'queued'),
                        eq(channelDeliveries.status, 'failed'),
                        and(
                            eq(channelDeliveries.status, 'processing'),
                            lt(channelDeliveries.updatedAt, staleBefore)
                        )
                    ),
                    or(
                        isNull(channelDeliveries.nextAttemptAt),
                        lte(channelDeliveries.nextAttemptAt, new Date())
                    )
                )
            )
            .orderBy(asc(channelDeliveries.createdAt))
            .limit(limit)
    }

    async countQueuedInboundForScope(
        channelId: string,
        scopeKey: string
    ): Promise<number> {
        const [row] = await this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(channelDeliveries)
            .where(inflightQueuedScopeFilter(channelId, scopeKey))
        return row?.count ?? 0
    }

    // Merge the scope's queued inbound rows into a single carrier row inside
    // one transaction (SELECT ... FOR UPDATE): the caller's pure `compose`
    // decides what merges; merged rows flip to accepted in the same commit so
    // a crash can never lose a message (worst case they replay individually).
    // Returns the row to replay next: the carrier when a merge happened, the
    // FIFO head when not, null when the queue is empty.
    async collectQueuedInboundForScope(
        channelId: string,
        scopeKey: string,
        compose: (rows: ChannelDeliveryRow[]) => {
            carrierId: bigint
            mergedIds: bigint[]
            eventJson: Record<string, unknown>
            summaryText: string
        } | null
    ): Promise<ChannelDeliveryRow | null> {
        return this.db.transaction(async (tx) => {
            const rows = await tx
                .select()
                .from(channelDeliveries)
                .where(inflightQueuedScopeFilter(channelId, scopeKey))
                .orderBy(
                    asc(channelDeliveries.createdAt),
                    asc(channelDeliveries.id)
                )
                .for('update')
            if (rows.length === 0) return null
            const composed = compose(rows)
            if (!composed) return rows[0]
            const now = new Date()
            const [carrier] = await tx
                .update(channelDeliveries)
                .set({
                    eventJson: composed.eventJson,
                    summaryText: composed.summaryText,
                    updatedAt: now
                })
                .where(eq(channelDeliveries.id, composed.carrierId))
                .returning()
            if (composed.mergedIds.length > 0)
                await tx
                    .update(channelDeliveries)
                    .set({
                        status: 'accepted',
                        errorMessage: `merged_into:${composed.carrierId}`,
                        updatedAt: now
                    })
                    .where(inArray(channelDeliveries.id, composed.mergedIds))
            return carrier ?? null
        })
    }

    // Ignores nextAttemptAt on purpose so the post-finalize drain kick can pick
    // up a row before its 15s requeue backoff elapses; the claimInboundEvent CAS
    // still makes kick-vs-sweep a single winner.
    async nextQueuedInboundForScope(
        channelId: string,
        scopeKey: string
    ): Promise<ChannelDeliveryRow | null> {
        const rows = await this.db
            .select()
            .from(channelDeliveries)
            .where(inflightQueuedScopeFilter(channelId, scopeKey))
            .orderBy(
                asc(channelDeliveries.createdAt),
                asc(channelDeliveries.id)
            )
            .limit(1)
        return rows[0] ?? null
    }

    async dropQueuedInboundForScope(
        channelId: string,
        scopeKey: string
    ): Promise<number> {
        const rows = await this.db
            .update(channelDeliveries)
            .set({
                status: 'dropped',
                errorMessage: 'stopped_by_user',
                updatedAt: new Date()
            })
            .where(inflightQueuedScopeFilter(channelId, scopeKey))
            .returning({ id: channelDeliveries.id })
        return rows.length
    }

    async tryAcquireChannelLease(
        channelId: string,
        holderId: string,
        ttlMs: number
    ): Promise<boolean> {
        const now = new Date()
        const expiresAt = new Date(now.getTime() + ttlMs)
        try {
            const rows = await this.db
                .insert(channelLeases)
                .values({
                    channelId,
                    holderId,
                    acquiredAt: now,
                    expiresAt,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: channelLeases.channelId,
                    set: { holderId, expiresAt, updatedAt: now },
                    setWhere: or(
                        eq(channelLeases.holderId, holderId),
                        lt(channelLeases.expiresAt, now)
                    )
                })
                .returning()
            return rows.length > 0
        } catch (err) {
            if (isForeignKeyViolation(err)) return false
            throw err
        }
    }

    async forceAcquireChannelLease(
        channelId: string,
        holderId: string,
        ttlMs: number
    ): Promise<void> {
        const now = new Date()
        const expiresAt = new Date(now.getTime() + ttlMs)
        try {
            await this.db
                .insert(channelLeases)
                .values({
                    channelId,
                    holderId,
                    acquiredAt: now,
                    expiresAt,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: channelLeases.channelId,
                    set: {
                        holderId,
                        acquiredAt: now,
                        expiresAt,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isForeignKeyViolation(err)) throw err
        }
    }

    // Renew every lease this holder still owns in one statement instead of
    // one upsert per channel per tick. Channels missing from the result lost
    // their lease (another holder took it) and must be stopped.
    async renewChannelLeases(
        holderId: string,
        channelIds: string[],
        ttlMs: number
    ): Promise<string[]> {
        if (channelIds.length === 0) return []
        const now = new Date()
        const rows = await this.db
            .update(channelLeases)
            .set({
                expiresAt: new Date(now.getTime() + ttlMs),
                updatedAt: now
            })
            .where(
                and(
                    eq(channelLeases.holderId, holderId),
                    inArray(channelLeases.channelId, channelIds)
                )
            )
            .returning({ channelId: channelLeases.channelId })
        return rows.map((r) => r.channelId)
    }

    async releaseChannelLease(
        channelId: string,
        holderId: string
    ): Promise<void> {
        await this.db
            .delete(channelLeases)
            .where(
                and(
                    eq(channelLeases.channelId, channelId),
                    eq(channelLeases.holderId, holderId)
                )
            )
    }

    async releaseChannelLeasesByHolder(holderId: string): Promise<void> {
        await this.db
            .delete(channelLeases)
            .where(eq(channelLeases.holderId, holderId))
    }

    // Take over a reply-expectation row. CAS on status='pending' guarantees the
    // inline finalize and the reconcile sweep cannot both deliver: whoever
    // resolves the row first owns the send, the loser sees null and backs off.
    async resolvePendingDelivery(
        id: bigint,
        patch: Partial<NewChannelDeliveryRow>
    ): Promise<ChannelDeliveryRow | null> {
        const [resolved] = await this.db
            .update(channelDeliveries)
            .set({ ...patch, updatedAt: new Date() })
            .where(
                and(
                    eq(channelDeliveries.id, id),
                    eq(channelDeliveries.direction, 'outbound'),
                    eq(channelDeliveries.status, 'pending')
                )
            )
            .returning()
        return resolved ?? null
    }

    async listStalePendingOutbound(
        olderThan: Date,
        limit = 50
    ): Promise<ChannelDeliveryRow[]> {
        return this.db
            .select()
            .from(channelDeliveries)
            .where(
                and(
                    eq(channelDeliveries.direction, 'outbound'),
                    eq(channelDeliveries.status, 'pending'),
                    lt(channelDeliveries.updatedAt, olderThan)
                )
            )
            .orderBy(asc(channelDeliveries.createdAt))
            .limit(limit)
    }

    async listDueOutboundDeliveries(
        staleBefore: Date,
        limit = 50
    ): Promise<ChannelDeliveryRow[]> {
        return this.db
            .select()
            .from(channelDeliveries)
            .where(
                and(
                    eq(channelDeliveries.direction, 'outbound'),
                    isNotNull(channelDeliveries.nextAttemptAt),
                    lte(channelDeliveries.nextAttemptAt, new Date()),
                    or(
                        eq(channelDeliveries.status, 'queued'),
                        eq(channelDeliveries.status, 'failed'),
                        and(
                            eq(channelDeliveries.status, 'processing'),
                            lt(channelDeliveries.updatedAt, staleBefore)
                        )
                    )
                )
            )
            .orderBy(asc(channelDeliveries.createdAt))
            .limit(limit)
    }

    async claimOutboundDelivery(
        id: bigint,
        staleBefore: Date
    ): Promise<ChannelDeliveryRow | null> {
        const [claimed] = await this.db
            .update(channelDeliveries)
            .set({
                status: 'processing',
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(channelDeliveries.id, id),
                    eq(channelDeliveries.direction, 'outbound'),
                    or(
                        eq(channelDeliveries.status, 'queued'),
                        eq(channelDeliveries.status, 'failed'),
                        and(
                            eq(channelDeliveries.status, 'processing'),
                            lt(channelDeliveries.updatedAt, staleBefore)
                        )
                    )
                )
            )
            .returning()
        return claimed ?? null
    }

    // Retry dedup for agent-initiated sends. providerEventId is the inbound
    // dedup key and is null on outbound rows, so reusing it here costs nothing
    // and gives the retry a durable record that survives a process restart. The
    // existing unique index is inbound-only, so this is a read-side check
    // rather than a constraint — see NarraNexusSyncService.channelSend.
    async findAgentSendByKey(
        channelId: string,
        key: string
    ): Promise<ChannelDeliveryRow | null> {
        const rows = await this.db
            .select()
            .from(channelDeliveries)
            .where(
                and(
                    eq(channelDeliveries.channelId, channelId),
                    eq(channelDeliveries.direction, 'outbound'),
                    eq(channelDeliveries.providerEventId, key)
                )
            )
            .limit(1)
        return rows[0] ?? null
    }

    // "Has anyone actually talked to us in this room?" Every provider's
    // computeScopeKey embeds the chat id, but the surrounding shape differs per
    // provider and per chat type, so the room is matched inside the key rather
    // than reconstructed — in both raw and percent-encoded form, since some
    // providers encode it. Scoped to one channel, which the unique index on
    // (channel_id, scope_key) already clusters.
    async hasSessionForRoom(channelId: string, roomId: string): Promise<boolean> {
        const encoded = encodeURIComponent(roomId)
        const rows = await this.db
            .select({ id: channelSessions.id })
            .from(channelSessions)
            .where(
                and(
                    eq(channelSessions.channelId, channelId),
                    or(
                        like(channelSessions.scopeKey, `%${roomId}%`),
                        like(channelSessions.scopeKey, `%${encoded}%`)
                    )
                )
            )
            .limit(1)
        return rows.length > 0
    }

    async listDeliveries(
        channelId: string,
        limit = 50
    ): Promise<ChannelDeliveryRow[]> {
        return this.db
            .select()
            .from(channelDeliveries)
            .where(eq(channelDeliveries.channelId, channelId))
            .orderBy(desc(channelDeliveries.id))
            .limit(limit)
    }

    // Per-channel delivery counts over a window, served by
    // channel_deliveries_channel_created_idx (channel_id, created_at).
    //
    // `system` rows are bookkeeping, not messages, so they are excluded. An
    // outbound row is UPDATED in place through pending -> queued -> sent
    // rather than re-inserted, so one row is one message; restricting to the
    // delivered statuses keeps abandoned attempts out of a number the UI
    // labels "messages".
    async deliveryCountsByChannel(
        channelIds: string[],
        since: Date
    ): Promise<Map<string, { inbound: number; outbound: number }>> {
        const out = new Map<string, { inbound: number; outbound: number }>()
        if (channelIds.length === 0) return out
        const rows = await this.db
            .select({
                channelId: channelDeliveries.channelId,
                inbound: sql<string>`count(*) filter (where ${channelDeliveries.direction} = 'inbound')`,
                outbound: sql<string>`count(*) filter (where ${channelDeliveries.direction} = 'outbound' and ${channelDeliveries.status} in ('sent', 'accepted'))`
            })
            .from(channelDeliveries)
            .where(
                and(
                    inArray(channelDeliveries.channelId, channelIds),
                    gte(channelDeliveries.createdAt, since)
                )
            )
            .groupBy(channelDeliveries.channelId)
        for (const r of rows)
            out.set(r.channelId, {
                inbound: Number(r.inbound),
                outbound: Number(r.outbound)
            })
        return out
    }

    // Last inbound/outbound stamps per channel. channel_sessions rows are
    // never pruned (archiving only sets archived_at), so archived sessions are
    // included deliberately — their messages really happened, and this is the
    // only lifetime activity stamp the schema has.
    async sessionActivityByChannel(
        channelIds: string[]
    ): Promise<
        Map<string, { lastInboundAt: Date | null; lastOutboundAt: Date | null }>
    > {
        const out = new Map<
            string,
            { lastInboundAt: Date | null; lastOutboundAt: Date | null }
        >()
        if (channelIds.length === 0) return out
        const rows = await this.db
            .select({
                channelId: channelSessions.channelId,
                lastInboundAt: sql<
                    Date | null
                >`max(${channelSessions.lastInboundAt})`,
                lastOutboundAt: sql<
                    Date | null
                >`max(${channelSessions.lastOutboundAt})`
            })
            .from(channelSessions)
            .where(inArray(channelSessions.channelId, channelIds))
            .groupBy(channelSessions.channelId)
        for (const r of rows)
            out.set(r.channelId, {
                lastInboundAt: r.lastInboundAt
                    ? new Date(r.lastInboundAt)
                    : null,
                lastOutboundAt: r.lastOutboundAt
                    ? new Date(r.lastOutboundAt)
                    : null
            })
        return out
    }

    // One retention batch: delete the oldest rows (PK order ≈ insertion order
    // for a bigserial log table) that fall behind the cutoff. Walking the PK
    // from the head keeps this O(batch) even when nothing qualifies, without
    // needing a created_at index. Callers loop while a full batch was deleted.
    async pruneDeliveries(cutoff: Date, batchSize: number): Promise<number> {
        const oldest = this.db
            .select({ id: channelDeliveries.id })
            .from(channelDeliveries)
            .orderBy(asc(channelDeliveries.id))
            .limit(batchSize)
        const deleted = await this.db
            .delete(channelDeliveries)
            .where(
                and(
                    inArray(channelDeliveries.id, oldest),
                    lt(channelDeliveries.createdAt, cutoff)
                )
            )
            .returning({ id: channelDeliveries.id })
        return deleted.length
    }

    async getProviderState(
        channelId: string
    ): Promise<ChannelProviderStateRow | null> {
        const rows = await this.db
            .select()
            .from(channelProviderStates)
            .where(eq(channelProviderStates.channelId, channelId))
            .limit(1)
        return rows[0] ?? null
    }

    async upsertProviderState(
        row: NewChannelProviderStateRow
    ): Promise<ChannelProviderStateRow> {
        const now = new Date()
        const [upserted] = await this.db
            .insert(channelProviderStates)
            .values(row)
            .onConflictDoUpdate({
                target: channelProviderStates.channelId,
                set: {
                    stateJson: row.stateJson,
                    updatedAt: now
                }
            })
            .returning()
        return upserted
    }
}

const inflightQueuedScopeFilter = (channelId: string, scopeKey: string) =>
    and(
        eq(channelDeliveries.channelId, channelId),
        eq(channelDeliveries.direction, 'inbound'),
        eq(channelDeliveries.status, 'queued'),
        eq(channelDeliveries.errorMessage, INFLIGHT_QUEUE_REASON),
        eq(channelDeliveries.scopeKey, scopeKey)
    )

const isUniqueViolation = (err: unknown): boolean => {
    const code = (err as { code?: string } | null)?.code
    if (code === '23505') return true
    const message = (err as Error | null)?.message ?? ''
    return message.toLowerCase().includes('unique')
}

const isForeignKeyViolation = (err: unknown): boolean =>
    (err as { code?: string } | null)?.code === '23503'
