import type {
    AgentFramework,
    AgentRuntime,
    UsageBucket,
    UsageEventSummary,
    UsageQuery,
    UsageSessionSummary,
    UsageSummary,
    UsageSummaryByModel,
    UsageTimeSeriesPoint,
    UsageTopAgent,
    UsageTopUser
} from '@manyfold/shared'
import { Inject, Injectable } from '@nestjs/common'
import { and, desc, eq, gte, isNotNull, lt, sql, type SQL } from 'drizzle-orm'
import {
    agentUsageEvents,
    agents,
    turnExecutions,
    users,
    type Database,
    type NewAgentUsageEventRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

const parseDate = (v?: string): Date | null => {
    if (!v) return null
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
}

const toNumber = (v: string | null | number): number => {
    if (v === null) return 0
    return typeof v === 'number' ? v : Number(v)
}

@Injectable()
export class UsageRepository {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async insert(
        row: NewAgentUsageEventRow,
        fence?: { messageId: string; ownerId: string; generation: number }
    ): Promise<boolean> {
        if (fence && row.messageId !== fence.messageId) return false
        if (fence)
            return this.db.transaction(async (tx) => {
                const [owned] = await tx
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
                if (!owned) return false
                const inserted = await tx
                    .insert(agentUsageEvents)
                    .values(row)
                    .onConflictDoNothing({ target: agentUsageEvents.messageId })
                    .returning({ id: agentUsageEvents.id })
                return inserted.length > 0
            })
        const inserted = await this.db
            .insert(agentUsageEvents)
            .values(row)
            .onConflictDoNothing({ target: agentUsageEvents.messageId })
            .returning({ id: agentUsageEvents.id })
        return inserted.length > 0
    }

    private buildFilters(query: UsageQuery): SQL[] {
        const conds: SQL[] = []
        if (query.userId) conds.push(eq(agentUsageEvents.userId, query.userId))
        if (query.runtimeId)
            conds.push(eq(agentUsageEvents.runtimeId, query.runtimeId))
        if (query.agentId)
            conds.push(eq(agentUsageEvents.agentId, query.agentId))
        if (query.sessionId)
            conds.push(eq(agentUsageEvents.sessionId, query.sessionId))
        if (query.framework)
            conds.push(eq(agentUsageEvents.framework, query.framework))
        const from = parseDate(query.from)
        if (from) conds.push(gte(agentUsageEvents.createdAt, from))
        const to = parseDate(query.to)
        if (to) conds.push(lt(agentUsageEvents.createdAt, to))
        return conds
    }

    async summary(query: UsageQuery): Promise<UsageSummary> {
        const conds = this.buildFilters(query)
        const whereExpr = conds.length ? and(...conds) : undefined

        const byModel = await this.db
            .select({
                model: agentUsageEvents.model,
                framework: agentUsageEvents.framework,
                runtimeKind: agentUsageEvents.runtimeKind,
                inputTokens: sql<string>`coalesce(sum(${agentUsageEvents.inputTokens}), 0)`,
                outputTokens: sql<string>`coalesce(sum(${agentUsageEvents.outputTokens}), 0)`,
                cacheReadTokens: sql<string>`coalesce(sum(${agentUsageEvents.cacheReadTokens}), 0)`,
                cacheCreationTokens: sql<string>`coalesce(sum(${agentUsageEvents.cacheCreationTokens}), 0)`,
                costUsd: sql<string | null>`sum(${agentUsageEvents.costUsd})`,
                eventCount: sql<string>`count(*)`,
                fallbackEventCount: sql<string>`coalesce(sum(case when ${agentUsageEvents.isFallbackModel} then 1 else 0 end), 0)`,
                isFallback: sql<boolean>`bool_or(${agentUsageEvents.isFallbackModel})`
            })
            .from(agentUsageEvents)
            .where(whereExpr)
            .groupBy(
                agentUsageEvents.model,
                agentUsageEvents.framework,
                agentUsageEvents.runtimeKind
            )

        const byModelOut: UsageSummaryByModel[] = byModel.map((r) => ({
            model: r.model,
            framework: r.framework as AgentFramework,
            runtimeKind: r.runtimeKind as AgentRuntime,
            inputTokens: Number(r.inputTokens),
            outputTokens: Number(r.outputTokens),
            cacheReadTokens: Number(r.cacheReadTokens),
            cacheCreationTokens: Number(r.cacheCreationTokens),
            costUsd: r.costUsd === null ? null : Number(r.costUsd),
            eventCount: Number(r.eventCount),
            fallbackEventCount: Number(r.fallbackEventCount),
            isFallback: r.isFallback
        }))

        const totals = byModelOut.reduce(
            (acc, r) => {
                acc.totalInputTokens += r.inputTokens
                acc.totalOutputTokens += r.outputTokens
                acc.totalCacheReadTokens += r.cacheReadTokens
                acc.totalCacheCreationTokens += r.cacheCreationTokens
                if (r.costUsd !== null) {
                    acc.totalCostUsd = (acc.totalCostUsd ?? 0) + r.costUsd
                }
                acc.eventCount += r.eventCount
                acc.fallbackEventCount += r.fallbackEventCount
                return acc
            },
            {
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCacheReadTokens: 0,
                totalCacheCreationTokens: 0,
                totalCostUsd: null as number | null,
                eventCount: 0,
                fallbackEventCount: 0
            }
        )

        return { ...totals, byModel: byModelOut }
    }

    async timeseries(
        query: UsageQuery,
        bucket: UsageBucket
    ): Promise<UsageTimeSeriesPoint[]> {
        const conds = this.buildFilters(query)
        const whereExpr = conds.length ? and(...conds) : undefined
        const bucketExpr =
            bucket === 'hour'
                ? sql<Date>`date_trunc('hour', ${agentUsageEvents.createdAt})`
                : sql<Date>`date_trunc('day', ${agentUsageEvents.createdAt})`

        const rows = await this.db
            .select({
                bucket: bucketExpr,
                inputTokens: sql<string>`coalesce(sum(${agentUsageEvents.inputTokens}), 0)`,
                outputTokens: sql<string>`coalesce(sum(${agentUsageEvents.outputTokens}), 0)`,
                cacheReadTokens: sql<string>`coalesce(sum(${agentUsageEvents.cacheReadTokens}), 0)`,
                cacheCreationTokens: sql<string>`coalesce(sum(${agentUsageEvents.cacheCreationTokens}), 0)`,
                costUsd: sql<string | null>`sum(${agentUsageEvents.costUsd})`,
                eventCount: sql<string>`count(*)`,
                fallbackEventCount: sql<string>`coalesce(sum(case when ${agentUsageEvents.isFallbackModel} then 1 else 0 end), 0)`
            })
            .from(agentUsageEvents)
            .where(whereExpr)
            .groupBy(bucketExpr)
            .orderBy(bucketExpr)

        return rows.map((r) => ({
            bucket: new Date(r.bucket).toISOString(),
            inputTokens: Number(r.inputTokens),
            outputTokens: Number(r.outputTokens),
            cacheReadTokens: Number(r.cacheReadTokens),
            cacheCreationTokens: Number(r.cacheCreationTokens),
            costUsd: r.costUsd === null ? null : Number(r.costUsd),
            eventCount: Number(r.eventCount),
            fallbackEventCount: Number(r.fallbackEventCount)
        }))
    }

    async sessions(query: UsageQuery): Promise<UsageSessionSummary[]> {
        const conds = this.buildFilters(query)
        conds.push(isNotNull(agentUsageEvents.sessionId))
        const whereExpr = conds.length ? and(...conds) : undefined

        const rows = await this.db
            .select({
                sessionId: agentUsageEvents.sessionId,
                agentId: agentUsageEvents.agentId,
                runtimeId: agentUsageEvents.runtimeId,
                framework: agentUsageEvents.framework,
                runtimeKind: agentUsageEvents.runtimeKind,
                inputTokens: sql<string>`coalesce(sum(${agentUsageEvents.inputTokens}), 0)`,
                outputTokens: sql<string>`coalesce(sum(${agentUsageEvents.outputTokens}), 0)`,
                cacheReadTokens: sql<string>`coalesce(sum(${agentUsageEvents.cacheReadTokens}), 0)`,
                cacheCreationTokens: sql<string>`coalesce(sum(${agentUsageEvents.cacheCreationTokens}), 0)`,
                costUsd: sql<string | null>`sum(${agentUsageEvents.costUsd})`,
                eventCount: sql<string>`count(*)`,
                fallbackEventCount: sql<string>`coalesce(sum(case when ${agentUsageEvents.isFallbackModel} then 1 else 0 end), 0)`,
                startedAt: sql<Date>`min(${agentUsageEvents.createdAt})`,
                lastActivityAt: sql<Date>`max(${agentUsageEvents.createdAt})`
            })
            .from(agentUsageEvents)
            .where(whereExpr)
            .groupBy(
                agentUsageEvents.sessionId,
                agentUsageEvents.agentId,
                agentUsageEvents.runtimeId,
                agentUsageEvents.framework,
                agentUsageEvents.runtimeKind
            )
            .orderBy(sql`max(${agentUsageEvents.createdAt}) desc`)

        return rows
            .filter((r) => r.sessionId !== null)
            .map((r) => ({
                sessionId: r.sessionId as string,
                agentId: r.agentId,
                runtimeId: r.runtimeId,
                framework: r.framework as AgentFramework,
                runtimeKind: r.runtimeKind as AgentRuntime,
                inputTokens: Number(r.inputTokens),
                outputTokens: Number(r.outputTokens),
                cacheReadTokens: Number(r.cacheReadTokens),
                cacheCreationTokens: Number(r.cacheCreationTokens),
                costUsd: r.costUsd === null ? null : Number(r.costUsd),
                eventCount: Number(r.eventCount),
                fallbackEventCount: Number(r.fallbackEventCount),
                startedAt: new Date(r.startedAt).toISOString(),
                lastActivityAt: new Date(r.lastActivityAt).toISOString()
            }))
    }

    async listEvents(
        query: UsageQuery,
        opts: { limit: number; cursor: string | null }
    ): Promise<{ items: UsageEventSummary[]; nextCursor: string | null }> {
        const conds = this.buildFilters(query)
        if (opts.cursor) {
            const cursorDate = new Date(opts.cursor)
            if (!Number.isNaN(cursorDate.getTime()))
                conds.push(lt(agentUsageEvents.createdAt, cursorDate))
        }
        const whereExpr = conds.length ? and(...conds) : undefined
        const rows = await this.db
            .select()
            .from(agentUsageEvents)
            .where(whereExpr)
            .orderBy(desc(agentUsageEvents.createdAt))
            .limit(opts.limit + 1)

        const page = rows.slice(0, opts.limit)
        const next = rows.length > opts.limit ? rows[opts.limit - 1] : null
        const nextCursor =
            next && rows.length > opts.limit
                ? next.createdAt.toISOString()
                : null

        const items: UsageEventSummary[] = page.map((r) => ({
            id: r.id,
            userId: r.userId,
            agentId: r.agentId,
            runtimeId: r.runtimeId,
            sessionId: r.sessionId,
            messageId: r.messageId,
            framework: r.framework as AgentFramework,
            runtimeKind: r.runtimeKind as AgentRuntime,
            model: r.model,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            cacheReadTokens: r.cacheReadTokens,
            cacheCreationTokens: r.cacheCreationTokens,
            costUsd: r.costUsd === null ? null : toNumber(r.costUsd),
            costSource: r.costSource as 'upstream' | 'table' | 'unknown',
            isFallbackModel: r.isFallbackModel,
            firstTokenMs: r.firstTokenMs,
            totalMs: r.totalMs,
            createdAt: r.createdAt.toISOString()
        }))

        return { items, nextCursor }
    }

    async topAgents(
        from: Date | null,
        to: Date | null,
        limit: number,
        userId?: string
    ): Promise<UsageTopAgent[]> {
        const conds: SQL[] = []
        if (from) conds.push(gte(agentUsageEvents.createdAt, from))
        if (to) conds.push(lt(agentUsageEvents.createdAt, to))
        if (userId) conds.push(eq(agentUsageEvents.userId, userId))
        const whereExpr = conds.length ? and(...conds) : undefined

        const rows = await this.db
            .select({
                agentId: agentUsageEvents.agentId,
                name: agents.name,
                framework: agents.framework,
                runtimeKind: agents.runtime,
                userId: agentUsageEvents.userId,
                userEmail: users.email,
                inputTokens: sql<string>`coalesce(sum(${agentUsageEvents.inputTokens}), 0)`,
                outputTokens: sql<string>`coalesce(sum(${agentUsageEvents.outputTokens}), 0)`,
                costUsd: sql<string | null>`sum(${agentUsageEvents.costUsd})`,
                eventCount: sql<string>`count(*)`
            })
            .from(agentUsageEvents)
            .leftJoin(agents, eq(agents.id, agentUsageEvents.agentId))
            .leftJoin(users, eq(users.id, agentUsageEvents.userId))
            .where(whereExpr)
            .groupBy(
                agentUsageEvents.agentId,
                agents.name,
                agents.framework,
                agents.runtime,
                agentUsageEvents.userId,
                users.email
            )
            .orderBy(sql`sum(${agentUsageEvents.costUsd}) desc nulls last`)
            .limit(limit)

        return rows
            .filter((r) => r.agentId !== null)
            .map((r) => ({
                agentId: r.agentId as string,
                name: r.name ?? null,
                framework: (r.framework ?? null) as AgentFramework | null,
                runtimeKind: (r.runtimeKind ?? null) as AgentRuntime | null,
                userId: r.userId,
                userEmail: r.userEmail,
                inputTokens: Number(r.inputTokens),
                outputTokens: Number(r.outputTokens),
                costUsd: r.costUsd === null ? null : Number(r.costUsd),
                eventCount: Number(r.eventCount)
            }))
    }

    async topUsers(
        from: Date | null,
        to: Date | null,
        limit: number
    ): Promise<UsageTopUser[]> {
        const conds: SQL[] = []
        if (from) conds.push(gte(agentUsageEvents.createdAt, from))
        if (to) conds.push(lt(agentUsageEvents.createdAt, to))
        const whereExpr = conds.length ? and(...conds) : undefined

        const rows = await this.db
            .select({
                userId: agentUsageEvents.userId,
                email: users.email,
                inputTokens: sql<string>`coalesce(sum(${agentUsageEvents.inputTokens}), 0)`,
                outputTokens: sql<string>`coalesce(sum(${agentUsageEvents.outputTokens}), 0)`,
                costUsd: sql<string | null>`sum(${agentUsageEvents.costUsd})`,
                eventCount: sql<string>`count(*)`
            })
            .from(agentUsageEvents)
            .leftJoin(users, eq(users.id, agentUsageEvents.userId))
            .where(whereExpr)
            .groupBy(agentUsageEvents.userId, users.email)
            .orderBy(sql`sum(${agentUsageEvents.costUsd}) desc nulls last`)
            .limit(limit)

        return rows.map((r) => ({
            userId: r.userId,
            email: r.email,
            inputTokens: Number(r.inputTokens),
            outputTokens: Number(r.outputTokens),
            costUsd: r.costUsd === null ? null : Number(r.costUsd),
            eventCount: Number(r.eventCount)
        }))
    }
}
