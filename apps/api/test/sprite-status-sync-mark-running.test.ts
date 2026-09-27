import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeHosts } from '@manyfold/db'
import { SpriteStatusSyncService } from '../src/modules/agents/sprite-status/sprite-status-sync.service'

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
    findError?: Error
) => {
    const emits: Array<{ userId: string; event: Record<string, unknown> }> = []
    const hostEmits: Array<{
        userId: string
        update: Record<string, unknown>
    }> = []
    const svc = new SpriteStatusSyncService(
        db as never,
        {
            findById: async () => {
                if (findError) throw findError
                return host
            }
        } as never,
        {} as never,
        {} as never,
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
        {} as never
    )
    return { svc, emits, hostEmits }
}

const nextEligible = (svc: SpriteStatusSyncService, providerId: string) =>
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
