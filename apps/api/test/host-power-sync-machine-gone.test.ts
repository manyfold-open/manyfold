import test from 'node:test'
import assert from 'node:assert/strict'
import { agents, runtimeHosts } from '@manyfold/db'
import { SpritesError } from '@manyfold/sprites'
import {
    HostPowerSyncService,
    HOST_GONE_REASON
} from '../src/modules/agents/sprite-status/host-power-sync.service'
import { spritesResolver } from './helpers/power-sync-fakes'

const SPRITE = 'nca-user-abc-main'
const GONE_REASON = HOST_GONE_REASON

const fakeHost = (over: Record<string, unknown> = {}) => ({
    id: 'host-1',
    userId: 'u-1',
    kind: 'hosted',
    providerId: 'acc-1',
    providerRef: { kind: 'sprites', spriteName: SPRITE, spriteId: 'sp-1' },
    name: 'sandbox-001',
    status: 'ready',
    failureReason: null,
    powerState: 'running',
    activeAccrualSince: null,
    emptiedAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

// Every select answers by table: host rows for runtime_hosts, an agent count
// for the agents join, nothing for the broadcast join.
const makeDb = (
    hostRows: Array<Record<string, unknown>>,
    agentCount = 1
) => {
    const updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
    const chain = (table: unknown) => {
        const self = {
            innerJoin: () => self,
            leftJoin: () => self,
            where: async () => {
                if (table === runtimeHosts) return hostRows
                if (table === agents) return [{ value: agentCount }]
                return []
            }
        }
        return self
    }
    return {
        updates,
        select: () => ({ from: (table: unknown) => chain(table) }),
        update: (table: unknown) => ({
            set: (s: Record<string, unknown>) => ({
                where: () => {
                    updates.push({ table, set: s })
                    return {
                        returning: async () => [{ id: 'host-1' }],
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
    const hostEmits: Array<{ userId: string; update: Record<string, unknown> }> =
        []
    const events: Array<{ name: string; payload: Record<string, unknown> }> =
        []
    const deleted: string[] = []
    const powerWrites: Array<{ id: string; state: string }> = []
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
            emit: () => {},
            emitHostUpdate: (userId: string, update: Record<string, unknown>) => {
                hostEmits.push({ userId, update })
            }
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
        } as never,
        {
            deleteHost: async (id: string) => {
                deleted.push(id)
            }
        } as never
    )
    return { svc, hostEmits, events, deleted, powerWrites }
}

const sync = async (svc: HostPowerSyncService) =>
    (svc['syncProvider' as never] as (id: string) => Promise<boolean>).call(
        svc,
        'acc-1'
    )

const hostUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.table === runtimeHosts)

const missingSince = (svc: HostPowerSyncService) =>
    svc['hostMissingSince' as never] as Map<string, number>

// WHY: one absent listing is indistinguishable from a transient control-plane
// inconsistency — it must never trigger a confirmation call or a DB write.
test('first missing listing arms the window without getSprite or writes', async () => {
    const db = makeDb([fakeHost()])
    const client = makeClient({ sprites: [] })
    const { svc } = makeService(db, client)

    await sync(svc)

    assert.ok(
        missingSince(svc).has('host-1'),
        'absence must arm the confirmation window'
    )
    assert.equal(client.getSpriteCalls.length, 0)
    assert.equal(db.updates.length, 0)
})

// WHY: a recycled sprite under a host that still carries agents is the host
// failing (R4: host lifecycle), not a stopped runtime or agent — the agents
// read as unavailable through the host, and every one of them hears it.
test('elapsed window + getSprite not_found fails a host that still has agents', async () => {
    const db = makeDb([fakeHost()], 2)
    const client = makeClient({
        sprites: [],
        getSprite: async () => {
            throw new SpritesError('not_found', 'gone', 404)
        }
    })
    const { svc, hostEmits, events, deleted } = makeService(db, client)
    missingSince(svc).set('host-1', Date.now() - 121_000)

    await sync(svc)

    assert.deepEqual(client.getSpriteCalls, [SPRITE])
    const [host] = hostUpdates(db)
    assert.equal(host.set.status, 'failed')
    assert.equal(host.set.failureReason, GONE_REASON)
    assert.equal(host.set.powerState, 'unknown')
    assert.deepEqual(deleted, [], 'a host with agents is never deleted by the sync')
    assert.equal(hostEmits.length, 1)
    assert.equal(hostEmits[0].update.powerState, 'unknown')
    assert.deepEqual(
        events.map((e) => e.name),
        ['host.sprite_deleted']
    )
    assert.equal(
        missingSince(svc).has('host-1'),
        false,
        'tracking must be cleared after marking'
    )
})

// WHY: an empty host whose VM is gone has nothing left to protect — it goes
// through the one host delete path (R8) rather than lingering as failed.
test('elapsed window + getSprite not_found deletes an agent-less host', async () => {
    const db = makeDb([fakeHost()], 0)
    const client = makeClient({
        sprites: [],
        getSprite: async () => {
            throw new SpritesError('not_found', 'gone', 404)
        }
    })
    const { svc, deleted } = makeService(db, client)
    missingSince(svc).set('host-1', Date.now() - 121_000)

    await sync(svc)

    assert.deepEqual(deleted, ['host-1'])
    assert.equal(hostUpdates(db).length, 0)
})

// WHY: listing absence alone must never fail a host — the per-sprite 404
// is the only definitive evidence of deletion.
test('elapsed window + getSprite success clears tracking without writes', async () => {
    const db = makeDb([fakeHost()])
    const client = makeClient({
        sprites: [],
        getSprite: async () => ({ name: SPRITE, status: 'warm' })
    })
    const { svc } = makeService(db, client)
    missingSince(svc).set('host-1', Date.now() - 121_000)

    await sync(svc)

    assert.deepEqual(client.getSpriteCalls, [SPRITE])
    assert.equal(missingSince(svc).has('host-1'), false)
    assert.equal(db.updates.length, 0)
})

// WHY: a transient or auth failure on the confirm call says nothing about the
// VM; the window stays armed and nothing is written.
test('transient getSprite error keeps the window and writes nothing', async () => {
    const db = makeDb([fakeHost()])
    const client = makeClient({
        sprites: [],
        getSprite: async () => {
            throw new SpritesError('transient', 'boom', 503)
        }
    })
    const { svc } = makeService(db, client)
    const armedAt = Date.now() - 121_000
    missingSince(svc).set('host-1', armedAt)

    await sync(svc)

    assert.equal(missingSince(svc).get('host-1'), armedAt)
    assert.equal(db.updates.length, 0)
})

// WHY: a host younger than the provisioning grace never enters the window —
// createSprite → listing visibility lags.
test('a host younger than the provisioning grace never arms the window', async () => {
    const db = makeDb([fakeHost({ createdAt: new Date() })])
    const client = makeClient({ sprites: [] })
    const { svc } = makeService(db, client)

    await sync(svc)

    assert.equal(missingSince(svc).has('host-1'), false)
})

// WHY: absence evidence older than the stale bound likely predates a sync
// blackout; it is re-armed rather than confirmed against one fresh listing.
test('stale absence evidence re-arms the window without getSprite', async () => {
    const db = makeDb([fakeHost()])
    const client = makeClient({ sprites: [] })
    const { svc } = makeService(db, client)
    missingSince(svc).set('host-1', Date.now() - 20 * 60_000)

    await sync(svc)

    assert.ok(Date.now() - missingSince(svc).get('host-1')! < 5_000)
    assert.equal(client.getSpriteCalls.length, 0)
})

// WHY: a listing failure must not be mistaken for absence.
test('listSprites failure rejects syncProvider and leaves tracking untouched', async () => {
    const db = makeDb([fakeHost()])
    const client = makeClient({ listError: new Error('vendor 500') })
    const { svc } = makeService(db, client)

    await assert.rejects(() => sync(svc), /vendor 500/)
    assert.equal(missingSince(svc).has('host-1'), false)
    assert.equal(db.updates.length, 0)
})

// WHY: symmetric recovery — a control-plane incident or a false positive that
// hid the VM must not leave the host failed once it is listed again.
test('a sprite reappearing revives a host failed by the gone marker', async () => {
    const db = makeDb([
        fakeHost({ status: 'failed', failureReason: GONE_REASON })
    ])
    const client = makeClient({
        sprites: [{ name: SPRITE, status: 'warm' }]
    })
    const { svc, events } = makeService(db, client)

    await sync(svc)

    const [host] = hostUpdates(db)
    assert.equal(host.set.status, 'ready')
    assert.equal(host.set.failureReason, null)
    assert.deepEqual(
        events.map((e) => e.name),
        ['host.sprite_restored']
    )
})

// WHY: only our own marker scopes revival; a host failed for any other
// reason stays failed even with its VM listed.
test('a failed host with an unrelated failureReason is not revived', async () => {
    const db = makeDb([
        fakeHost({ status: 'failed', failureReason: 'bootstrap exited 1' })
    ])
    const client = makeClient({
        sprites: [{ name: SPRITE, status: 'warm' }]
    })
    const { svc, events } = makeService(db, client)

    await sync(svc)

    assert.equal(hostUpdates(db).length, 0)
    assert.deepEqual(events, [])
})
