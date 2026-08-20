import assert from 'node:assert/strict'
import test from 'node:test'
import { Param, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { chatMessages, chatMessageSources, users } from '@manyfold/db'
import {
    ChatRetentionService,
    retentionCutoff
} from '../src/modules/chat-retention/chat-retention.service'

const paramsOf = (condition: unknown): unknown[] => {
    const params: unknown[] = []
    const visit = (chunk: unknown): void => {
        if (chunk instanceof Param) params.push(chunk.value)
        // inArray embeds its values as a raw Array chunk of Params
        else if (Array.isArray(chunk)) chunk.forEach(visit)
        else
            for (const nested of (chunk as { queryChunks?: unknown[] })
                ?.queryChunks ?? []) {
                visit(nested)
            }
    }
    visit(condition)
    return params
}

class FakeRetentionDb {
    candidates: Array<{ userId: string; retentionDays: number | null }> = []
    oldMessages: string[] = []
    oldSources: string[] = []
    deletedMessages: string[] = []
    clearedSources: string[] = []

    select(fields?: Record<string, unknown>): FakeRetentionQuery {
        return new FakeRetentionQuery(this, 'select', undefined, fields)
    }

    delete(table: unknown): FakeRetentionQuery {
        return new FakeRetentionQuery(this, 'delete', table)
    }

    update(table: unknown): FakeRetentionQuery {
        return new FakeRetentionQuery(this, 'update', table)
    }

    // Raw payload clearing is one statement now (select and update together,
    // so nothing can change between them), which a query-builder fake cannot
    // express. It is answered here by SQL shape: the plan-scoped one consumes
    // oldSources, the fleet-wide age-based one is a different concern and
    // reports nothing. The predicates themselves are pinned in the .pg suite.
    async execute(node: unknown): Promise<unknown[]> {
        const { sql, params } = new PgDialect().sqlToQuery(node as SQL)
        if (sql.includes('from "plans"')) return [{ days: 0 }]
        if (sql.includes('count(*)::int as value'))
            return [{ value: this.oldSources.length }]
        if (!sql.includes('from "chat_message_sources" s')) return []
        if (!sql.includes('owner.user_id'))
            return [
                { scanned: 0, cleared: 0, cursor_at: null, cursor_id: null }
            ]
        const slot = /limit \$(\d+)/.exec(sql)
        const limit = Number(params[Number(slot?.[1] ?? 0) - 1] ?? 0)
        const taken = this.oldSources.slice(0, limit)
        this.clearedSources.push(...taken)
        this.oldSources = this.oldSources.slice(taken.length)
        return [
            {
                scanned: taken.length,
                cleared: taken.length,
                cursor_at: null,
                cursor_id: taken[taken.length - 1] ?? null
            }
        ]
    }
}

class FakeRetentionQuery implements PromiseLike<unknown[]> {
    private table: unknown
    private limitN: number | null = null
    private condition: unknown

    constructor(
        private readonly db: FakeRetentionDb,
        private readonly kind: 'select' | 'delete' | 'update',
        table?: unknown,
        fields?: Record<string, unknown>
    ) {
        void fields
        this.table = table
    }

    from(table: unknown): this {
        this.table = table
        return this
    }

    innerJoin(): this {
        return this
    }

    where(condition?: unknown): this {
        this.condition = condition
        return this
    }

    limit(n: number): this {
        this.limitN = n
        return this
    }

    set(): this {
        return this
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve(this.resolve()).then(onfulfilled, onrejected)
    }

    private resolve(): unknown[] {
        if (this.kind === 'select') {
            if (this.table === users) return this.db.candidates
            if (this.table === chatMessages) {
                if (this.limitN === null)
                    // dry-run count(*) probe
                    return [{ value: this.db.oldMessages.length }]
                return this.db.oldMessages
                    .slice(0, this.limitN)
                    .map((id) => ({ id }))
            }
            if (this.table === chatMessageSources) {
                if (this.limitN === null)
                    return [{ value: this.db.oldSources.length }]
                return this.db.oldSources
                    .slice(0, this.limitN)
                    .map((id) => ({ id }))
            }
            return []
        }
        if (this.kind === 'delete' && this.table === chatMessages) {
            const ids = paramsOf(this.condition) as string[]
            this.db.deletedMessages.push(...ids)
            this.db.oldMessages = this.db.oldMessages.filter(
                (id) => !ids.includes(id)
            )
            return []
        }
        if (this.kind === 'update' && this.table === chatMessageSources) {
            const ids = paramsOf(this.condition) as string[]
            this.db.clearedSources.push(...ids)
            this.db.oldSources = this.db.oldSources.filter(
                (id) => !ids.includes(id)
            )
            return []
        }
        return []
    }
}

const makeService = (
    db: FakeRetentionDb,
    env: Record<string, string> = {},
    opts: { leaseGranted?: boolean } = {}
): ChatRetentionService =>
    new ChatRetentionService(
        db as never,
        { get: (key: string) => env[key] } as never,
        opts.leaseGranted === undefined
            ? undefined
            : ({
                  tryAcquireOrRenew: async () => opts.leaseGranted,
                  release: async () => {}
              } as never)
    )

test('retentionCutoff subtracts whole days', () => {
    const at = new Date('2026-07-08T12:00:00.000Z')
    assert.equal(
        retentionCutoff(at, 30).toISOString(),
        '2026-06-08T12:00:00.000Z'
    )
    assert.equal(
        retentionCutoff(at, 90).toISOString(),
        '2026-04-09T12:00:00.000Z'
    )
})

test('runOnce drains a backlog in batches and reports totals', async () => {
    const db = new FakeRetentionDb()
    db.candidates.push({ userId: 'u-free', retentionDays: 30 })
    db.oldMessages = Array.from({ length: 450 }, (_, i) => `m-${i}`)
    db.oldSources = Array.from({ length: 10 }, (_, i) => `s-${i}`)
    const service = makeService(db)

    const result = await service.runOnce()

    assert.equal(result.messagesDeleted, 450)
    assert.equal(result.sourcesCleared, 10)
    assert.equal(result.usersProcessed, 1)
    assert.equal(result.capped, false)
    assert.equal(db.oldMessages.length, 0)
    assert.equal(db.oldSources.length, 0)
})

test('runOnce stops at the per-run cap and flags the remaining backlog', async () => {
    const db = new FakeRetentionDb()
    db.candidates.push(
        { userId: 'u-1', retentionDays: 30 },
        { userId: 'u-2', retentionDays: 30 }
    )
    db.oldMessages = Array.from({ length: 500 }, (_, i) => `m-${i}`)
    const service = makeService(db, {
        CHAT_RETENTION_MAX_DELETES_PER_RUN: '300'
    })

    const result = await service.runOnce()

    assert.equal(result.messagesDeleted, 300)
    assert.equal(result.capped, true)
    assert.equal(db.oldMessages.length, 200, 'backlog left for the next run')
})

test('runOnce dry-run counts but deletes nothing', async () => {
    const db = new FakeRetentionDb()
    db.candidates.push({ userId: 'u-free', retentionDays: 30 })
    db.oldMessages = ['m-1', 'm-2']
    db.oldSources = ['s-1']
    const service = makeService(db, { CHAT_RETENTION_DRY_RUN: '1' })

    const result = await service.runOnce()

    assert.equal(result.messagesDeleted, 0)
    assert.equal(result.sourcesCleared, 0)
    assert.equal(result.usersProcessed, 1, 'dry-run still reports the user')
    assert.deepEqual(db.deletedMessages, [])
    assert.deepEqual(db.clearedSources, [])
})

test('runOnce is a no-op when the lease is denied', async () => {
    const db = new FakeRetentionDb()
    db.candidates.push({ userId: 'u-free', retentionDays: 30 })
    db.oldMessages = ['m-1']
    const service = makeService(db, {}, { leaseGranted: false })

    const result = await service.runOnce()

    assert.equal(result.messagesDeleted, 0)
    assert.deepEqual(db.deletedMessages, [])
})

test('onModuleInit respects the kill switch', () => {
    const db = new FakeRetentionDb()
    const service = makeService(db, { CHAT_RETENTION_ENABLED: 'false' })

    service.onModuleInit()

    assert.equal(
        (service as unknown as { timer: unknown }).timer,
        null,
        'no sweep timer scheduled when disabled'
    )
})
