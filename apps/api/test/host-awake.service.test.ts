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

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const build = (
    opts: {
        holdAwake?: boolean
        graceMs?: number
        fail?: boolean
        // How long each provider call takes to land on the machine.
        landMs?: { hold?: number; release?: number }
    } = {}
) => {
    const calls: Array<{ op: 'hold' | 'release'; name: string; ttl?: string }> = []
    const adapter =
        opts.holdAwake === false
            ? {}
            : {
                  holdAwake: async (_args: unknown, lease: { name: string; ttl: string }) => {
                      if (opts.fail) throw new Error('sprite exec refused')
                      if (opts.landMs?.hold) await later(opts.landMs.hold)
                      calls.push({ op: 'hold', name: lease.name, ttl: lease.ttl })
                  },
                  releaseAwake: async (_args: unknown, lease: { name: string }) => {
                      if (opts.landMs?.release) await later(opts.landMs.release)
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

// Every lease of an instance has the same name, so a lease opened while the
// last one's DELETE is still on its way must not PUT until it has landed: a
// PUT that got there first would be deleted by it, and the new holder would
// believe the machine held until the next renew, 10 minutes later.
test('a hold taken while the lease is being let go acquires after the release lands', async () => {
    const { service, calls } = build({ landMs: { hold: 5, release: 30 } })
    const ops = () => calls.map((c) => c.op)
    const h = host()
    const first = service.hold(h, 'read')
    await first.settled
    await first.release()
    await later(2)
    const next = service.hold(h, 'turn')
    assert.equal(await next.settled, true)
    assert.deepEqual(ops(), ['hold', 'release', 'hold'])
    assert.equal(service.holders(h.id), 1)
    await next.release()
    await later(50)
    assert.deepEqual(ops(), ['hold', 'release', 'hold', 'release'])
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
    // A later hold takes a fresh name: releasing one under the detached
    // task's name would delete the task the handed-off work relies on.
    const again = service.hold(h, 'turn-2')
    await again.settled
    assert.equal(calls.filter((c) => c.op === 'hold').length, 2)
    assert.notEqual(calls[1].name, calls[0].name)
    assert.ok(isPlatformTaskName(calls[1].name))
    await again.release()
    await settle()
    assert.deepEqual(
        calls.filter((c) => c.op === 'release').map((c) => c.name),
        [calls[1].name],
        'only the later lease is deleted'
    )
})

test('a holder that detaches keeps the lease past the other holders', async () => {
    const { service, calls } = build()
    const h = host()
    const turn = service.hold(h, 'turn')
    const delivery = service.hold(h, 'config-delivery')
    await turn.settled
    turn.detach()
    await delivery.release()
    await settle()
    assert.deepEqual(calls.map((c) => c.op), ['hold'], 'no release after a detach')
    assert.equal(service.holders(h.id), 0)
})

test('shutdown keeps a detached lease and lets go of the rest', async () => {
    const { service, calls } = build({ graceMs: 60_000 })
    const handedOff = host({ id: 'sbx_handed_off' })
    const plain = host({ id: 'sbx_plain' })
    const turn = service.hold(handedOff, 'turn')
    const delivery = service.hold(handedOff, 'config-delivery')
    service.hold(plain, 'terminal')
    await settle()
    turn.detach()
    assert.equal(service.holders(handedOff.id), 1)
    await service.onModuleDestroy()
    const released = calls.filter((c) => c.op === 'release')
    assert.equal(released.length, 1, 'only the plain machine is let go')
    assert.equal(released[0].name, calls[0].name)
    await delivery.release()
    await settle()
    assert.equal(calls.filter((c) => c.op === 'release').length, 1)
})

// Seen on staging [2026-10-07]: a turn handed off at shutdown, the daemon
// reconnected to the same draining instance, and config delivery held and
// let go of the machine; that release deleted the turn's task, and the sprite
// went cold under the turn 35 s later.
test('a hold taken after a handoff does not delete the handed-off task', async () => {
    const { service, calls } = build()
    const h = host()
    const turn = service.hold(h, 'fa68e94e')
    await turn.settled
    turn.detach()
    const delivery = service.hold(h, 'config-delivery')
    await delivery.settled
    await delivery.release()
    await settle()
    await service.onModuleDestroy()
    const turnTask = calls[0].name
    assert.equal(
        calls.some((c) => c.op === 'release' && c.name === turnTask),
        false,
        'the handed-off turn keeps its task until the TTL'
    )
})

// Two API instances over one machine, the way a rolling restart hands a live
// turn on: the old instance detaches the turn and shuts down, the new one
// defers to the daemon, and the daemon's resume holds the turn until its real
// final. The machine must hold at least one live task the whole way.
test('a turn handed between two instances keeps its machine held until its final', async () => {
    const live = new Map<string, number>()
    const timeline: string[] = []
    const adapter = {
        holdAwake: async (_args: unknown, lease: { name: string }) => {
            live.set(lease.name, (live.get(lease.name) ?? 0) + 1)
        },
        releaseAwake: async (_args: unknown, lease: { name: string }) => {
            live.delete(lease.name)
        }
    }
    class TestAwake extends HostAwakeService {
        protected override releaseGraceMs(): number {
            return 0
        }
    }
    const instance = () =>
        new TestAwake(
            { has: () => true, for: () => adapter } as never,
            { providerForHost: async () => provider } as never
        )
    const old = instance()
    const adopter = instance()
    const h = host()
    const held = async (step: string) => {
        await settle()
        timeline.push(step)
        assert.ok(live.size > 0, `the machine is unheld after: ${step}`)
    }

    const dispatch = old.hold(h, 'turn')
    await dispatch.settled
    await held('dispatch')
    dispatch.detach()
    await held('handoff')
    const delivery = old.hold(h, 'config-delivery')
    await delivery.settled
    await delivery.release()
    await held('config delivery on the draining instance')
    await old.onModuleDestroy()
    await held('old instance shut down')

    const ensure = adopter.hold(h, 'ensure')
    await ensure.settled
    await ensure.release()
    await held('adopter defers to the daemon')
    const resume = adopter.hold(h, 'turn')
    await resume.settled
    await held('daemon resume relays the turn')
    await resume.release()
    await settle()
    assert.deepEqual(timeline.length, 6)
    // Only the old instance's handed-off task is left, lapsing by its TTL.
    assert.equal(live.size, 1)
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
