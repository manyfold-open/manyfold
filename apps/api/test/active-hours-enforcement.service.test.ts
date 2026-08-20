import assert from 'node:assert/strict'
import test from 'node:test'
import { agentRuntimes, runtimeHosts, users } from '@manyfold/db'
import { ActiveHoursEnforcementService } from '../src/modules/sandboxes/active-hours-enforcement.service'

interface LimitRow {
    id: string
    activeHoursBonus: number
    planName: string
    monthlyActiveHoursIncluded: number | null
}

class FakeSweepDb {
    hosts: Array<{ id: string; userId: string }> = []
    keepAlive: Array<{ id: string; userId: string; hostId: string | null }> = []
    limits: LimitRow[] = []

    select(): FakeSweepQuery {
        return new FakeSweepQuery(this)
    }
}

class FakeSweepQuery implements PromiseLike<unknown[]> {
    private table: unknown

    constructor(private readonly db: FakeSweepDb) {}

    from(table: unknown): this {
        this.table = table
        return this
    }

    innerJoin(): this {
        return this
    }

    where(): this {
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
        if (this.table === runtimeHosts) rows = this.db.hosts
        else if (this.table === agentRuntimes) rows = this.db.keepAlive
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
}) => {
    const stops: Array<{ userId: string; hostId: string }> = []
    const closed: string[] = []
    const flips: Array<{ id: string; enabled: boolean }> = []
    const events: Array<{ userId: string; code: string; usage: number }> = []
    const telemetry: Array<{ name: string; attrs: Record<string, unknown> }> =
        []
    const service = new ActiveHoursEnforcementService(
        opts.db as never,
        {
            stop: async (userId: string, hostId: string) => {
                if (opts.stopError?.(hostId)) throw new Error('stop failed')
                stops.push({ userId, hostId })
                return { status: 'pending' }
            }
        } as never,
        {
            activeSecondsInPeriodByUser: async (ids: string[]) =>
                new Map(
                    ids.map((id) => [id, opts.secondsByUser?.[id] ?? 0])
                )
        } as never,
        {
            setKeepAliveEnabled: async (id: string, enabled: boolean) => {
                flips.push({ id, enabled })
            }
        } as never,
        {
            closeForAgent: (id: string) => {
                closed.push(id)
                return 0
            }
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
    return { service, stops, closed, flips, events, telemetry }
}

test('sweep force-sleeps running hosts of over-quota users and emits the hard event', async () => {
    const db = new FakeSweepDb()
    db.hosts.push({ id: 'host-1', userId: 'u-over' })
    db.keepAlive.push({ id: 'rt-1', userId: 'u-over', hostId: 'host-1' })
    db.limits.push({
        id: 'u-over',
        activeHoursBonus: 0,
        planName: 'Free',
        monthlyActiveHoursIncluded: 5
    })
    const h = makeHarness({ db, secondsByUser: { 'u-over': 5 * 3600 } })

    await h.service.tick()

    assert.deepEqual(h.stops, [{ userId: 'u-over', hostId: 'host-1' }])
    assert.deepEqual(h.closed, ['host-1'])
    assert.deepEqual(
        h.flips,
        [],
        'runtimes on a stopped host are handled by stop(), not flipped again'
    )
    assert.deepEqual(h.events, [
        { userId: 'u-over', code: 'active_hours', usage: 5 }
    ])
    assert.equal(h.telemetry[0]?.name, 'active_hours.force_sleep')
})

test('sweep only flips keep-alive for sleeping runtimes — never stops a non-running host', async () => {
    const db = new FakeSweepDb()
    // no running hosts; a keep-alive flag alone would re-wake the VM via the
    // reconcile ensure pass, so the sweep must clear it without exec'ing.
    db.keepAlive.push({ id: 'rt-sleeping', userId: 'u-over', hostId: 'h-cold' })
    db.limits.push({
        id: 'u-over',
        activeHoursBonus: 0,
        planName: 'Free',
        monthlyActiveHoursIncluded: 5
    })
    const h = makeHarness({ db, secondsByUser: { 'u-over': 6 * 3600 } })

    await h.service.tick()

    assert.deepEqual(h.stops, [])
    assert.deepEqual(h.flips, [{ id: 'rt-sleeping', enabled: false }])
    assert.equal(h.events.length, 1)
})

test('sweep leaves under-quota, unlimited-plan and bonus-covered users untouched', async () => {
    const db = new FakeSweepDb()
    db.hosts.push(
        { id: 'h-under', userId: 'u-under' },
        { id: 'h-unlimited', userId: 'u-unlimited' },
        { id: 'h-bonus', userId: 'u-bonus' }
    )
    db.limits.push(
        {
            id: 'u-under',
            activeHoursBonus: 0,
            planName: 'Free',
            monthlyActiveHoursIncluded: 5
        },
        {
            id: 'u-unlimited',
            activeHoursBonus: 0,
            planName: 'Pro',
            monthlyActiveHoursIncluded: null
        },
        {
            id: 'u-bonus',
            activeHoursBonus: 10,
            planName: 'Free',
            monthlyActiveHoursIncluded: 5
        }
    )
    const h = makeHarness({
        db,
        secondsByUser: {
            'u-under': 3600,
            'u-unlimited': 1000 * 3600,
            'u-bonus': 6 * 3600
        }
    })

    await h.service.tick()

    assert.deepEqual(h.stops, [])
    assert.deepEqual(h.flips, [])
    assert.deepEqual(h.events, [])
})

test('sweep does nothing when the toggle is off or the lease is denied', async () => {
    const db = new FakeSweepDb()
    db.hosts.push({ id: 'host-1', userId: 'u-over' })
    db.limits.push({
        id: 'u-over',
        activeHoursBonus: 0,
        planName: 'Free',
        monthlyActiveHoursIncluded: 1
    })
    const seconds = { 'u-over': 100 * 3600 }

    const toggleOff = makeHarness({
        db,
        secondsByUser: seconds,
        toggleOn: false
    })
    await toggleOff.service.tick()
    assert.deepEqual(toggleOff.stops, [])

    const noLease = makeHarness({
        db,
        secondsByUser: seconds,
        leaseGranted: false
    })
    await noLease.service.tick()
    assert.deepEqual(noLease.stops, [])
})

test('sweep cools down per user and re-checks limits live on later ticks', async () => {
    const db = new FakeSweepDb()
    db.hosts.push({ id: 'host-1', userId: 'u-over' })
    db.limits.push({
        id: 'u-over',
        activeHoursBonus: 0,
        planName: 'Free',
        monthlyActiveHoursIncluded: 5
    })
    const h = makeHarness({ db, secondsByUser: { 'u-over': 6 * 3600 } })

    await h.service.tick()
    await h.service.tick()

    assert.equal(
        h.stops.length,
        1,
        'second tick inside the cooldown window must not stop again'
    )

    // an upgrade (limits re-read each tick) un-flags the user regardless of
    // cooldown state
    db.limits[0] = { ...db.limits[0], monthlyActiveHoursIncluded: null }
    await h.service.tick()
    assert.equal(h.stops.length, 1)
})

test('sweep bounds enforcement to five users per tick', async () => {
    const db = new FakeSweepDb()
    const seconds: Record<string, number> = {}
    for (let i = 0; i < 6; i += 1) {
        const userId = `u-${i}`
        db.hosts.push({ id: `host-${i}`, userId })
        db.limits.push({
            id: userId,
            activeHoursBonus: 0,
            planName: 'Free',
            monthlyActiveHoursIncluded: 1
        })
        seconds[userId] = 10 * 3600
    }
    const h = makeHarness({ db, secondsByUser: seconds })

    await h.service.tick()

    assert.equal(h.stops.length, 5, 'per-tick cap bounds the blast radius')
})

test('sweep keeps going when one host stop fails', async () => {
    const db = new FakeSweepDb()
    db.hosts.push(
        { id: 'host-bad', userId: 'u-over' },
        { id: 'host-good', userId: 'u-over' }
    )
    db.limits.push({
        id: 'u-over',
        activeHoursBonus: 0,
        planName: 'Free',
        monthlyActiveHoursIncluded: 5
    })
    const h = makeHarness({
        db,
        secondsByUser: { 'u-over': 6 * 3600 },
        stopError: (hostId) => hostId === 'host-bad'
    })

    await h.service.tick()

    assert.deepEqual(h.stops, [{ userId: 'u-over', hostId: 'host-good' }])
    assert.equal(h.events.length, 1, 'hard event still emitted')
})
