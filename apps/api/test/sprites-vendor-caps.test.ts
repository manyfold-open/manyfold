import assert from 'node:assert/strict'
import test from 'node:test'
import {
    effectiveSpritesCap,
    parseVendorObservation,
    shouldRecordObservation,
    vendorCapacityView,
    VENDOR_CAPS_REFRESH_MS,
    VENDOR_CAPS_STALE_MS,
    type SpritesVendorAccountObservation
} from '../src/modules/admin-settings/sprites-vendor-caps'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')

const policy = { activeCap: 10, softThresholdPct: 90 }

const observation = (
    patch: Partial<SpritesVendorAccountObservation> = {}
): SpritesVendorAccountObservation => ({
    slug: 'netminduk',
    runningLimit: 10,
    warmLimit: 10,
    running: 0,
    warm: 1,
    cold: 89,
    observedAt: new Date(NOW - 1000).toISOString(),
    ...patch
})

test('with no vendor observation the admin policy is used unchanged', () => {
    const cap = effectiveSpritesCap(policy, {}, NOW)
    assert.equal(cap.activeCap, 10)
    assert.equal(cap.vendorRunningLimit, null)
    assert.equal(cap.clamped, false)
})

test('a lower vendor running_limit clamps the enforced cap', () => {
    const cap = effectiveSpritesCap(
        { activeCap: 50, softThresholdPct: 90 },
        { acct: observation({ runningLimit: 10 }) },
        NOW
    )
    assert.equal(cap.activeCap, 10)
    assert.equal(cap.policyActiveCap, 50)
    assert.equal(cap.clamped, true)
})

// The admin setting stays a deliberate way to hold capacity BELOW what the
// vendor sells (reserve headroom). Vendor truth must never widen it.
test('a higher vendor running_limit does not raise the policy cap', () => {
    const cap = effectiveSpritesCap(
        { activeCap: 4, softThresholdPct: 90 },
        { acct: observation({ runningLimit: 100 }) },
        NOW
    )
    assert.equal(cap.activeCap, 4)
    assert.equal(cap.clamped, false)
})

// If the status-sync loop dies, admission must degrade to exactly the
// pre-clamp behavior rather than freezing at a cap nobody can refresh.
test('a stale observation stops clamping and falls back to policy', () => {
    const stale = observation({
        runningLimit: 2,
        observedAt: new Date(NOW - VENDOR_CAPS_STALE_MS - 1).toISOString()
    })
    const cap = effectiveSpritesCap(
        { activeCap: 50, softThresholdPct: 90 },
        { acct: stale },
        NOW
    )
    assert.equal(cap.activeCap, 50)
    assert.equal(cap.vendorRunningLimit, null)
    assert.equal(cap.clamped, false)
})

// A vendor response without the limit fields must read as "unknown", never as
// zero — a zero ceiling would 503 every wake on the platform.
test('a null running_limit is ignored rather than treated as zero', () => {
    const cap = effectiveSpritesCap(
        policy,
        { acct: observation({ runningLimit: null }) },
        NOW
    )
    assert.equal(cap.activeCap, 10)
    assert.equal(cap.vendorRunningLimit, null)
    assert.equal(cap.clamped, false)
})

test('running_limit sums across accounts', () => {
    const cap = effectiveSpritesCap(
        { activeCap: 50, softThresholdPct: 90 },
        {
            a: observation({ slug: 'a', runningLimit: 10 }),
            b: observation({ slug: 'b', runningLimit: 6 })
        },
        NOW
    )
    assert.equal(cap.vendorRunningLimit, 16)
    assert.equal(cap.activeCap, 16)
})

test('an unchanged fresh observation is not re-written', () => {
    const known = observation()
    const { observedAt: _observedAt, ...next } = observation()
    assert.equal(shouldRecordObservation(known, next, NOW), false)
})

test('a changed count is written immediately', () => {
    const known = observation({ warm: 1 })
    const { observedAt: _observedAt, ...next } = observation({ warm: 2 })
    assert.equal(shouldRecordObservation(known, next, NOW), true)
})

test('an unchanged observation refreshes once it ages past the refresh window', () => {
    const known = observation({
        observedAt: new Date(NOW - VENDOR_CAPS_REFRESH_MS - 1).toISOString()
    })
    const { observedAt: _observedAt, ...next } = observation()
    assert.equal(shouldRecordObservation(known, next, NOW), true)
})

test('a never-seen account is always written', () => {
    const { observedAt: _observedAt, ...next } = observation()
    assert.equal(shouldRecordObservation(undefined, next, NOW), true)
})

test('the admin view reports per-account staleness and excludes stale totals', () => {
    const view = vendorCapacityView(
        policy,
        {
            fresh: observation({ slug: 'fresh', warm: 2, cold: 10 }),
            old: observation({
                slug: 'old',
                warm: 5,
                cold: 20,
                observedAt: new Date(
                    NOW - VENDOR_CAPS_STALE_MS - 1
                ).toISOString()
            })
        },
        NOW
    )
    assert.deepEqual(
        view.accounts.map((a) => [a.slug, a.stale]),
        [
            ['fresh', false],
            ['old', true]
        ]
    )
    assert.equal(view.warmTotal, 2)
    assert.equal(view.coldTotal, 10)
    assert.equal(view.warmLimitTotal, 10)
})

test('malformed persisted observations are dropped, not coerced', () => {
    assert.equal(parseVendorObservation(null), null)
    assert.equal(parseVendorObservation({ slug: 'a' }), null)
    assert.equal(parseVendorObservation({ observedAt: 'x' }), null)
    const parsed = parseVendorObservation({
        slug: 'a',
        observedAt: 'x',
        running: 'nope',
        runningLimit: 'nope'
    })
    assert.equal(parsed?.running, 0)
    assert.equal(parsed?.runningLimit, null)
})
