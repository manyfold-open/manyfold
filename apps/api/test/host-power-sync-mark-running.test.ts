import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeHosts } from '@manyfold/db'
import { HostPowerSyncService } from '../src/modules/agents/sprite-status/host-power-sync.service'
import { spritesResolver } from './helpers/power-sync-fakes'

const fakeHost = (over: Record<string, unknown> = {}) => ({
    id: 'host-1',
    userId: 'u-1',
    kind: 'hosted',
    providerId: 'rtp-1',
    providerRef: { kind: 'sprites', spriteName: 'nca-user-abc-main', spriteId: 'sp-1' },
    status: 'ready',
    powerState: 'suspended',
    activeAccrualSince: null,
    updatedAt: new Date('2026-04-01'),
    ...over
})

const makeDb = (host: Record<string, unknown> | null) => {
    const updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
    const chain = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: async () => []
    }
    return {
        updates,
        select: () => chain,
        update: (table: unknown) => ({
            set: (s: Record<string, unknown>) => ({
                where: () => ({
                    returning: async () => {
                        updates.push({ table, set: s })
                        return host ? [{ ...host, ...s }] : []
                    }
                })
            })
        })
    }
}

const makeService = (
    db: ReturnType<typeof makeDb>,
    host: Record<string, unknown> | null,
    findError?: Error,
    registry?: unknown,
    resolver: unknown = spritesResolver({}).resolver
) => {
    const emits: Array<{ userId: string; event: Record<string, unknown> }> = []
    const hostEmits: Array<{
        userId: string
        update: Record<string, unknown>
    }> = []
    const svc = new HostPowerSyncService(
        db as never,
        {
            findById: async () => {
                if (findError) throw findError
                return host
            }
        } as never,
        {} as never,
        resolver as never,
        {
            emit: (userId: string, event: Record<string, unknown>) => {
                emits.push({ userId, event })
            },
            emitHostUpdate: (
                userId: string,
                update: Record<string, unknown>
            ) => {
                hostEmits.push({ userId, update })
            }
        } as never,
        { event: () => {} } as never,
        { measureIfDue: async () => {}, measureHostIfDue: async () => {} } as never,
        {} as never,
        {} as never,
        {} as never,
        {
            accrue: async () => {},
            settleHostNotRunning: async () => {},
            pruneOlderThan: async () => {}
        } as never,
        {} as never,
        undefined,
        registry as never
    )
    return { svc, emits, hostEmits }
}

const nextEligible = (svc: HostPowerSyncService, providerId: string) =>
    (svc['providerNextEligibleAt' as never] as Map<string, number>).get(
        providerId
    )

const hostUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.table === runtimeHosts)

// WHY: a turn or terminal opening on an idle sprite must surface `running`
// without waiting for the up-to-30s slow poll — the publish writes the host
// row (opening the accrual watermark) and the provider is kicked onto the
// fast cadence so the later running→suspended release is reconciled in ~3s.
test('markHostRunning on a suspended host publishes running and pokes the provider', async () => {
    const host = fakeHost()
    const db = makeDb(host)
    const { svc, hostEmits } = makeService(db, host)

    await svc.markHostRunning('host-1')

    assert.equal(hostUpdates(db).length, 1, 'host power written')
    assert.equal(hostUpdates(db)[0]?.set.powerState, 'running')
    assert.ok(
        hostUpdates(db)[0]?.set.activeAccrualSince,
        'the accrual watermark opens with the publish'
    )
    // The sandbox detail panel listens on host-update instead of polling — a
    // chat/terminal wake must broadcast the host power too, or the panel
    // badge stays stale until the next listing transition.
    assert.equal(hostEmits.length, 1)
    assert.equal(hostEmits[0]?.userId, 'u-1')
    assert.equal(hostEmits[0]?.update.hostId, 'host-1')
    assert.equal(hostEmits[0]?.update.powerState, 'running')
    assert.equal(nextEligible(svc, 'rtp-1'), 0)
})

// WHY: a daemon connecting is proof its sprite runs, and it can land well
// before the next listing pass. Seen on a local stack [2026-09-28]: an agent
// read online while its sandbox still counted as asleep, so the sidebar and
// the concurrent-sandbox count disagreed until the poll caught up.
test('a daemon connecting publishes its host as running', async () => {
    const host = fakeHost()
    const db = makeDb(host)
    const hook: { listener: ((hostId: string) => void) | null } = {
        listener: null
    }
    const registry = {
        onConnected: (fn: (hostId: string) => void) => {
            hook.listener = fn
            return () => {
                hook.listener = null
            }
        }
    }
    const { svc, hostEmits } = makeService(db, host, undefined, registry)

    const watch = svc['watchDaemonConnects' as never] as () => void
    watch.call(svc)
    assert.ok(hook.listener, 'subscribed to daemon connects')
    hook.listener?.('host-1')
    for (let i = 0; i < 20 && hostEmits.length === 0; i++)
        await new Promise((resolve) => setImmediate(resolve))

    assert.equal(hostUpdates(db)[0]?.set.powerState, 'running')
    assert.equal(hostEmits[0]?.update.powerState, 'running')
    svc.onModuleDestroy()
    assert.equal(hook.listener, null, 'unsubscribed on shutdown')
})

// WHY: a row already at `running` must still kick the provider — without
// the unconditional poke a stale slow/backoff cadence would delay the release
// detection even though the publish is correctly skipped.
test('markHostRunning on an already-running host pokes without write or broadcast', async () => {
    const host = fakeHost({ powerState: 'running' })
    const db = makeDb(host)
    const { svc, hostEmits } = makeService(db, host)

    await svc.markHostRunning('host-1')

    assert.equal(hostEmits.length, 0, 'no broadcast when already running')
    assert.equal(db.updates.length, 0, 'no DB write when already running')
    assert.equal(nextEligible(svc, 'rtp-1'), 0, 'provider still poked')
})

// WHY: a local host or a cloud computer has no sprite cadence to kick — the
// hook must be a pure no-op for them.
test('markHostRunning ignores hosts that are not sandboxes', async () => {
    const local = fakeHost({ kind: 'local', providerId: null, providerRef: null })
    const db = makeDb(local)
    const { svc, hostEmits } = makeService(db, local)

    await svc.markHostRunning('host-1')

    assert.equal(hostEmits.length, 0)
    assert.equal(db.updates.length, 0)
})

// WHY: a machine that never suspends has no running time to meter and no
// fast cadence to kick.
test('markHostRunning ignores hosts whose provider never suspends them', async () => {
    const pod = fakeHost({
        providerRef: { kind: 'k8s', namespace: 'u-1', ingressHost: null, podPhase: 'Running' }
    })
    const db = makeDb(pod)
    const { svc, hostEmits } = makeService(db, pod, undefined, undefined, {
        resolve: async () => ({
            provider: { id: 'rtp-1', kind: 'k8s' },
            adapter: { kind: 'k8s', capabilities: { suspend: false, publicService: true } }
        })
    })

    await svc.markHostRunning('host-1')

    assert.equal(hostEmits.length, 0)
    assert.equal(db.updates.length, 0)
    assert.equal(nextEligible(svc, 'rtp-1'), undefined)
})

// WHY: the call site is fire-and-forget — a DB error must be swallowed,
// never surface as an unhandled rejection that could crash the process.
test('markHostRunning never rejects when the host read fails', async () => {
    const db = makeDb(null)
    const { svc, hostEmits } = makeService(db, null, new Error('db down'))

    await assert.doesNotReject(() => svc.markHostRunning('host-1'))
    assert.equal(hostEmits.length, 0)
})

// WHY: bare-sandbox terminals (no agent) rely on pokeProvider alone to
// accelerate the host running→suspended reconciliation; the start state is
// already written by reserveActiveSlot.
test('pokeProvider forces the provider eligible immediately', () => {
    const db = makeDb(null)
    const { svc } = makeService(db, null)

    svc.pokeProvider('rtp-1')

    assert.equal(nextEligible(svc, 'rtp-1'), 0)
})
