import test from 'node:test'
import assert from 'node:assert/strict'
import { SpriteStatusSyncService } from '../src/modules/agents/sprite-status/sprite-status-sync.service'

interface Recorded {
    accountId: string
    observation: Record<string, unknown>
}

const makeDb = () => ({
    select: () => ({
        from: () => ({
            where: async () => []
        })
    }),
    update: () => ({
        set: () => ({
            where: () => Promise.resolve(undefined)
        })
    })
})

const makeService = (
    listResponse: Record<string, unknown>,
    opts: { softThresholdPct?: number; wrote?: boolean } = {}
) => {
    const records: Recorded[] = []
    const events: Array<{ name: string; attrs: Record<string, unknown> }> = []
    const svc = new SpriteStatusSyncService(
        makeDb() as never,
        { getById: async () => ({ id: 'acc-1', slug: 'acct' }) } as never,
        {} as never,
        { emit: () => {}, emitHostUpdate: () => {} } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) => {
                events.push({ name, attrs })
            }
        } as never,
        { measureIfDue: async () => {}, measureHostIfDue: async () => {} } as never,
        {} as never,
        {
            recordSpritesVendorCapacity: async (
                accountId: string,
                observation: Record<string, unknown>
            ) => {
                records.push({ accountId, observation })
                return opts.wrote ?? true
            },
            getCachedSpritesWholesaleCap: async () => ({
                activeCap: 10,
                softThresholdPct: opts.softThresholdPct ?? 90
            })
        } as never,
        {} as never,
        {
            accrue: async () => {},
            settleHostNotRunning: async () => {},
            pruneOlderThan: async () => {}
        } as never
    )
    svc['clientFor' as never] = (() => ({
        listSprites: async () => listResponse,
        getSprite: async () => {
            throw new Error('unexpected getSprite call')
        }
    })) as never
    return { svc, records, events }
}

const sync = async (svc: SpriteStatusSyncService) =>
    (svc['syncAccount' as never] as (id: string) => Promise<boolean>).call(
        svc,
        'acc-1'
    )

// WHY this test exists: sprites.dev returns running/warm/cold in the list
// envelope, but those describe only the ~50 rows of THAT page — on a 91-sprite
// account page 1 reports cold: 48. Trusting them would under-report usage by
// however many pages follow. Only running_limit / warm_limit are account-level.
test('usage is counted from the full sprite list, not the page-scoped envelope counters', async () => {
    const { svc, records } = makeService({
        running: 0,
        warm: 1,
        cold: 48,
        running_limit: 10,
        warm_limit: 10,
        sprites: [
            { name: 's1', status: 'running' },
            { name: 's2', status: 'warm' },
            { name: 's3', status: 'warm' },
            { name: 's4', status: 'cold' },
            { name: 's5', status: 'cold' },
            { name: 's6', status: 'cold' }
        ]
    })
    await sync(svc)
    assert.equal(records.length, 1)
    assert.equal(records[0].accountId, 'acc-1')
    assert.deepEqual(records[0].observation, {
        slug: 'acct',
        runningLimit: 10,
        warmLimit: 10,
        running: 1,
        warm: 2,
        cold: 3
    })
})

// A vendor response missing the limit fields must persist "unknown", never 0 —
// effectiveSpritesCap would otherwise clamp the org cap to zero and 503 every
// wake on the platform.
test('absent or zero vendor limits are recorded as unknown', async () => {
    const { svc, records } = makeService({
        sprites: [{ name: 's1', status: 'cold' }],
        warm_limit: 0
    })
    await sync(svc)
    assert.equal(records[0].observation.runningLimit, null)
    assert.equal(records[0].observation.warmLimit, null)
})

test('warm at the vendor warm limit emits observation-only telemetry', async () => {
    const { svc, events } = makeService({
        warm_limit: 2,
        running_limit: 10,
        sprites: [
            { name: 's1', status: 'warm' },
            { name: 's2', status: 'warm' }
        ]
    })
    await sync(svc)
    const warm = events.filter((e) => e.name.startsWith('wholesale_warm'))
    assert.equal(warm.length, 1)
    assert.equal(warm[0].name, 'wholesale_warm_at_limit')
    assert.equal(warm[0].attrs.warm, 2)
    assert.equal(warm[0].attrs.warmLimit, 2)
    // Nothing is rejected on this ceiling yet; the attribute says so explicitly
    // so a future enforcement change is a visible diff in the telemetry too.
    assert.equal(warm[0].attrs.blocking, false)
})

test('warm above the soft threshold but below the limit emits the soft event', async () => {
    const { svc, events } = makeService(
        {
            warm_limit: 4,
            running_limit: 10,
            sprites: [
                { name: 's1', status: 'warm' },
                { name: 's2', status: 'warm' },
                { name: 's3', status: 'warm' }
            ]
        },
        { softThresholdPct: 50 }
    )
    await sync(svc)
    const warm = events.filter((e) => e.name.startsWith('wholesale_warm'))
    assert.equal(warm.length, 1)
    assert.equal(warm[0].name, 'wholesale_warm_soft_cap')
})

test('no warm telemetry when the observation was skipped as unchanged', async () => {
    const { svc, events } = makeService(
        {
            warm_limit: 1,
            sprites: [{ name: 's1', status: 'warm' }]
        },
        { wrote: false }
    )
    await sync(svc)
    assert.equal(
        events.filter((e) => e.name.startsWith('wholesale_warm')).length,
        0
    )
})

// The recorder is observability plus a clamp input. A failure there must not
// abort the status sync, which is what keeps sprite_status fresh.
test('a recorder failure does not fail the account sync', async () => {
    const { svc } = makeService({
        sprites: [{ name: 's1', status: 'cold' }]
    })
    svc['adminSettings' as never] = {
        recordSpritesVendorCapacity: async () => {
            throw new Error('app_settings unavailable')
        }
    } as never
    await assert.doesNotReject(sync(svc))
})
