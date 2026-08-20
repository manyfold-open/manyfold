import assert from 'node:assert/strict'
import test from 'node:test'
import { Param } from 'drizzle-orm'
import { automations } from '@manyfold/db'
import {
    AutomationRetentionService,
    automationRetentionCutoff
} from '../src/modules/automations/automation-retention.service'

const paramsOf = (condition: unknown): unknown[] => {
    const params: unknown[] = []
    const visit = (chunk: unknown): void => {
        if (chunk instanceof Param) params.push(chunk.value)
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

interface TombstoneRow {
    id: string
    deletedAt: Date
}

class FakePurgeDb {
    tombstones: TombstoneRow[] = []
    purged: string[] = []
    failDeletes = false

    select(fields?: Record<string, unknown>): FakePurgeQuery {
        return new FakePurgeQuery(this, 'select', undefined, fields)
    }

    delete(table: unknown): FakePurgeQuery {
        return new FakePurgeQuery(this, 'delete', table)
    }

    expiredBefore(cutoff: Date): TombstoneRow[] {
        return this.tombstones.filter((row) => row.deletedAt < cutoff)
    }
}

class FakePurgeQuery implements PromiseLike<unknown[]> {
    private table: unknown
    private limitN: number | null = null
    private condition: unknown

    constructor(
        private readonly db: FakePurgeDb,
        private readonly kind: 'select' | 'delete',
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

    where(condition?: unknown): this {
        this.condition = condition
        return this
    }

    orderBy(): this {
        return this
    }

    limit(n: number): this {
        this.limitN = n
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
        try {
            return Promise.resolve(this.resolve()).then(onfulfilled, onrejected)
        } catch (err) {
            return Promise.reject(err).then(onfulfilled, onrejected)
        }
    }

    private resolve(): unknown[] {
        if (this.kind === 'select' && this.table === automations) {
            const cutoff = paramsOf(this.condition).find(
                (value): value is Date => value instanceof Date
            )
            assert.ok(cutoff, 'purge queries must be bounded by a cutoff')
            const expired = this.db.expiredBefore(cutoff)
            if (this.limitN === null) return [{ value: expired.length }]
            return expired.slice(0, this.limitN).map((row) => ({ id: row.id }))
        }
        if (this.kind === 'delete' && this.table === automations) {
            if (this.db.failDeletes) throw new Error('deadlock detected')
            const ids = paramsOf(this.condition).filter(
                (value): value is string => typeof value === 'string'
            )
            this.db.purged.push(...ids)
            this.db.tombstones = this.db.tombstones.filter(
                (row) => !ids.includes(row.id)
            )
            return []
        }
        return []
    }
}

interface TelemetryCall {
    name: string
    attrs: Record<string, unknown>
}

const makeService = (
    db: FakePurgeDb,
    opts: {
        env?: Record<string, string>
        retentionDays?: number
        leaseGranted?: boolean
        telemetry?: TelemetryCall[]
    } = {}
): AutomationRetentionService =>
    new AutomationRetentionService(
        db as never,
        { get: (key: string) => opts.env?.[key] } as never,
        {
            getAutomationRetention: async () => ({
                retentionDays: opts.retentionDays ?? 90
            })
        } as never,
        opts.leaseGranted === undefined
            ? undefined
            : ({
                  tryAcquireOrRenew: async () => opts.leaseGranted,
                  release: async () => {}
              } as never),
        opts.telemetry === undefined
            ? undefined
            : ({
                  event: (name: string, attrs: Record<string, unknown>) => {
                      opts.telemetry?.push({ name, attrs })
                  },
                  error: (
                      name: string,
                      _err: Error,
                      attrs: Record<string, unknown>
                  ) => {
                      opts.telemetry?.push({ name, attrs })
                  }
              } as never)
    )

const daysAgo = (days: number): Date =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000)

test('automationRetentionCutoff subtracts whole days', () => {
    const at = new Date('2026-08-06T12:00:00.000Z')
    assert.equal(
        automationRetentionCutoff(at, 90).toISOString(),
        '2026-05-08T12:00:00.000Z'
    )
    assert.equal(
        automationRetentionCutoff(at, 1).toISOString(),
        '2026-08-05T12:00:00.000Z'
    )
})

test('runOnce purges only tombstones past the retention window', async () => {
    const db = new FakePurgeDb()
    db.tombstones.push(
        { id: 'auto-expired', deletedAt: daysAgo(100) },
        { id: 'auto-fresh', deletedAt: daysAgo(60) },
        { id: 'auto-today', deletedAt: daysAgo(0) }
    )
    const service = makeService(db, { retentionDays: 90 })

    const result = await service.runOnce()

    assert.equal(result.purged, 1)
    assert.equal(result.retentionDays, 90)
    assert.equal(result.capped, false)
    assert.deepEqual(db.purged, ['auto-expired'])
    assert.deepEqual(
        db.tombstones.map((row) => row.id),
        ['auto-fresh', 'auto-today']
    )
})

test('a shortened retention window applies to existing tombstones on the next sweep', async () => {
    const db = new FakePurgeDb()
    db.tombstones.push(
        { id: 'auto-100d', deletedAt: daysAgo(100) },
        { id: 'auto-60d', deletedAt: daysAgo(60) },
        { id: 'auto-10d', deletedAt: daysAgo(10) }
    )

    const first = await makeService(db, { retentionDays: 90 }).runOnce()
    assert.equal(first.purged, 1)
    assert.deepEqual(db.purged, ['auto-100d'])

    const second = await makeService(db, { retentionDays: 30 }).runOnce()
    assert.equal(second.purged, 1)
    assert.deepEqual(db.purged, ['auto-100d', 'auto-60d'])
    assert.deepEqual(
        db.tombstones.map((row) => row.id),
        ['auto-10d']
    )
})

test('runOnce drains in batches and stops at the per-run cap', async () => {
    const db = new FakePurgeDb()
    db.tombstones = Array.from({ length: 250 }, (_, i) => ({
        id: `auto-${i}`,
        deletedAt: daysAgo(100)
    }))
    const service = makeService(db, {
        retentionDays: 90,
        env: { AUTOMATION_RETENTION_MAX_DELETES_PER_RUN: '200' }
    })

    const result = await service.runOnce()

    assert.equal(result.purged, 200)
    assert.equal(result.capped, true)
    assert.equal(db.tombstones.length, 50, 'backlog left for the next run')
})

test('runOnce dry-run counts but deletes nothing', async () => {
    const db = new FakePurgeDb()
    db.tombstones.push({ id: 'auto-expired', deletedAt: daysAgo(100) })
    const service = makeService(db, {
        retentionDays: 90,
        env: { AUTOMATION_RETENTION_DRY_RUN: '1' }
    })

    const result = await service.runOnce()

    assert.equal(result.dryRun, true)
    assert.equal(result.scanned, 1)
    assert.equal(result.purged, 0)
    assert.deepEqual(db.purged, [])
    assert.equal(db.tombstones.length, 1)
})

test('runOnce is a no-op when the lease is denied', async () => {
    const db = new FakePurgeDb()
    db.tombstones.push({ id: 'auto-expired', deletedAt: daysAgo(100) })
    const service = makeService(db, {
        retentionDays: 90,
        leaseGranted: false
    })

    const result = await service.runOnce()

    assert.equal(result.purged, 0)
    assert.deepEqual(db.purged, [])
})

test('a failing delete batch is reported and retried next run, not fatal', async () => {
    const db = new FakePurgeDb()
    db.tombstones.push({ id: 'auto-expired', deletedAt: daysAgo(100) })
    db.failDeletes = true
    const telemetry: TelemetryCall[] = []
    const service = makeService(db, { retentionDays: 90, telemetry })

    const result = await service.runOnce()

    assert.equal(result.purged, 0)
    assert.equal(result.failed, 1)
    assert.equal(db.tombstones.length, 1)
    assert.ok(
        telemetry.some(
            (call) => call.name === 'automation.retention.batch_failed'
        )
    )

    db.failDeletes = false
    const retry = await makeService(db, { retentionDays: 90 }).runOnce()
    assert.equal(retry.purged, 1)
})

test('every sweep emits the structured telemetry event', async () => {
    const db = new FakePurgeDb()
    db.tombstones.push({ id: 'auto-expired', deletedAt: daysAgo(100) })
    const telemetry: TelemetryCall[] = []
    const service = makeService(db, { retentionDays: 90, telemetry })

    await service.runOnce()

    const sweep = telemetry.find(
        (call) => call.name === 'automation.retention.sweep'
    )
    assert.ok(sweep)
    assert.equal(sweep.attrs.purged, 1)
    assert.equal(sweep.attrs.scanned, 1)
    assert.equal(sweep.attrs.failed, 0)
    assert.equal(sweep.attrs.capped, false)
    assert.equal(sweep.attrs.retentionDays, 90)
    assert.equal(sweep.attrs.dryRun, false)
})

test('onModuleInit respects the kill switch', () => {
    const db = new FakePurgeDb()
    const service = makeService(db, {
        env: { AUTOMATION_RETENTION_ENABLED: 'false' }
    })

    service.onModuleInit()

    assert.equal(
        (service as unknown as { timer: unknown }).timer,
        null,
        'no timer when disabled'
    )
    service.onModuleDestroy()
})
