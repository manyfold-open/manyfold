import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database } from '@manyfold/db'
import {
    SpriteExecHealthService,
    spriteExecHealthConfig
} from '../src/modules/agents/sprite-exec-health/sprite-exec-health.service'

// The durable semantics live in SQL and are proven in sprite-exec-health.pg.test.ts.
// What is proven here is the behaviour when the SQL is NOT available, which no
// real database can be made to produce on demand: a breaker that cannot read
// its own state must never become the reason a healthy turn is refused.

interface FakeDbOpts {
    row?: Record<string, unknown> | null
    rows?: Array<Record<string, unknown> | null>
    claim?: Array<{ id: string }>
    failRead?: boolean
    failWrite?: boolean
}

const fakeDb = (opts: FakeDbOpts) => {
    const reads: number[] = []
    const writes: string[] = []
    let readIndex = 0
    const nextRow = (): Record<string, unknown> | null => {
        if (opts.rows) {
            const row = opts.rows[Math.min(readIndex, opts.rows.length - 1)]
            readIndex++
            return row ?? null
        }
        return opts.row ?? null
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => {
                        reads.push(1)
                        if (opts.failRead) throw new Error('connection reset')
                        const row = nextRow()
                        return row ? [row] : []
                    }
                })
            })
        }),
        update: () => ({
            set: (values: Record<string, unknown>) => ({
                where: () => ({
                    returning: async () => {
                        writes.push(Object.keys(values).join(','))
                        if (opts.failWrite) throw new Error('deadlock detected')
                        return opts.claim ?? []
                    }
                })
            })
        })
    }
    return { db: db as unknown as Database, reads, writes }
}

const sandbox = (execCooldownUntil: Date | null): Record<string, unknown> => ({
    id: 'rh_1',
    kind: 'sandbox',
    spriteName: 'art-abc',
    execCooldownUntil
})

const withEnv = async (
    vars: Record<string, string | undefined>,
    body: () => Promise<void> | void
): Promise<void> => {
    const previous = Object.keys(vars).map(
        (key) => [key, process.env[key]] as const
    )
    for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        await body()
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test('a host with no cooldown passes without a write', async () => {
    const { db, writes } = fakeDb({ row: sandbox(null) })
    const service = new SpriteExecHealthService(db)

    const admission = await service.admit('rh_1')

    assert.equal(admission?.decision, 'pass')
    assert.equal(admission?.retryAt, null)
    // The healthy case is every turn: it must cost one read and nothing else.
    assert.deepEqual(writes, [])
})

test('a breaker that cannot read its own state fails open', async () => {
    const { db } = fakeDb({ failRead: true })
    const service = new SpriteExecHealthService(db)

    const admission = await service.admit('rh_1')

    // A refused turn is a user-visible failure; a missed refusal costs one
    // handshake, which is exactly the behaviour without this service at all.
    assert.equal(admission?.decision, 'pass')
})

test('bookkeeping writes never surface as turn failures', async () => {
    const { db } = fakeDb({ row: sandbox(null), failWrite: true })
    const service = new SpriteExecHealthService(db)

    // Both run after the turn's outcome is already decided. A throw here would
    // convert a classified failure into an unclassified one, and a successful
    // probe into a failed turn.
    assert.equal(
        await service.markUnavailable({
            hostId: 'rh_1',
            failureClass: 'handshake_5xx',
            upstreamStatus: 502
        }),
        null
    )
    assert.deepEqual(
        await service.recordProbe({
            hostId: 'rh_1',
            ok: true,
            lease: new Date(Date.now() + 20_000)
        }),
        { outcome: 'unavailable', retryAt: null }
    )
})

test('a turn with no sandbox host is not this breaker to decide', async () => {
    const { db, reads } = fakeDb({ row: sandbox(null) })
    const service = new SpriteExecHealthService(db)

    assert.equal(await service.admit(null), null)
    assert.equal(await service.admit(undefined), null)
    // A daemon or k8s turn must not even be looked up.
    assert.deepEqual(reads, [])
})

test('a cooling host is refused with the deadline it will lift at', async () => {
    const retryAt = new Date(Date.now() + 45_000)
    const { db } = fakeDb({ row: sandbox(retryAt), claim: [] })
    const service = new SpriteExecHealthService(db)

    const admission = await service.admit('rh_1')

    assert.equal(admission?.decision, 'blocked')
    assert.equal(admission?.retryAt?.getTime(), retryAt.getTime())
})

test('winning the claim is what makes a turn the prober', async () => {
    const { db } = fakeDb({
        row: sandbox(new Date(Date.now() - 1_000)),
        claim: [{ id: 'rh_1' }]
    })
    const service = new SpriteExecHealthService(db)

    const admission = await service.admit('rh_1')

    assert.equal(admission?.decision, 'probe')
    assert.equal(admission?.hostId, 'rh_1')
    // The lease it wrote is the token it must hand back: without it the report
    // cannot be told apart from one a lapsed prober sends minutes late.
    assert.ok((admission?.lease?.getTime() ?? 0) > Date.now())
})

test('a host being chosen is never the host being probed', async () => {
    const { db, writes } = fakeDb({
        row: sandbox(new Date(Date.now() - 1_000)),
        claim: [{ id: 'rh_1' }]
    })
    const service = new SpriteExecHealthService(db)

    // A lapsed window is permission for one TURN to go look. Placement is not
    // that look, so it reads the same state as unavailable and leaves the one
    // probe for the turn that follows.
    assert.equal(await service.isKnownUnavailable('rh_1'), true)
    assert.deepEqual(writes, [])
})

test('a placement check that cannot read fails open too', async () => {
    const { db } = fakeDb({ failRead: true })
    const service = new SpriteExecHealthService(db)

    // Same asymmetry as admission: an unreadable breaker must not be what takes
    // healthy capacity out of placement.
    assert.equal(await service.isKnownUnavailable('rh_1'), false)
})

test('a host recovered between the read and the claim passes', async () => {
    // The claim matched nothing because somebody else cleared the column, not
    // because they took the probe. Blocking on a stale snapshot would refuse a
    // turn against a host already proven healthy.
    const { db } = fakeDb({
        rows: [sandbox(new Date(Date.now() - 1_000)), sandbox(null)],
        claim: []
    })
    const service = new SpriteExecHealthService(db)

    assert.equal((await service.admit('rh_1'))?.decision, 'pass')
})

test('the cooldown and probe budget are operator knobs', async () => {
    await withEnv(
        {
            MF_SPRITE_EXEC_COOLDOWN_MS: '90000',
            MF_SPRITE_EXEC_PROBE_LEASE_MS: '15000',
            MF_SPRITE_EXEC_PROBE_TIMEOUT_MS: '5000',
            MF_SPRITE_EXEC_FIRST_EXEC_TIMEOUT_MS: '20000'
        },
        () => {
            const config = spriteExecHealthConfig()
            assert.equal(config.cooldownMs, 90_000)
            assert.equal(config.probeLeaseMs, 15_000)
            assert.equal(config.probeTimeoutMs, 5_000)
            assert.equal(config.firstExecTimeoutMs, 20_000)
        }
    )
    await withEnv(
        {
            MF_SPRITE_EXEC_COOLDOWN_MS: 'not-a-number',
            MF_SPRITE_EXEC_PROBE_LEASE_MS: '0',
            MF_SPRITE_EXEC_PROBE_TIMEOUT_MS: undefined,
            MF_SPRITE_EXEC_FIRST_EXEC_TIMEOUT_MS: '-1'
        },
        () => {
            const config = spriteExecHealthConfig()
            // Garbage falls back rather than disabling the window: a cooldown
            // of 0 or NaN is an always-open breaker nobody asked for.
            assert.ok(config.cooldownMs > 0)
            assert.ok(config.probeLeaseMs > 0)
            assert.ok(config.probeTimeoutMs > 0)
            assert.ok(config.firstExecTimeoutMs > 0)
        }
    )
})

test('the first exec is bounded well under the old inspect default', async () => {
    const config = spriteExecHealthConfig()
    // #730's whole user-visible cost was this bound: a 502ing endpoint spent the
    // 60s inspect default and then the same again on the direct fallback, so the
    // first turn to meet a dead endpoint waited ~78s for an unactionable error.
    // One bound, once, and the turns behind it pay nothing.
    assert.ok(config.firstExecTimeoutMs < 60_000)
    // But comfortably above the no-op probe budget: the first exec also wakes a
    // suspended VM and runs a login shell, so probe-tight here would quarantine
    // healthy-but-cold hosts.
    assert.ok(config.firstExecTimeoutMs > config.probeTimeoutMs)
})

test('the probe budget is smaller than the lease that covers it', async () => {
    const config = spriteExecHealthConfig()
    // Otherwise a prober still working is treated as dead and a second turn
    // takes the probe — two handshakes against an endpoint being measured.
    assert.ok(config.probeTimeoutMs < config.probeLeaseMs)
    // And the lease must be shorter than the cooldown, or a failed probe's
    // re-arm would be indistinguishable from a lease that simply lapsed.
    assert.ok(config.probeLeaseMs < config.cooldownMs)
})

test('misordered probe knobs are clamped to preserve single-prober safety', async () => {
    await withEnv(
        {
            MF_SPRITE_EXEC_COOLDOWN_MS: '1000',
            MF_SPRITE_EXEC_PROBE_LEASE_MS: '1000',
            MF_SPRITE_EXEC_PROBE_TIMEOUT_MS: '5000'
        },
        () => {
            const config = spriteExecHealthConfig()
            assert.ok(config.probeTimeoutMs < config.probeLeaseMs)
            assert.ok(config.probeLeaseMs < config.cooldownMs)
        }
    )
})
