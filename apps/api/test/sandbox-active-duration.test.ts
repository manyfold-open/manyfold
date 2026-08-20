import assert from 'node:assert/strict'
import test from 'node:test'
import { accrualBuckets } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration-math'

const CAP = 90_000

// WHY: a host observed running across samples credits the elapsed wall-clock
// (floored to whole seconds) to the current UTC day — this is the happy path
// the whole meter rests on, and day buckets are what billing-period windows
// sum over.
test('accrualBuckets credits floored elapsed seconds to the current day', () => {
    const since = Date.UTC(2026, 5, 15, 10, 0, 0)
    const buckets = accrualBuckets(since, since + 9_500, CAP)
    assert.deepEqual(buckets, [{ day: '2026-06-15', seconds: 9 }])
})

// WHY: a sync blackout (deploy / process restart) longer than CAP must NOT book
// phantom runtime. Capping advances the start to now-CAP, so the meter
// under-counts (≤ CAP) rather than over-bills a customer for time we never
// observed. 20 real minutes credit at most CAP seconds, not 1200.
test('accrualBuckets caps a blackout to CAP seconds (conservative, never over-bills)', () => {
    const since = Date.UTC(2026, 5, 15, 10, 0, 0)
    const now = since + 20 * 60 * 1000
    const buckets = accrualBuckets(since, now, CAP)
    const total = buckets.reduce((s, b) => s + b.seconds, 0)
    assert.equal(total, CAP / 1000)
    assert.deepEqual(buckets, [{ day: '2026-06-15', seconds: 90 }])
})

// WHY: a sprite running across midnight UTC must credit each day its own
// seconds, not dump the whole interval into the new day — a billing period
// whose boundary falls between those days would otherwise misfile the split.
test('accrualBuckets splits an interval that straddles a UTC day boundary', () => {
    const since = Date.UTC(2026, 5, 15, 23, 59, 0)
    const now = Date.UTC(2026, 5, 16, 0, 0, 30)
    // cap large enough that the split, not the cap, is under test
    const buckets = accrualBuckets(since, now, 3_600_000)
    assert.deepEqual(buckets, [
        { day: '2026-06-15', seconds: 60 },
        { day: '2026-06-16', seconds: 30 }
    ])
})

// WHY: month rollover is just another day boundary now, but it's the one the
// original meter got wrong in production — keep it pinned.
test('accrualBuckets splits across a month rollover into the right days', () => {
    const since = Date.UTC(2026, 5, 30, 23, 59, 0)
    const now = Date.UTC(2026, 6, 1, 0, 0, 30)
    const buckets = accrualBuckets(since, now, 3_600_000)
    assert.deepEqual(buckets, [
        { day: '2026-06-30', seconds: 60 },
        { day: '2026-07-01', seconds: 30 }
    ])
})

// WHY: the opening sample of a running stretch (now === since) has no elapsed
// interval — it must accrue nothing, or every wake would double-count its start.
test('accrualBuckets returns nothing for a zero-length interval', () => {
    const t = Date.UTC(2026, 5, 15, 10, 0, 0)
    assert.deepEqual(accrualBuckets(t, t, CAP), [])
})

// WHY: clock skew between API instances (now < since) must never yield negative
// or garbage credit; it degrades to a no-op.
test('accrualBuckets returns nothing when now precedes since (clock skew)', () => {
    const since = Date.UTC(2026, 5, 15, 10, 0, 0)
    assert.deepEqual(accrualBuckets(since, since - 5_000, CAP), [])
    assert.deepEqual(accrualBuckets(NaN, since, CAP), [])
})
