import test from 'node:test'
import assert from 'node:assert/strict'
import { agents, runtimeHosts } from '@manyfold/db'
import { SpriteStatusSyncService } from '../src/modules/agents/sprite-status/sprite-status-sync.service'

const SPRITE = 'nca-user-abc-main'

const fakeRow = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    userId: 'u-1',
    runtime: 'sprites',
    spriteName: SPRITE,
    spriteStatus: 'warm',
    k8sPodPhase: null,
    accountId: 'acc-1',
    hostId: null,
    ...over
})

const makeDb = (row: Record<string, unknown> | null, selectError?: Error) => {
    const updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
    return {
        updates,
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => {
                        if (selectError) throw selectError
                        return row ? [row] : []
                    }
                })
            })
        }),
        update: (table: unknown) => ({
            set: (s: Record<string, unknown>) => ({
                where: () => {
                    updates.push({ table, set: s })
                    return Promise.resolve(undefined)
                }
            })
        })
    }
}

const makeService = (db: ReturnType<typeof makeDb>) => {
    const emits: Array<{ userId: string; event: Record<string, unknown> }> = []
    const hostEmits: Array<{
        userId: string
        update: Record<string, unknown>
    }> = []
    const svc = new SpriteStatusSyncService(
        db as never,
        { getById: async () => ({ id: 'acc-1', slug: 'acct' }) } as never,
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
        } as never
    )
    return { svc, emits, hostEmits }
}

const nextEligible = (svc: SpriteStatusSyncService, accountId: string) =>
    (svc['accountNextEligibleAt' as never] as Map<string, number>).get(accountId)

const agentUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.table === agents)
const hostUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.table === runtimeHosts)

// WHY: a terminal opening on an idle sprite must surface `running` without
// waiting for the up-to-30s slow poll — the publish writes the row and the
// account is kicked onto the fast cadence so the later running→warm release is
// reconciled in ~3s.
test('markSpriteRunning on a warm sprite agent publishes running and pokes the account', async () => {
    const db = makeDb(fakeRow({ spriteStatus: 'warm', hostId: 'host-1' }))
    const { svc, emits, hostEmits } = makeService(db)

    await svc.markSpriteRunning('agent-1')

    assert.equal(emits.length, 1)
    assert.equal(emits[0]?.event.spriteStatus, 'running')
    assert.equal(agentUpdates(db).length, 1)
    assert.equal(agentUpdates(db)[0]?.set.spriteStatus, 'running')
    assert.equal(hostUpdates(db).length, 1, 'host mirror written when hostId set')
    // The sandbox detail panel listens on host-update instead of polling — a
    // chat/terminal wake must broadcast the mirrored host status too, or the
    // panel badge stays stale until the next listing transition.
    assert.equal(hostEmits.length, 1, 'host mirror broadcast when hostId set')
    assert.equal(hostEmits[0]?.userId, 'u-1')
    assert.equal(hostEmits[0]?.update.hostId, 'host-1')
    assert.equal(hostEmits[0]?.update.spriteStatus, 'running')
    assert.equal(nextEligible(svc, 'acc-1'), 0)
})

// WHY: a row already at `running` must still kick the account — without the
// unconditional poke a stale slow/backoff cadence would delay the release
// detection even though publishStatus is correctly skipped.
test('markSpriteRunning on an already-running agent pokes without write or broadcast', async () => {
    const db = makeDb(fakeRow({ spriteStatus: 'running' }))
    const { svc, emits } = makeService(db)

    await svc.markSpriteRunning('agent-1')

    assert.equal(emits.length, 0, 'no broadcast when already running')
    assert.equal(db.updates.length, 0, 'no DB write when already running')
    assert.equal(nextEligible(svc, 'acc-1'), 0, 'account still poked')
})

// WHY: non-sprite runtimes (k8s) have no sprite cadence to kick — the hook must
// be a pure no-op for them.
test('markSpriteRunning ignores non-sprite agents', async () => {
    const db = makeDb(fakeRow({ runtime: 'k8s' }))
    const { svc, emits } = makeService(db)

    await svc.markSpriteRunning('agent-1')

    assert.equal(emits.length, 0)
    assert.equal(db.updates.length, 0)
    assert.equal(nextEligible(svc, 'acc-1'), undefined, 'no poke for non-sprite')
})

// WHY: the terminal call site is fire-and-forget — a DB error must be swallowed,
// never surface as an unhandled rejection that could crash the process.
test('markSpriteRunning never rejects when the db read fails', async () => {
    const db = makeDb(null, new Error('db down'))
    const { svc, emits } = makeService(db)

    await assert.doesNotReject(() => svc.markSpriteRunning('agent-1'))
    assert.equal(emits.length, 0)
})

// WHY: bare-sandbox terminals (no agent) rely on pokeAccount alone to accelerate
// the host running→warm reconciliation; the start state is already written by
// reserveActiveSlot.
test('pokeAccount forces the account eligible immediately', () => {
    const db = makeDb(null)
    const { svc } = makeService(db)

    svc.pokeAccount('acc-1')

    assert.equal(nextEligible(svc, 'acc-1'), 0)
})
