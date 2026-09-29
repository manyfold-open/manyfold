import test from 'node:test'
import assert from 'node:assert/strict'
import { agentRuntimes, hostDaemons, runtimeHosts } from '@manyfold/db'
import { HostPowerSyncService } from '../src/modules/agents/sprite-status/host-power-sync.service'
import { spritesResolver } from './helpers/power-sync-fakes'

const HOST_SPRITE = 'nca-user-abc-sandbox'

const fakeHost = (over: Record<string, unknown> = {}) => ({
    id: 'host-1',
    userId: 'u-1',
    kind: 'hosted',
    providerId: 'acc-1',
    providerRef: { kind: 'sprites', spriteName: HOST_SPRITE, spriteId: 'sp-1' },
    status: 'ready',
    failureReason: null,
    powerState: 'running',
    activeAccrualSince: null,
    emptiedAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const makeDb = (
    hostRows: Array<Record<string, unknown>>,
    agentRows: Array<Record<string, unknown>> = [],
    daemonRows: Array<Record<string, unknown>> = []
) => {
    const chain = (table: unknown) => {
        const self = {
            innerJoin: () => self,
            leftJoin: () => self,
            where: async () =>
                table === runtimeHosts
                    ? hostRows
                    : table === agentRuntimes
                      ? agentRows
                      : table === hostDaemons
                        ? daemonRows
                        : []
        }
        return self
    }
    return {
        select: () => ({ from: (table: unknown) => chain(table) })
    }
}

const makeClient = (spec: {
    sprites?: Array<{ name: string; status: string }>
    getSprite?: () => Promise<unknown>
}) => ({
    listSprites: async () => ({ sprites: spec.sprites ?? [] }),
    getSprite: async () => {
        if (!spec.getSprite) throw new Error('unexpected getSprite call')
        return spec.getSprite()
    }
})

const makeService = (
    db: ReturnType<typeof makeDb>,
    client: ReturnType<typeof makeClient>
) => {
    const powerWrites: Array<{ id: string; state: string }> = []
    const hostEmits: Array<{
        userId: string
        update: Record<string, unknown>
    }> = []
    const agentEmits: Array<Record<string, unknown>> = []
    const accruals: Array<{ hostId: string; running: boolean }> = []
    const svc = new HostPowerSyncService(
        db as never,
        {
            setPower: async (id: string, state: string) => {
                powerWrites.push({ id, state })
            }
        } as never,
        {
            findById: async () => ({ id: 'acc-1', kind: 'sprites', name: 'acct' })
        } as never,
        spritesResolver(client).resolver as never,
        {
            emit: (_userId: string, event: Record<string, unknown>) => {
                agentEmits.push(event)
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
        { recordSpritesVendorCapacity: async () => false } as never,
        {} as never,
        {
            accrue: async (host: { id: string }, running: boolean) => {
                accruals.push({ hostId: host.id, running })
            },
            settleHostNotRunning: async () => {},
            pruneOlderThan: async () => {}
        } as never,
        {} as never
    )
    return { svc, powerWrites, hostEmits, agentEmits, accruals }
}

const sync = async (svc: HostPowerSyncService) =>
    (svc['syncProvider' as never] as (id: string) => Promise<boolean>).call(
        svc,
        'acc-1'
    )

// WHY: the sandbox detail panel no longer polls refresh-status; the periodic
// listing pass is the primary freshness source, so a host power transition it
// observes must reach the panel as a host-update broadcast alongside the row
// write.
test('syncHosts broadcasts a host-update when the listing state changes', async () => {
    const db = makeDb([fakeHost({ powerState: 'running' })])
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'warm' }]
    })
    const { svc, powerWrites, hostEmits } = makeService(db, client)

    await sync(svc)

    assert.deepEqual(powerWrites, [{ id: 'host-1', state: 'suspended' }])
    assert.equal(hostEmits.length, 1)
    assert.equal(hostEmits[0]?.userId, 'u-1')
    assert.equal(hostEmits[0]?.update.hostId, 'host-1')
    assert.equal(hostEmits[0]?.update.powerState, 'suspended')
})

// WHY: a sprite that goes warm freezes its daemon, whose last heartbeat stays
// inside the 45s presence window. Seen on a local stack [2026-09-28]: the
// broadcast derived the agent from the row as it was before the write (still
// running) plus that heartbeat, so a green agent sat beside a
// concurrent-sandbox count that had already let its sandbox go.
test('a sandbox going warm broadcasts its agents as wakeable', async () => {
    const heardAt = new Date(Date.now() - 30_000)
    const db = makeDb(
        [fakeHost({ powerState: 'running' })],
        [
            {
                agent: { id: 'agent-1', userId: 'u-1', status: 'ready' },
                runtime: { status: 'ready' },
                daemon: { lastSeenAt: heardAt, rpcConnectedAt: heardAt }
            }
        ],
        [{ hostId: 'host-1', lastSeenAt: heardAt }]
    )
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'warm' }]
    })
    const { svc, hostEmits, agentEmits } = makeService(db, client)

    await sync(svc)

    assert.equal(hostEmits[0]?.update.daemonOnline, true, 'heartbeat still fresh')
    assert.equal(agentEmits[0]?.powerState, 'suspended')
    assert.equal(agentEmits[0]?.availability, 'wakeable')
})

// WHY: the listing lags a wake and can stick on a stale state, while a
// daemon heartbeats every 15s and a frozen VM sends none. Seen on a local
// stack [2026-09-28]: a sprite listed `cold` for minutes as its daemon kept
// heartbeating, and every turn that published `running` was undone by the
// next pass.
test('a fresh heartbeat keeps a sandbox running that the listing calls cold', async () => {
    const db = makeDb(
        [fakeHost({ powerState: 'running' })],
        [],
        [{ hostId: 'host-1', lastSeenAt: new Date(Date.now() - 5_000) }]
    )
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'cold' }]
    })
    const { svc, powerWrites, hostEmits } = makeService(db, client)

    await sync(svc)

    assert.equal(powerWrites.length, 0)
    assert.equal(hostEmits.length, 0)
})

test('a heartbeating sandbox the listing calls cold is published running', async () => {
    const db = makeDb(
        [fakeHost({ powerState: 'stopped' })],
        [],
        [{ hostId: 'host-1', lastSeenAt: new Date(Date.now() - 5_000) }]
    )
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'cold' }]
    })
    const { svc, powerWrites, hostEmits } = makeService(db, client)

    await sync(svc)

    assert.deepEqual(powerWrites, [{ id: 'host-1', state: 'running' }])
    assert.equal(hostEmits[0]?.update.powerState, 'running')
})

// WHY: once the daemon has gone quiet past one missed heartbeat, the machine
// may really be asleep; the listing decides again.
test('a quiet daemon leaves the power state to the listing', async () => {
    const db = makeDb(
        [fakeHost({ powerState: 'running' })],
        [],
        [{ hostId: 'host-1', lastSeenAt: new Date(Date.now() - 60_000) }]
    )
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'warm' }]
    })
    const { svc, powerWrites } = makeService(db, client)

    await sync(svc)

    assert.deepEqual(powerWrites, [{ id: 'host-1', state: 'suspended' }])
})

// WHY: the sync loop re-samples every few seconds — an unchanged state must
// stay silent or every open panel gets a redundant event per tick.
test('syncHosts stays silent when the state is unchanged', async () => {
    const db = makeDb([fakeHost({ powerState: 'suspended' })])
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'warm' }]
    })
    const { svc, powerWrites, hostEmits } = makeService(db, client)

    await sync(svc)

    assert.equal(powerWrites.length, 0)
    assert.equal(hostEmits.length, 0)
})

// WHY: the sync writes the HOST's power and nothing else (R4): a suspended
// sandbox is a machine state, not a failed runtime or a stopped agent.
test('syncHosts never touches runtime or agent rows', async () => {
    const db = makeDb([fakeHost({ powerState: 'running' })])
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'cold' }]
    })
    const { svc, powerWrites } = makeService(db, client)

    await sync(svc)

    assert.deepEqual(powerWrites, [{ id: 'host-1', state: 'stopped' }])
})

// WHY: refreshHost persists the fresh state, so the poked periodic
// pass sees it as unchanged and never emits — the manual path must broadcast
// itself or a second open client misses the transition for good.
test('refreshHost broadcasts the transition it persists', async () => {
    const db = makeDb([])
    const client = makeClient({
        getSprite: async () => ({ name: HOST_SPRITE, status: 'warm' })
    })
    const { svc, powerWrites, hostEmits } = makeService(db, client)

    const state = await svc.refreshHost(
        fakeHost({ powerState: 'running' }) as never
    )

    assert.equal(state, 'suspended')
    assert.deepEqual(powerWrites, [{ id: 'host-1', state: 'suspended' }])
    assert.equal(hostEmits.length, 1)
    assert.equal(hostEmits[0]?.update.hostId, 'host-1')
    assert.equal(hostEmits[0]?.update.powerState, 'suspended')
})

// WHY: the panel fires one refresh-status on every open — a no-change probe
// must not write or broadcast, or opening the panel would spam every
// subscriber of that user.
test('refreshHost stays silent when the probe matches the row', async () => {
    const db = makeDb([])
    const client = makeClient({
        getSprite: async () => ({ name: HOST_SPRITE, status: 'warm' })
    })
    const { svc, powerWrites, hostEmits } = makeService(db, client)

    const state = await svc.refreshHost(
        fakeHost({ powerState: 'suspended' }) as never
    )

    assert.equal(state, 'suspended')
    assert.equal(powerWrites.length, 0)
    assert.equal(hostEmits.length, 0)
})

// WHY: the concurrency caps count a heartbeating sandbox as running, so active
// hours must accrue for it too. Metering from the raw listing let a sandbox
// sprites.dev misreported as `cold` hold a slot for minutes while nothing
// accrued.
test('a heartbeating sandbox the listing calls cold accrues active time', async () => {
    const db = makeDb(
        [fakeHost({ powerState: 'running' })],
        [],
        [{ hostId: 'host-1', lastSeenAt: new Date(Date.now() - 5_000) }]
    )
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'cold' }]
    })
    const { svc, accruals } = makeService(db, client)

    await sync(svc)

    assert.deepEqual(accruals, [{ hostId: 'host-1', running: true }])
})

test('a quiet daemon leaves metering to the listing', async () => {
    const db = makeDb(
        [fakeHost({ powerState: 'running' })],
        [],
        [{ hostId: 'host-1', lastSeenAt: new Date(Date.now() - 60_000) }]
    )
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'warm' }]
    })
    const { svc, accruals } = makeService(db, client)

    await sync(svc)

    assert.deepEqual(accruals, [{ hostId: 'host-1', running: false }])
})

// WHY: a sandbox held running by its daemon is billed until the hold ends,
// and the hold only ends at the next pass after the daemon goes quiet. On the
// slow cadence that pass could come ~30s later; the fast cadence bounds the
// overcount to a few seconds past the heartbeat window.
test('a sandbox held running by its daemon keeps its provider on the fast cadence', async () => {
    const db = makeDb(
        [fakeHost({ powerState: 'running' })],
        [],
        [{ hostId: 'host-1', lastSeenAt: new Date(Date.now() - 5_000) }]
    )
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'cold' }]
    })
    const { svc } = makeService(db, client)

    assert.equal(await sync(svc), true)
})

test('a provider with nothing running stays on the slow cadence', async () => {
    const db = makeDb([fakeHost({ powerState: 'suspended' })])
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'warm' }]
    })
    const { svc } = makeService(db, client)

    assert.equal(await sync(svc), false)
})

// WHY: manual refresh is the second power writer; it must correct the same
// way before it accrues, or it would meter a heartbeating sandbox as asleep
// and then write back the running state the pass had set.
test('refreshHost corrects the listing with the heartbeat before it accrues', async () => {
    const db = makeDb(
        [],
        [],
        [{ hostId: 'host-1', lastSeenAt: new Date(Date.now() - 5_000) }]
    )
    const client = makeClient({
        getSprite: async () => ({ name: HOST_SPRITE, status: 'cold' })
    })
    const { svc, powerWrites, accruals } = makeService(db, client)

    const state = await svc.refreshHost(
        fakeHost({ powerState: 'running' }) as never
    )

    assert.equal(state, 'running')
    assert.equal(powerWrites.length, 0)
    assert.deepEqual(accruals, [{ hostId: 'host-1', running: true }])
})
