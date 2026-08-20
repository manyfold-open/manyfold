import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeHosts } from '@manyfold/db'
import { SpriteStatusSyncService } from '../src/modules/agents/sprite-status/sprite-status-sync.service'

const HOST_SPRITE = 'nca-user-abc-sandbox'

const fakeHost = (over: Record<string, unknown> = {}) => ({
    id: 'host-1',
    userId: 'u-1',
    kind: 'sandbox',
    status: 'active',
    accountId: 'acc-1',
    spriteId: 'sp-1',
    spriteName: HOST_SPRITE,
    spriteStatus: 'running',
    activeAccrualSince: null,
    emptiedAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const makeDb = (hostRows: Array<Record<string, unknown>>) => {
    const updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
    return {
        updates,
        select: () => ({
            from: (table: unknown) => ({
                where: async () => (table === runtimeHosts ? hostRows : [])
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
    const hostEmits: Array<{
        userId: string
        update: Record<string, unknown>
    }> = []
    const svc = new SpriteStatusSyncService(
        db as never,
        { getById: async () => ({ id: 'acc-1', slug: 'acct' }) } as never,
        {} as never,
        {
            emit: () => {},
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
            accrue: async () => {},
            settleHostNotRunning: async () => {},
            pruneOlderThan: async () => {}
        } as never
    )
    svc['clientFor' as never] = (() => client) as never
    return { svc, hostEmits }
}

const sync = async (svc: SpriteStatusSyncService) =>
    (svc['syncAccount' as never] as (id: string) => Promise<boolean>).call(
        svc,
        'acc-1'
    )

// WHY: the sandbox detail panel no longer polls refresh-status; the periodic
// listing pass is the primary freshness source, so a host status transition it
// observes must reach the panel as a host-update broadcast alongside the row
// write.
test('syncSandboxHosts broadcasts a host-update when the listing status changes', async () => {
    const db = makeDb([fakeHost({ spriteStatus: 'running' })])
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'warm' }]
    })
    const { svc, hostEmits } = makeService(db, client)

    await sync(svc)

    assert.equal(db.updates.length, 1)
    assert.equal(db.updates[0]?.set.spriteStatus, 'warm')
    assert.equal(hostEmits.length, 1)
    assert.equal(hostEmits[0]?.userId, 'u-1')
    assert.equal(hostEmits[0]?.update.hostId, 'host-1')
    assert.equal(hostEmits[0]?.update.spriteStatus, 'warm')
})

// WHY: the sync loop re-samples every few seconds — an unchanged status must
// stay silent or every open panel gets a redundant event per tick.
test('syncSandboxHosts stays silent when the status is unchanged', async () => {
    const db = makeDb([fakeHost({ spriteStatus: 'warm' })])
    const client = makeClient({
        sprites: [{ name: HOST_SPRITE, status: 'warm' }]
    })
    const { svc, hostEmits } = makeService(db, client)

    await sync(svc)

    assert.equal(db.updates.length, 0)
    assert.equal(hostEmits.length, 0)
})

// WHY: refreshSandboxHost persists the fresh status, so the poked periodic
// pass sees it as unchanged and never emits — the manual path must broadcast
// itself or a second open client misses the transition for good.
test('refreshSandboxHost broadcasts the transition it persists', async () => {
    const db = makeDb([])
    const client = makeClient({
        getSprite: async () => ({ name: HOST_SPRITE, status: 'warm' })
    })
    const { svc, hostEmits } = makeService(db, client)

    const status = await svc.refreshSandboxHost(
        fakeHost({ spriteStatus: 'running' }) as never
    )

    assert.equal(status, 'warm')
    assert.equal(db.updates.length, 1)
    assert.equal(hostEmits.length, 1)
    assert.equal(hostEmits[0]?.update.hostId, 'host-1')
    assert.equal(hostEmits[0]?.update.spriteStatus, 'warm')
})

// WHY: the panel fires one refresh-status on every open — a no-change probe
// must not write or broadcast, or opening the panel would spam every
// subscriber of that user.
test('refreshSandboxHost stays silent when the probe matches the row', async () => {
    const db = makeDb([])
    const client = makeClient({
        getSprite: async () => ({ name: HOST_SPRITE, status: 'warm' })
    })
    const { svc, hostEmits } = makeService(db, client)

    const status = await svc.refreshSandboxHost(
        fakeHost({ spriteStatus: 'warm' }) as never
    )

    assert.equal(status, 'warm')
    assert.equal(db.updates.length, 0)
    assert.equal(hostEmits.length, 0)
})