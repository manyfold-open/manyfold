import test from 'node:test'
import assert from 'node:assert/strict'
import { agentRuntimes, agents } from '@manyfold/db'
import { SpritesError } from '@manyfold/sprites'
import { SpriteStatusSyncService } from '../src/modules/agents/sprite-status/sprite-status-sync.service'

const SPRITE = 'nca-user-abc-main'
const GONE_REASON = `sprite ${SPRITE} not found on sprites.dev`

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    userId: 'u-1',
    name: 'main',
    framework: 'narranexus',
    kind: 'sprites',
    status: 'ready',
    accountId: 'acc-1',
    spriteName: SPRITE,
    spriteId: 'sp-1',
    primaryAgentId: 'agent-1',
    namespace: null,
    ingressHost: null,
    clusterId: null,
    currentPhase: null,
    failureReason: null,
    startedAt: new Date('2026-04-01'),
    lastBootstrappedAt: new Date('2026-04-01'),
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const fakeDbAgent = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    userId: 'u-1',
    runtimeId: 'rt-1',
    framework: 'narranexus',
    runtime: 'sprites',
    name: 'a1',
    internalId: 'agent-1',
    status: 'running',
    spriteStatus: 'running',
    k8sPodPhase: null,
    workspacePath: null,
    spriteName: SPRITE,
    spriteId: 'sp-1',
    accountId: 'acc-1',
    fileRoots: [],
    extras: {},
    model: null,
    namespace: null,
    ingressHost: null,
    clusterId: null,
    failureReason: null,
    startedAt: new Date('2026-04-01'),
    lastBootstrappedAt: new Date('2026-04-01'),
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const makeDb = (
    agentRows: Array<Record<string, unknown>>,
    runtimeRows: Array<Record<string, unknown>>
) => {
    const updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
    return {
        updates,
        select: () => ({
            from: (table: unknown) => ({
                where: async () =>
                    table === agentRuntimes ? runtimeRows : agentRows
            })
        }),
        update: (table: unknown) => ({
            set: (s: Record<string, unknown>) => ({
                where: () => {
                    updates.push({ table, set: s })
                    return {
                        returning: async () => [{ id: 'rt-1' }],
                        then: (
                            res: (v: unknown) => unknown,
                            rej: (e: unknown) => unknown
                        ) => Promise.resolve(undefined).then(res, rej)
                    }
                }
            })
        })
    }
}

interface FakeClientSpec {
    sprites?: Array<{ name: string; status: string }>
    listError?: Error
    getSprite?: (name: string) => Promise<unknown>
}

const makeClient = (spec: FakeClientSpec) => {
    const getSpriteCalls: string[] = []
    return {
        getSpriteCalls,
        listSprites: async () => {
            if (spec.listError) throw spec.listError
            return { sprites: spec.sprites ?? [] }
        },
        getSprite: async (name: string) => {
            getSpriteCalls.push(name)
            if (!spec.getSprite) throw new Error('unexpected getSprite call')
            return spec.getSprite(name)
        }
    }
}

const makeService = (
    db: ReturnType<typeof makeDb>,
    client: ReturnType<typeof makeClient>
) => {
    const emits: Array<{ userId: string; event: Record<string, unknown> }> = []
    const events: Array<{ name: string; payload: Record<string, unknown> }> =
        []
    const svc = new SpriteStatusSyncService(
        db as never,
        { getById: async () => ({ id: 'acc-1', slug: 'acct' }) } as never,
        {} as never,
        {
            emit: (userId: string, event: Record<string, unknown>) => {
                emits.push({ userId, event })
            },
            emitHostUpdate: () => {}
        } as never,
        {
            event: (name: string, payload: Record<string, unknown>) => {
                events.push({ name, payload })
            }
        } as never,
        { measureIfDue: async () => {}, measureHostIfDue: async () => {} } as never,
        {} as never,
        { recordSpritesVendorCapacity: async () => false } as never,
        {} as never,
        {
            accrue: async () => {},
            settleHostNotRunning: async () => {},
            pruneOlderThan: async () => {}
        } as never
    )
    svc['clientFor' as never] = (() => client) as never
    return { svc, emits, events }
}

const sync = async (svc: SpriteStatusSyncService) =>
    (svc['syncAccount' as never] as (id: string) => Promise<boolean>).call(
        svc,
        'acc-1'
    )

const runtimeUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.table === agentRuntimes)
const agentUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.table === agents)

// Scenario 1: first listing miss only arms the window.
// WHY: one absent listing is indistinguishable from a transient control-plane
// inconsistency — it must never trigger a confirmation call or a DB write.
test('first missing listing arms the window without getSprite or writes', async () => {
    const db = makeDb([fakeDbAgent()], [fakeRuntime()])
    const client = makeClient({ sprites: [] })
    const { svc } = makeService(db, client)

    await sync(svc)

    assert.ok(
        svc['spriteMissingSince'].has('rt-1'),
        'absence must arm the confirmation window'
    )
    assert.equal(client.getSpriteCalls.length, 0)
    assert.equal(db.updates.length, 0)
})

// Scenario 2: confirmed deletion marks runtime + agents stopped.
// WHY: this is the #107 self-heal path — a recycled sprite must stop the
// reconcile HTTP polling (runtime leaves 'ready') and release the frozen
// 'running' occupancy slot (spriteStatus null).
test('elapsed window + getSprite not_found marks runtime and agents stopped', async () => {
    const db = makeDb([fakeDbAgent()], [fakeRuntime()])
    const client = makeClient({
        sprites: [],
        getSprite: async () => {
            throw new SpritesError('not_found', 'gone', 404)
        }
    })
    const { svc, emits, events } = makeService(db, client)
    svc['spriteMissingSince'].set('rt-1', Date.now() - 121_000)

    await sync(svc)

    assert.deepEqual(client.getSpriteCalls, [SPRITE])
    const [rt] = runtimeUpdates(db)
    assert.equal(rt.set.status, 'stopped')
    assert.equal(rt.set.failureReason, GONE_REASON)
    const [ag] = agentUpdates(db)
    assert.equal(ag.set.status, 'stopped')
    assert.equal(ag.set.spriteStatus, null)
    assert.equal(ag.set.failureReason, GONE_REASON)
    assert.equal(emits.length, 1)
    assert.equal(emits[0].event.spriteStatus, null)
    assert.deepEqual(
        events.map((e) => e.name),
        ['agent.runtime.sprite_deleted']
    )
    assert.equal(
        svc['spriteMissingSince'].has('rt-1'),
        false,
        'tracking must be cleared after marking'
    )
})

// Scenario 3: getSprite succeeding clears the window without writes.
// WHY: listing absence alone must never kill a runtime — the per-sprite 404
// is the only definitive evidence of deletion.
test('elapsed window + getSprite success clears tracking without writes', async () => {
    const db = makeDb([fakeDbAgent()], [fakeRuntime()])
    const client = makeClient({
        sprites: [],
        getSprite: async () => ({ name: SPRITE, status: 'warm' })
    })
    const { svc } = makeService(db, client)
    svc['spriteMissingSince'].set('rt-1', Date.now() - 121_000)

    await sync(svc)

    assert.equal(db.updates.length, 0)
    assert.equal(svc['spriteMissingSince'].has('rt-1'), false)
})

// Scenario 4: transient confirmation error keeps the window armed.
// WHY: a 5xx/timeout from the control plane is not evidence of deletion;
// the next tick retries the confirmation.
test('transient getSprite error keeps the window and writes nothing', async () => {
    const db = makeDb([fakeDbAgent()], [fakeRuntime()])
    const client = makeClient({
        sprites: [],
        getSprite: async () => {
            throw new SpritesError('transient', 'boom', 503)
        }
    })
    const { svc } = makeService(db, client)
    const armedAt = Date.now() - 121_000
    svc['spriteMissingSince'].set('rt-1', armedAt)

    await sync(svc)

    assert.equal(db.updates.length, 0)
    assert.equal(svc['spriteMissingSince'].get('rt-1'), armedAt)
})

// Scenario 5: sprite reappearing in the listing clears the window.
// WHY: the tracker keys on continuous absence; one present listing resets
// the evidence while the normal status sync keeps working.
test('sprite present in listing clears tracking and syncs status normally', async () => {
    const db = makeDb([fakeDbAgent()], [fakeRuntime()])
    const client = makeClient({
        sprites: [{ name: SPRITE, status: 'warm' }]
    })
    const { svc } = makeService(db, client)
    svc['spriteMissingSince'].set('rt-1', Date.now() - 121_000)

    await sync(svc)

    assert.equal(svc['spriteMissingSince'].has('rt-1'), false)
    assert.equal(client.getSpriteCalls.length, 0)
    const [ag] = agentUpdates(db)
    assert.equal(
        ag.set.spriteStatus,
        'warm',
        'normal running→warm sync must keep working'
    )
    assert.equal(runtimeUpdates(db).length, 0)
})

// Scenario 6: pending runtimes are exempt.
// WHY: the provisioner flips status to 'ready' only after sprite creation;
// 'pending' absence is a provisioning race, not a deletion.
test('pending runtime never arms the window', async () => {
    const db = makeDb(
        [fakeDbAgent()],
        [fakeRuntime({ status: 'pending' })]
    )
    const client = makeClient({ sprites: [] })
    const { svc } = makeService(db, client)

    await sync(svc)

    assert.equal(svc['spriteMissingSince'].has('rt-1'), false)
    assert.equal(client.getSpriteCalls.length, 0)
    assert.equal(db.updates.length, 0)
})

// Scenario 7: freshly created runtimes are exempt.
// WHY: createSprite → listing visibility can lag; the provisioning grace
// keeps eventual consistency from ever feeding the window.
test('runtime younger than the provisioning grace never arms the window', async () => {
    const db = makeDb(
        [fakeDbAgent()],
        [fakeRuntime({ createdAt: new Date() })]
    )
    const client = makeClient({ sprites: [] })
    const { svc } = makeService(db, client)

    await sync(svc)

    assert.equal(svc['spriteMissingSince'].has('rt-1'), false)
    assert.equal(db.updates.length, 0)
})

// Scenario 8: stale absence evidence re-arms instead of confirming.
// WHY: evidence older than the stale bound likely predates a sync blackout
// (process pause / account backoff) — confirming against it would let a
// single fresh listing kill a runtime.
test('stale absence evidence re-arms the window without getSprite', async () => {
    const db = makeDb([fakeDbAgent()], [fakeRuntime()])
    const client = makeClient({ sprites: [] })
    const { svc } = makeService(db, client)
    const staleAt = Date.now() - 10 * 60_000
    svc['spriteMissingSince'].set('rt-1', staleAt)

    await sync(svc)

    const rearmedAt = svc['spriteMissingSince'].get('rt-1')
    assert.ok(rearmedAt !== undefined && rearmedAt > staleAt)
    assert.equal(client.getSpriteCalls.length, 0)
    assert.equal(db.updates.length, 0)
})

// Scenario 9: a failed listing never counts as a miss.
// WHY: when listSprites throws there is no absence evidence at all — the
// account backoff in tickSprites owns that failure, not the deletion tracker.
test('listSprites failure rejects syncAccount and leaves tracking untouched', async () => {
    const db = makeDb([fakeDbAgent()], [fakeRuntime()])
    const client = makeClient({ listError: new Error('control plane down') })
    const { svc } = makeService(db, client)
    const armedAt = Date.now() - 60_000
    svc['spriteMissingSince'].set('rt-1', armedAt)

    await assert.rejects(sync(svc))

    assert.equal(svc['spriteMissingSince'].get('rt-1'), armedAt)
    assert.equal(db.updates.length, 0)
})

// Scenario 10: symmetric revive when the sprite reappears.
// WHY: a false positive (control-plane incident) must not lock the user out
// forever — exactly what markSpriteDeleted stopped gets un-stopped, scoped
// by the failureReason marker so unrelated stops are never touched.
test('sprite reappearing revives a runtime stopped by the gone marker', async () => {
    const db = makeDb(
        [
            fakeDbAgent({
                status: 'stopped',
                spriteStatus: null,
                failureReason: GONE_REASON
            })
        ],
        [fakeRuntime({ status: 'stopped', failureReason: GONE_REASON })]
    )
    const client = makeClient({
        sprites: [{ name: SPRITE, status: 'warm' }]
    })
    const { svc, events } = makeService(db, client)

    await sync(svc)

    const rt = runtimeUpdates(db).find((u) => u.set.status === 'ready')
    assert.ok(rt, 'runtime must be flipped back to ready')
    assert.equal(rt.set.failureReason, null)
    const ag = agentUpdates(db).find((u) => u.set.status === 'running')
    assert.ok(ag, 'marker-stopped agents must be flipped back to running')
    assert.equal(ag.set.failureReason, null)
    assert.ok(events.some((e) => e.name === 'agent.runtime.sprite_restored'))
})

// Scenario 10b: stops with other reasons are never revived.
// WHY: the marker is the scope — an admin/teardown stop must stay stopped.
test('stopped runtime with an unrelated failureReason is not revived', async () => {
    const db = makeDb(
        [
            fakeDbAgent({
                status: 'stopped',
                spriteStatus: null,
                failureReason: 'manually stopped'
            })
        ],
        [fakeRuntime({ status: 'stopped', failureReason: 'manually stopped' })]
    )
    const client = makeClient({
        sprites: [{ name: SPRITE, status: 'warm' }]
    })
    const { svc, events } = makeService(db, client)

    await sync(svc)

    assert.equal(
        runtimeUpdates(db).length,
        0,
        'no runtime write without the gone marker'
    )
    assert.equal(events.length, 0)
})
