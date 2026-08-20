import { Inject, Injectable } from '@nestjs/common'
import { and, count, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm'
import { a2aTasks, type A2aTask, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

export type A2aTaskState = A2aTask['state']

export interface A2aTaskScope {
    targetAgentId: string
    callerAgentId: string | null
    externalSubject: string | null
}

export interface CreateA2aTaskInput {
    id: string
    userId: string
    targetAgentId: string
    callerAgentId: string | null
    externalSubject: string | null
    contextId: string
    chatSessionId: string
    clientMessageId: string
}

export interface UpdateA2aTaskInput {
    state?: A2aTaskState
    userMessageId?: string | null
    assistantMessageId?: string | null
    artifactJson?: Record<string, unknown> | null
    errorJson?: Record<string, unknown> | null
    usageJson?: Record<string, unknown> | null
    completedAt?: Date | null
}

export interface ListA2aTasksOptions {
    limit: number
    beforeCreatedAt?: Date
    beforeId?: string
    state?: A2aTaskState
    contextId?: string
}

// Tasks are only visible to the identity that created them: a bound caller
// Agent, or an external token subject. A token with neither only sees tasks
// with no caller binding. This is the contextId/task non-leak gate — never
// resolve by raw chat_sessions.id.
const scopeCondition = (scope: A2aTaskScope): SQL | undefined => {
    if (scope.callerAgentId)
        return and(
            eq(a2aTasks.targetAgentId, scope.targetAgentId),
            eq(a2aTasks.callerAgentId, scope.callerAgentId)
        )
    if (scope.externalSubject)
        return and(
            eq(a2aTasks.targetAgentId, scope.targetAgentId),
            eq(a2aTasks.externalSubject, scope.externalSubject)
        )
    return and(
        eq(a2aTasks.targetAgentId, scope.targetAgentId),
        isNull(a2aTasks.callerAgentId),
        isNull(a2aTasks.externalSubject)
    )
}

@Injectable()
export class A2aTaskRepository {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async create(input: CreateA2aTaskInput): Promise<A2aTask> {
        const [row] = await this.db
            .insert(a2aTasks)
            .values({
                id: input.id,
                userId: input.userId,
                targetAgentId: input.targetAgentId,
                callerAgentId: input.callerAgentId,
                externalSubject: input.externalSubject,
                contextId: input.contextId,
                chatSessionId: input.chatSessionId,
                clientMessageId: input.clientMessageId,
                state: 'submitted'
            })
            .returning()
        return row
    }

    // Count this user's not-yet-terminal A2A tasks. Used to bound runaway
    // peer-delegation recursion before starting another billable turn.
    async countInflightForUser(userId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(a2aTasks)
            .where(
                and(
                    eq(a2aTasks.userId, userId),
                    inArray(a2aTasks.state, ['submitted', 'working'])
                )
            )
        return row?.value ?? 0
    }

    async findById(
        taskId: string,
        scope: A2aTaskScope
    ): Promise<A2aTask | null> {
        const [row] = await this.db
            .select()
            .from(a2aTasks)
            .where(and(eq(a2aTasks.id, taskId), scopeCondition(scope)))
            .limit(1)
        return row ?? null
    }

    async findByContext(
        contextId: string,
        scope: A2aTaskScope
    ): Promise<A2aTask | null> {
        const [row] = await this.db
            .select()
            .from(a2aTasks)
            .where(and(eq(a2aTasks.contextId, contextId), scopeCondition(scope)))
            .orderBy(desc(a2aTasks.createdAt))
            .limit(1)
        return row ?? null
    }

    async findByClientMessage(
        chatSessionId: string,
        clientMessageId: string
    ): Promise<A2aTask | null> {
        const [row] = await this.db
            .select()
            .from(a2aTasks)
            .where(
                and(
                    eq(a2aTasks.chatSessionId, chatSessionId),
                    eq(a2aTasks.clientMessageId, clientMessageId)
                )
            )
            .limit(1)
        return row ?? null
    }

    async update(taskId: string, patch: UpdateA2aTaskInput): Promise<void> {
        await this.db
            .update(a2aTasks)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(a2aTasks.id, taskId))
    }

    // Conditional write that only applies while the task is still non-terminal.
    // The turn's final write, a cancel, and the stale sweep all race for the
    // terminal transition; an unconditional last-writer-wins update would let the
    // sweep clobber a just-completed artifact, or resurrect a canceled task.
    // Returns true iff a row was updated.
    async updateIfActive(
        taskId: string,
        patch: UpdateA2aTaskInput
    ): Promise<boolean> {
        const rows = await this.db
            .update(a2aTasks)
            .set({ ...patch, updatedAt: new Date() })
            .where(
                and(
                    eq(a2aTasks.id, taskId),
                    inArray(a2aTasks.state, ['submitted', 'working'])
                )
            )
            .returning({ id: a2aTasks.id })
        return rows.length > 0
    }

    // Non-terminal tasks last touched before `olderThan` — orphans left behind
    // by an API restart (or a wedged turn) that no longer have an in-process
    // runTurn to terminalize them. The stale sweep force-fails these so an
    // async caller polling tasks/get never sees a perpetual 'working'.
    async listStaleInflight(
        olderThan: Date,
        limit: number
    ): Promise<A2aTask[]> {
        return this.db
            .select()
            .from(a2aTasks)
            .where(
                and(
                    inArray(a2aTasks.state, ['submitted', 'working']),
                    lt(a2aTasks.updatedAt, olderThan)
                )
            )
            .orderBy(a2aTasks.updatedAt)
            .limit(limit)
    }

    // Owner-facing trace: every task where this agent was the target
    // (inbound) or the caller (outbound), scoped to the owning user. Unlike
    // list(), this is keyed on the owning user session, not an A2A token identity.
    // `direction` narrows to inbound (target) or outbound (caller); `all`
    // (default) keeps both. `targetAgentId` further pins outbound to one peer.
    async listForOwner(
        userId: string,
        agentId: string,
        opts: {
            limit: number
            beforeCreatedAt?: Date
            beforeId?: string
            state?: A2aTaskState
            direction?: 'inbound' | 'outbound' | 'all'
            targetAgentId?: string
        }
    ): Promise<A2aTask[]> {
        const directionCond =
            opts.direction === 'inbound'
                ? eq(a2aTasks.targetAgentId, agentId)
                : opts.direction === 'outbound'
                  ? eq(a2aTasks.callerAgentId, agentId)
                  : or(
                        eq(a2aTasks.targetAgentId, agentId),
                        eq(a2aTasks.callerAgentId, agentId)
                    )
        const conds: (SQL | undefined)[] = [
            eq(a2aTasks.userId, userId),
            directionCond
        ]
        if (opts.targetAgentId)
            conds.push(eq(a2aTasks.targetAgentId, opts.targetAgentId))
        if (opts.state) conds.push(eq(a2aTasks.state, opts.state))
        if (opts.beforeCreatedAt && opts.beforeId)
            conds.push(
                or(
                    lt(a2aTasks.createdAt, opts.beforeCreatedAt),
                    and(
                        eq(a2aTasks.createdAt, opts.beforeCreatedAt),
                        lt(a2aTasks.id, opts.beforeId)
                    )
                )
            )
        return this.db
            .select()
            .from(a2aTasks)
            .where(and(...conds))
            .orderBy(desc(a2aTasks.createdAt), desc(a2aTasks.id))
            .limit(opts.limit)
    }

    async list(
        scope: A2aTaskScope,
        opts: ListA2aTasksOptions
    ): Promise<A2aTask[]> {
        const conds: (SQL | undefined)[] = [scopeCondition(scope)]
        if (opts.state) conds.push(eq(a2aTasks.state, opts.state))
        if (opts.contextId) conds.push(eq(a2aTasks.contextId, opts.contextId))
        if (opts.beforeCreatedAt && opts.beforeId)
            conds.push(
                or(
                    lt(a2aTasks.createdAt, opts.beforeCreatedAt),
                    and(
                        eq(a2aTasks.createdAt, opts.beforeCreatedAt),
                        lt(a2aTasks.id, opts.beforeId)
                    )
                )
            )
        return this.db
            .select()
            .from(a2aTasks)
            .where(and(...conds))
            .orderBy(desc(a2aTasks.createdAt), desc(a2aTasks.id))
            .limit(opts.limit)
    }
}
