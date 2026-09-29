import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeHostRow } from '@manyfold/db'
import { isPlatformTaskName } from '@manyfold/shared'
import {
    HostAwakeService,
    NOOP_HOLD
} from '../src/modules/hosts/host-awake.service'

// ADR-0038: one reference-counted awake lease per machine. The first holder
// acquires it, later holders share it, the last release lets the machine
// sleep after a grace, and a detach never deletes it.

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'sbx_agp2vxbm6vywzm6pt2xmxa6qi4',
        userId: 'user-1',
        kind: 'hosted',
        providerId: 'rtp_1',
        providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sprite-1' },
        name: 'sandbox-001',
        status: 'ready',
        generation: 1,
        ...overrides
    }) as RuntimeHostRow

const provider = { id: 'rtp_1', kind: 'sprites', name: 'org' }

const build = (opts: { holdAwake?: boolean; graceMs?: number; fail?: boolean } = {}) => {
    const calls: Array<{ op: 'hold' | 'release'; name: string; ttl?: string }> = []
    const adapter =
        opts.holdAwake === false
            ? {}
            : {
                  holdAwake: async (_args: unknown, lease: { name: string; ttl: string }) => {
                      if (opts.fail) throw new Error('sprite exec refused')
                      calls.push({ op: 'hold', name: lease.name, ttl: lease.ttl })
                  },
                  releaseAwake: async (_args: unknown, lease: { name: string }) => {
                      calls.push({ op: 'release', name: lease.name })
                  }
              }
    class TestAwake extends HostAwakeService {
        protected override releaseGraceMs(): number {
            return opts.graceMs ?? 0
        }
    }
    const service = new TestAwake(
        { has: () => true, for: () => adapter } as never,
        { providerForHost: async () => provider } as never
    )
    return { service, calls }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15))

test('the first hold acquires the lease, the last release deletes it after the grace', async () => {
    const { service, calls } = build()
    const h = host()
    const first = service.hold(h, 'turn-1')
    const second = service.hold(h, 'turn-2')
    assert.equal(await first.settled, true)
    assert.equal(service.holders(h.id), 2)
    assert.equal(calls.length, 1, 'one provider call for two holders')
    assert.equal(calls[0].op, 'hold')
    assert.equal(calls[0].ttl, '30m')
    assert.match(calls[0].name, /^mf-hold-[0-9a-f]{8}$/)
    // The sandbox's Tasks surface must neither list it as the agent's nor
    // delete it on a user's stop.
    assert.ok(isPlatformTaskName(calls[0].name))

    await first.release()
    assert.equal(service.holders(h.id), 1)
    await settle()
    assert.equal(calls.length, 1, 'the lease outlives the first release')

    await second.release()
    await settle()
    assert.deepEqual(calls.map((c) => c.op), ['hold', 'release'])
    assert.equal(service.holders(h.id), 0)
})

test('a hold taken inside the grace keeps the lease instead of recreating it', async () => {
    const { service, calls } = build({ graceMs: 30 })
    const h = host()
    const first = service.hold(h, 'admission')
    await first.settled
    await first.release()
    const next = service.hold(h, 'turn')
    await settle()
    await settle()
    assert.deepEqual(calls.map((c) => c.op), ['hold'], 'no release, no second acquire')
    assert.equal(service.holders(h.id), 1)
    await next.release()
    await settle()
    await settle()
    assert.deepEqual(calls.map((c) => c.op), ['hold', 'release'])
})

test('a detach drops the reference but never deletes the lease', async () => {
    const { service, calls } = build()
    const h = host()
    const hold = service.hold(h, 'turn')
    await hold.settled
    hold.detach()
    await settle()
    assert.deepEqual(calls.map((c) => c.op), ['hold'])
    assert.equal(service.holders(h.id), 0)
    // A later hold starts a fresh lease of the same name: create-or-renew.
    const again = service.hold(h, 'turn-2')
    await again.settled
    assert.equal(calls.filter((c) => c.op === 'hold').length, 2)
    assert.equal(calls[0].name, calls[1].name)
    await again.release()
})

test('release and detach are one-shot per hold', async () => {
    const { service } = build()
    const h = host()
    const a = service.hold(h, 'a')
    const b = service.hold(h, 'b')
    await a.release()
    await a.release()
    a.detach()
    assert.equal(service.holders(h.id), 1)
    await b.release()
    await settle()
    assert.equal(service.holders(h.id), 0)
})

test('a machine that never sleeps gets the no-op hold: no provider call', async () => {
    const { service, calls } = build({ holdAwake: false })
    const pod = service.hold(host({ id: 'pdh_1', providerRef: { kind: 'k8s', namespace: 'ns', ingressHost: null, podPhase: null } as never }), 'turn')
    const local = service.hold(host({ id: 'dh_1', kind: 'local', providerId: null, providerRef: null }), 'turn')
    assert.equal(pod, NOOP_HOLD)
    assert.equal(local, NOOP_HOLD)
    assert.equal(await pod.settled, true)
    await pod.release()
    local.detach()
    assert.deepEqual(calls, [])
})

test('a provider that refuses the lease settles false and the hold still releases cleanly', async () => {
    const { service, calls } = build({ fail: true })
    const h = host()
    const hold = service.hold(h, 'turn')
    assert.equal(await hold.settled, false)
    await hold.release()
    await settle()
    assert.deepEqual(calls.map((c) => c.op), ['release'])
})

// Nothing renews a lease once its instance is gone, and one left behind keeps
// its machine awake for the rest of its TTL, so an instance shutting down lets
// go of every machine it holds: held, or waiting out its grace.
test('an instance shutting down lets go of every machine it holds', async () => {
    const { service, calls } = build({ graceMs: 60_000 })
    const held = host({ id: 'sbx_held' })
    const graced = host({ id: 'sbx_graced' })
    service.hold(held, 'terminal')
    const other = service.hold(graced, 'turn')
    await settle()
    await other.release()
    assert.deepEqual(calls.filter((c) => c.op === 'release'), [], 'the grace is still running')
    await service.onModuleDestroy()
    assert.equal(calls.filter((c) => c.op === 'release').length, 2)
    assert.equal(service.holders(held.id), 0)
    assert.equal(service.holders(graced.id), 0)
})
