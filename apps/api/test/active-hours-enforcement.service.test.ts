import assert from 'node:assert/strict'
import test from 'node:test'
import { Param } from 'drizzle-orm'
import { runtimeHosts, users } from '@manyfold/db'
import type { SandboxStopResponse } from '@manyfold/shared'
import { ActiveHoursEnforcementService } from '../src/modules/sandboxes/active-hours-enforcement.service'

interface LimitRow {
    id: string
    activeHoursBonus: number
    planName: string
    monthlyActiveHoursIncluded: number | null
}

// The sweep reads runtime_hosts twice — running sandboxes, then kept-awake
// ones — telling them apart by the predicate it binds ('running' vs the
// keep_awake flag), the way the real query does.
const paramsOf = (query: unknown): unknown[] => {
    const params: unknown[] = []
    const visit = (chunk: unknown): void => {
        if (chunk instanceof Param) params.push(chunk.value)
        else
            for (const nested of (chunk as { queryChunks?: unknown[] })
                ?.queryChunks ?? [])
                visit(nested)
    }
    visit(query)
    return params
}

class FakeSweepDb {
    running: Array<{ id: string; userId: string }> = []
    keepAwake: Array<{ id: string; userId: string }> = []
    limits: LimitRow[] = []
    flips: string[] = []

    select(): FakeSweepQuery {
        return new FakeSweepQuery(this)
    }

    update(): { set: (v: unknown) => { where: (c: unknown) => Promise<void> } } {
        return {
            set: () => ({
                where: async (condition: unknown) => {
                    const [id] = paramsOf(condition) as string[]
                    this.flips.push(id)
                }
            })
        }
    }
}

class FakeSweepQuery implements PromiseLike<unknown[]> {
    private table: unknown
    private condition: unknown

    constructor(private readonly db: FakeSweepDb) {}

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

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): PromiseLike<TResult1 | TResult2> {
        let rows: unknown[] = []
        if (this.table === runtimeHosts)
            rows = paramsOf(this.condition).includes('running')
                ? this.db.running
                : this.db.keepAwake
        else if (this.table === users) rows = this.db.limits
        return Promise.resolve(rows).then(onfulfilled, onrejected)
    }
}

const makeHarness = (opts: {
    db: FakeSweepDb
    secondsByUser?: Record<string, number>
    toggleOn?: boolean
    leaseGranted?: boolean
    stopError?: (hostId: string) => boolean
    // Whatever stop() reports back for a host. The default is a stop that
    // actually removed something; a real SandboxStopResponse shape matters
    // here because the sweep reads `status` and `warnings` off it.
    stopResult?: (hostId: string) => Partial<SandboxStopResponse>
}) => {
    const stops: Array<{ userId: string; hostId: string }> = []
    const forced: boolean[] = []
    const events: Array<{ userId: string; code: string; usage: number }> = []
    const telemetry: Array<{ name: string; attrs: Record<string, unknown> }> =
        []
    const logs: Array<{ level: 'log' | 'warn'; message: string }> = []
    const service = new ActiveHoursEnforcementService(
        opts.db as never,
        {
            stop: async (
                userId: string,
                hostId: string,
                _isAdmin?: boolean,
                stopOpts?: { force?: boolean }
            ): Promise<SandboxStopResponse> => {
                if (opts.stopError?.(hostId)) throw new Error('stop failed')
                stops.push({ userId, hostId })
                forced.push(stopOpts?.force === true)
                return {
                    status: 'pending',
                    stoppedAgents: 1,
                    stoppedServices: [],
                    deletedTasks: [],
                    estimatedReadyInSec: 35,
                    warnings: [],
                    ...opts.stopResult?.(hostId)
                }
            }
        } as never,
        {
            activeSecondsInPeriodByUser: async (ids: string[]) =>
                new Map(
                    ids.map((id) => [id, opts.secondsByUser?.[id] ?? 0])
                )
        } as never,
        {
            emitQuotaWarning: (
                userId: string,
                event: { code: string; usage: number }
            ) => {
                events.push({ userId, code: event.code, usage: event.usage })
            }
        } as never,
        {
            isFeatureEnabled: async () => opts.toggleOn ?? true
        } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) => {
                telemetry.push({ name, attrs })
            },
            error: () => {}
        } as never,
        opts.leaseGranted === undefined
            ? undefined
            : ({
                  tryAcquireOrRenew: async () => opts.leaseGranted,
                  release: async () => {}
              } as never)
    )
    service['log' as never] = {
        log: (message: string) => logs.push({ level: 'log', message }),
        warn: (message: string) => logs.push({ level: 'warn', message })
    } as never
    return {
        service,
        stops,
        forced,
        events,
        telemetry,
        logs,
        flips: opts.db.flips
    }
}

const overQuota = (id = 'u-over'): LimitRow => ({
    id,
    activeHoursBonus: 0,
    planName: 'Free',
    monthlyActiveHoursIncluded: 5
})

test('sweep force-sleeps running hosts of over-quota users and emits the hard event', async () => {
    const db = new FakeSweepDb()
    db.running.push({ id: 'host-1', userId: 'u-over' })
    db.keepAwake.push({ id: 'host-1', userId: 'u-over' })
    db.limits.push(overQuota())
    const h = makeHarness({ db, secondsByUser: { 'u-over': 6 * 3600 } })

    await h.service.tick()

    assert.deepEqual(h.stops, [{ userId: 'u-over', hostId: 'host-1' }])
    // Forced: a task named like the platform's own hold cannot keep an
    // over-quota sandbox up.
    assert.deepEqual(h.forced, [true])
    // stop() already flipped the switch on the host it stopped.
    assert.deepEqual(h.flips, [])
    assert.deepEqual(h.events, [
        { userId: 'u-over', code: 'active_hours', usage: 6 }
    ])
    assert.equal(h.telemetry[0]?.name, 'active_hours.force_sleep')
    assert.equal(h.telemetry[0]?.attrs.stoppedHosts, 1)
})

test('sweep only flips keep-awake for sleeping hosts — never stops a non-running host', async () => {
    const db = new FakeSweepDb()
    db.keepAwake.push({ id: 'h-cold', userId: 'u-over' })
    db.limits.push(overQuota())
    const h = makeHarness({ db, secondsByUser: { 'u-over': 10 * 3600 } })

    await h.service.tick()

    // WHY: a sleeping sprite holds no lease task, so the flag flip alone
    // stops the lease sweep from re-waking it; a stop (or a release) would
    // exec into and wake the VM, the one thing this must not do.
    assert.deepEqual(h.stops, [])
    assert.deepEqual(h.flips, ['h-cold'])
})

test('sweep leaves under-quota, unlimited-plan and bonus-covered users untouched', async () => {
    const db = new FakeSweepDb()
    db.running.push(
        { id: 'h-under', userId: 'u-under' },
        { id: 'h-unlimited', userId: 'u-unlimited' },
        { id: 'h-bonus', userId: 'u-bonus' }
    )
    db.limits.push(
        overQuota('u-under'),
        { ...overQuota('u-unlimited'), monthlyActiveHoursIncluded: null },
        { ...overQuota('u-bonus'), activeHoursBonus: 10 }
    )
    const h = makeHarness({
        db,
        secondsByUser: {
            'u-under': 4 * 3600,
            'u-unlimited': 1000 * 3600,
            'u-bonus': 12 * 3600
        }
    })

    await h.service.tick()

    assert.deepEqual(h.stops, [])
    assert.deepEqual(h.flips, [])
    assert.deepEqual(h.events, [])
})

test('sweep does nothing when the toggle is off or the lease is denied', async () => {
    for (const opts of [{ toggleOn: false }, { leaseGranted: false }]) {
        const db = new FakeSweepDb()
        db.running.push({ id: 'host-1', userId: 'u-over' })
        db.limits.push(overQuota())
        const h = makeHarness({
            db,
            secondsByUser: { 'u-over': 6 * 3600 },
            ...opts
        })

        await h.service.tick()

        assert.deepEqual(h.stops, [], JSON.stringify(opts))
        assert.deepEqual(h.events, [], JSON.stringify(opts))
    }
})

test('sweep cools down per user and re-checks limits live on later ticks', async () => {
    const db = new FakeSweepDb()
    db.running.push({ id: 'host-1', userId: 'u-over' })
    db.limits.push(overQuota())
    const h = makeHarness({ db, secondsByUser: { 'u-over': 6 * 3600 } })

    await h.service.tick()
    await h.service.tick()

    assert.equal(h.stops.length, 1, 'second tick inside the cooldown is a no-op')

    // An upgrade un-flags the user on the next eligible pass with no plumbing.
    db.limits[0].monthlyActiveHoursIncluded = 100
    ;(h.service as never as { nextEligibleAt: Map<string, number> }).nextEligibleAt.clear()
    await h.service.tick()
    assert.equal(h.stops.length, 1)
})

test('sweep bounds enforcement to five users per tick', async () => {
    const db = new FakeSweepDb()
    const seconds: Record<string, number> = {}
    for (let i = 0; i < 7; i += 1) {
        db.running.push({ id: `h-${i}`, userId: `u-${i}` })
        db.limits.push(overQuota(`u-${i}`))
        seconds[`u-${i}`] = 6 * 3600
    }
    const h = makeHarness({ db, secondsByUser: seconds })

    await h.service.tick()

    assert.equal(h.stops.length, 5)
})

test('sweep keeps going when one host stop fails', async () => {
    const db = new FakeSweepDb()
    db.running.push(
        { id: 'h-bad', userId: 'u-over' },
        { id: 'h-good', userId: 'u-over' }
    )
    db.limits.push(overQuota())
    const h = makeHarness({
        db,
        secondsByUser: { 'u-over': 6 * 3600 },
        stopError: (hostId) => hostId === 'h-bad'
    })

    await h.service.tick()

    assert.deepEqual(h.stops, [{ userId: 'u-over', hostId: 'h-good' }])
    assert.equal(h.telemetry[0]?.attrs.stoppedHosts, 1)
    assert.equal(h.telemetry[0]?.attrs.unresolvedHosts, 1)
    assert.ok(h.logs.some((l) => l.level === 'warn' && /unresolved=h-bad/.test(l.message)))
})

// WHY: a stop that returned having removed nothing is the dangerous one —
// the retry loop reads it as success. Seen on prod [2026-09-03]: a free
// sandbox pinned by leaked exec sessions absorbed 60 no-op stops in a day.
test('a stop that could not do anything is reported unresolved, not stopped', async () => {
    const db = new FakeSweepDb()
    db.running.push({ id: 'h-stuck', userId: 'u-over' })
    db.limits.push(overQuota())
    const h = makeHarness({
        db,
        secondsByUser: { 'u-over': 6 * 3600 },
        stopResult: () => ({ warnings: ['nothing on this sandbox could be stopped'] })
    })

    await h.service.tick()

    assert.equal(h.telemetry[0]?.attrs.stoppedHosts, 0)
    assert.equal(h.telemetry[0]?.attrs.unresolvedHosts, 1)
    assert.ok(h.logs.some((l) => l.level === 'warn' && /unresolved=h-stuck/.test(l.message)))
})

test('a noop stop counts as unresolved', async () => {
    const db = new FakeSweepDb()
    db.running.push({ id: 'h-noop', userId: 'u-over' })
    db.limits.push(overQuota())
    const h = makeHarness({
        db,
        secondsByUser: { 'u-over': 6 * 3600 },
        stopResult: () => ({ status: 'noop', stoppedAgents: 0 })
    })

    await h.service.tick()

    assert.equal(h.telemetry[0]?.attrs.unresolvedHosts, 1)
})

test('a stop that removed something is reported stopped and does not warn', async () => {
    const db = new FakeSweepDb()
    db.running.push({ id: 'h-ok', userId: 'u-over' })
    db.limits.push(overQuota())
    const h = makeHarness({ db, secondsByUser: { 'u-over': 6 * 3600 } })

    await h.service.tick()

    assert.equal(h.telemetry[0]?.attrs.stoppedHosts, 1)
    assert.equal(h.telemetry[0]?.attrs.unresolvedHosts, 0)
    assert.ok(h.logs.every((l) => l.level === 'log'))
})
