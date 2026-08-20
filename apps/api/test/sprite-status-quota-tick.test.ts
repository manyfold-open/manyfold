import test from 'node:test'
import assert from 'node:assert/strict'
import { SpriteStatusSyncService } from '../src/modules/agents/sprite-status/sprite-status-sync.service'

// #615: tickQuotaWarnings rode the 1.5s status wakeup — the 4-table candidate
// UNION ran 40x/min and every candidate paid the full ~14-query runtime-access
// summary chain once a minute, 24/7, with the wholesale soft-cap COUNT along
// for the ride. The pass now runs on its own 60s cadence. Drives the private
// method directly, like the other sprite-status-sync tests.

interface Emitted {
    userId: string
    event: Record<string, unknown>
}

const makeHarness = (opts: { due?: Array<Record<string, unknown>> } = {}) => {
    const counters = { unions: 0, selects: 0, evaluations: 0 }
    const emitted: Emitted[] = []
    const db = {
        execute: async () => {
            counters.unions += 1
            return [{ user_id: 'u-1' }]
        },
        select: () => {
            counters.selects += 1
            return {
                from: () => ({
                    where: async () => [{ value: 0 }]
                })
            }
        }
    }
    const svc = new SpriteStatusSyncService(
        db as never,
        {} as never,
        {} as never,
        {
            emitQuotaWarning: (userId: string, event: Record<string, unknown>) => {
                emitted.push({ userId, event })
            }
        } as never,
        { event: () => {} } as never,
        {} as never,
        {
            evaluateQuotaThresholds: async () => {
                counters.evaluations += 1
                return opts.due ?? []
            }
        } as never,
        {
            getCachedSpritesEffectiveCap: async () => ({
                activeCap: 10,
                softThresholdPct: 90
            })
        } as never,
        {} as never,
        {} as never
    )
    const pass = async () =>
        (svc['tickQuotaWarnings' as never] as () => Promise<void>).call(svc)
    const rearm = () => {
        ;(svc as never as { nextQuotaWarningsAt: number }).nextQuotaWarningsAt = 0
    }
    return { svc, pass, rearm, counters, emitted }
}

test('quota pass runs once per cadence window, not on every wakeup', async () => {
    const h = makeHarness()
    await h.pass()
    await h.pass()
    await h.pass()

    assert.equal(h.counters.unions, 1, 'candidate UNION runs once per window')
    assert.equal(h.counters.evaluations, 1, 'one summary chain per user per window')
    assert.equal(h.counters.selects, 1, 'wholesale COUNT inherits the gate')
})

test('quota pass re-arms after the window and per-user gate still holds', async () => {
    const h = makeHarness()
    await h.pass()
    h.rearm()
    await h.pass()

    assert.equal(h.counters.unions, 2, 're-armed pass discovers candidates again')
    assert.equal(
        h.counters.evaluations,
        1,
        'u-1 stays inside its own 60s eligibility window'
    )
})

test('due warnings still emit with the same payload', async () => {
    const h = makeHarness({
        due: [{ code: 'active_hours', usage: 9, limit: 10, planName: 'pro' }]
    })
    await h.pass()

    assert.equal(h.emitted.length, 1)
    assert.equal(h.emitted[0].userId, 'u-1')
    const event = h.emitted[0].event
    assert.equal(event.type, 'quota-warning')
    assert.equal(event.code, 'active_hours')
    assert.equal(event.usage, 9)
    assert.equal(event.limit, 10)
    assert.equal(event.planName, 'pro')
    assert.ok(typeof event.at === 'string' && event.at.length > 0)
})
