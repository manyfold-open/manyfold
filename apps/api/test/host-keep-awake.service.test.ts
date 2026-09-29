import assert from 'node:assert/strict'
import test from 'node:test'
import { AWAKE_KEEP_TASK_NAME } from '@manyfold/shared'
import { HostKeepAwakeService } from '../src/modules/hosts/host-keep-awake.service'

// The keep-awake switch holds its machine the way the platform holds one for
// its own work (ADR-0038): one `mf-keep` task per host, placed and renewed by
// the API. Releasing is an exec, and an exec resumes a sleeping sprite, so a
// machine that is not running is never woken to let go.

const MIN = 60_000

type Row = Record<string, unknown> & { id: string }

const host = (over: Record<string, unknown> = {}): Row => ({
    id: 'sbx_1',
    userId: 'u1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'spr_1' },
    status: 'ready',
    powerState: 'running',
    keepAwake: true,
    keepAwakeLease: null,
    ...over
})

const leaseIn = (ms: number) => ({
    expiresAt: new Date(Date.now() + ms).toISOString(),
    verifiedAt: new Date().toISOString(),
    lastError: null
})

const build = (opts: {
    rows?: Row[]
    // Reads of a host after each provider call, for the race tests.
    reads?: Record<string, Row[]>
    holdFails?: boolean
    releaseFails?: boolean
    headroom?: { orgActive: number; activeCap: number }
    supportsHold?: boolean
}) => {
    const rows = opts.rows ?? [host()]
    const byId = new Map(rows.map((r) => [r.id, r]))
    const reads = new Map(Object.entries(opts.reads ?? {}))
    const calls: string[] = []
    const patches: Array<{ id: string; lease: unknown }> = []
    const events: string[] = []
    let headroomAsks = 0
    const adapter = {
        ...(opts.supportsHold === false
            ? {}
            : {
                  holdAwake: async (
                      args: { host: Row },
                      lease: { name: string; ttl: string }
                  ) => {
                      calls.push(`hold:${args.host.id}:${lease.name}:${lease.ttl}`)
                      if (opts.holdFails) throw new Error('not listed after its renew')
                  },
                  releaseAwake: async (args: { host: Row }, lease: { name: string }) => {
                      calls.push(`release:${args.host.id}:${lease.name}`)
                      if (opts.releaseFails) throw new Error('still listed after its delete')
                  }
              })
    }
    const svc = new HostKeepAwakeService(
        {
            select: () => ({
                from: () => ({ where: async () => rows })
            })
        } as never,
        {
            findById: async (id: string) => {
                const queued = reads.get(id)
                if (queued && queued.length) return queued.shift()
                return byId.get(id) ?? null
            },
            patch: async (id: string, values: { keepAwakeLease: unknown }) => {
                patches.push({ id, lease: values.keepAwakeLease })
                const row = byId.get(id)
                if (row) row.keepAwakeLease = values.keepAwakeLease
                return row
            }
        } as never,
        { has: () => true, for: () => adapter } as never,
        { providerForHost: async () => ({ id: 'rtp_1', kind: 'sprites' }) } as never,
        { event: (name: string) => events.push(name) } as never
    )
    const headroom = async () => {
        headroomAsks += 1
        return opts.headroom ?? { orgActive: 0, activeCap: 10 }
    }
    return { svc, calls, patches, events, headroom, asks: () => headroomAsks }
}

test('switching on holds mf-keep for the TTL and records when it expires', async () => {
    const h = build({})
    const before = Date.now()
    const outcome = await h.svc.converge(host() as never)
    assert.deepEqual(outcome, { state: 'held' })
    assert.deepEqual(h.calls, [`hold:sbx_1:${AWAKE_KEEP_TASK_NAME}:30m`])
    const lease = h.patches.at(-1)?.lease as { expiresAt: string; lastError: null }
    const ahead = Date.parse(lease.expiresAt) - before
    assert.ok(ahead >= 30 * MIN - 1000 && ahead <= 30 * MIN + 1000)
    assert.equal(lease.lastError, null)
})

test('switching off lets a running machine go and forgets the hold', async () => {
    const h = build({ rows: [host({ keepAwake: false, keepAwakeLease: leaseIn(20 * MIN) })] })
    const outcome = await h.svc.converge(host({ keepAwake: false }) as never)
    assert.deepEqual(outcome, { state: 'released' })
    assert.deepEqual(h.calls, [`release:sbx_1:${AWAKE_KEEP_TASK_NAME}`])
    assert.equal(h.patches.at(-1)?.lease, null)
})

// WHY: turning keep-awake off exists to let the sandbox sleep. Releasing on a
// sleeping sprite would wake it to do that, and bill the wake.
test('switching off never touches a machine that is not running', async () => {
    for (const powerState of ['suspended', 'stopped']) {
        const h = build({ rows: [host({ keepAwake: false, powerState })] })
        assert.deepEqual(await h.svc.converge(host() as never), { state: 'unchanged' })
        assert.deepEqual(h.calls, [])
    }
})

test('a machine that is not ready is not held yet', async () => {
    const h = build({ rows: [host({ status: 'provisioning' })] })
    assert.deepEqual(await h.svc.converge(host() as never), { state: 'unchanged' })
    assert.deepEqual(h.calls, [])
})

test('a machine whose provider holds nothing is left alone', async () => {
    const h = build({ supportsHold: false })
    assert.deepEqual(await h.svc.converge(host() as never), { state: 'unchanged' })
    assert.deepEqual(h.calls, [])
})

test('a hold that failed keeps what was known and says why', async () => {
    const known = leaseIn(10 * MIN)
    const h = build({ rows: [host({ keepAwakeLease: known })], holdFails: true })
    const outcome = await h.svc.converge(host() as never)
    assert.equal(outcome.state, 'failed')
    const lease = h.patches.at(-1)?.lease as { expiresAt: string; lastError: string }
    assert.equal(lease.expiresAt, known.expiresAt)
    assert.match(lease.lastError, /not listed after its renew/)
    assert.deepEqual(h.events, ['keep_awake.hold_failed'])
})

// WHY: the flag is re-read after every provider call, so a toggle that raced
// this one wins instead of leaving a machine held against its switch.
test('a switch-off that raced the hold releases what was just held', async () => {
    const h = build({
        reads: { sbx_1: [host(), host({ keepAwake: false })] }
    })
    const outcome = await h.svc.converge(host() as never)
    assert.deepEqual(outcome, { state: 'released' })
    assert.deepEqual(h.calls, [
        `hold:sbx_1:${AWAKE_KEEP_TASK_NAME}:30m`,
        `release:sbx_1:${AWAKE_KEEP_TASK_NAME}`
    ])
})

test('a switch-on that raced the release holds again', async () => {
    const h = build({
        reads: { sbx_1: [host({ keepAwake: false }), host()] }
    })
    const outcome = await h.svc.converge(host({ keepAwake: false }) as never)
    assert.deepEqual(outcome, { state: 'held' })
    assert.deepEqual(h.calls, [
        `release:sbx_1:${AWAKE_KEEP_TASK_NAME}`,
        `hold:sbx_1:${AWAKE_KEEP_TASK_NAME}:30m`
    ])
})

test('the reconcile leaves a hold with time to spare and renews one running low', async () => {
    const h = build({
        rows: [
            host({ id: 'sbx_fresh', keepAwakeLease: leaseIn(25 * MIN) }),
            host({ id: 'sbx_low', keepAwakeLease: leaseIn(15 * MIN) }),
            host({ id: 'sbx_none' })
        ]
    })
    await h.svc.reconcile({ headroom: h.headroom })
    assert.deepEqual(h.calls, [
        `hold:sbx_low:${AWAKE_KEEP_TASK_NAME}:30m`,
        `hold:sbx_none:${AWAKE_KEEP_TASK_NAME}:30m`
    ])
    assert.equal(h.asks(), 0, 'no wake, no capacity question')
})

test('the reconcile wakes a kept-awake machine that slept anyway, inside the org cap', async () => {
    const h = build({
        rows: [
            host({ id: 'sbx_a', powerState: 'suspended' }),
            host({ id: 'sbx_b', powerState: 'suspended' })
        ],
        headroom: { orgActive: 9, activeCap: 10 }
    })
    await h.svc.reconcile({ headroom: h.headroom })
    assert.deepEqual(h.calls, [`hold:sbx_a:${AWAKE_KEEP_TASK_NAME}:30m`])
    assert.equal(h.asks(), 1)
})

test('at the org cap the reconcile wakes nothing and says so', async () => {
    const h = build({
        rows: [host({ powerState: 'suspended' })],
        headroom: { orgActive: 10, activeCap: 10 }
    })
    await h.svc.reconcile({ headroom: h.headroom })
    assert.deepEqual(h.calls, [])
    assert.deepEqual(h.events, ['keep_awake.wake_capacity_skip'])
})

test('the reconcile lets go of a running machine switched off, and waits out a sleeping one', async () => {
    const h = build({
        rows: [
            host({ id: 'sbx_up', keepAwake: false, keepAwakeLease: leaseIn(20 * MIN) }),
            host({
                id: 'sbx_down',
                keepAwake: false,
                powerState: 'suspended',
                keepAwakeLease: leaseIn(20 * MIN)
            })
        ]
    })
    await h.svc.reconcile({ headroom: h.headroom })
    assert.deepEqual(h.calls, [`release:sbx_up:${AWAKE_KEEP_TASK_NAME}`])
})

test('a hold that expired on its own is forgotten without an exec', async () => {
    const h = build({
        rows: [
            host({
                keepAwake: false,
                powerState: 'suspended',
                keepAwakeLease: leaseIn(-MIN)
            })
        ]
    })
    await h.svc.reconcile({ headroom: h.headroom })
    assert.deepEqual(h.calls, [])
    assert.deepEqual(h.patches, [{ id: 'sbx_1', lease: null }])
})

test('one tick acts on at most five machines', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => host({ id: `sbx_${i}` }))
    const h = build({ rows })
    await h.svc.reconcile({ headroom: h.headroom })
    assert.equal(h.calls.length, 5)
})

test('a failed hold backs off: the next tick does not try it again', async () => {
    const h = build({ holdFails: true })
    await h.svc.reconcile({ headroom: h.headroom })
    await h.svc.reconcile({ headroom: h.headroom })
    assert.equal(h.calls.length, 1)
})
