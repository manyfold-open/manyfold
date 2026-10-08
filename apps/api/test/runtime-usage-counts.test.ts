import assert from 'node:assert/strict'
import test from 'node:test'
import {
    HOSTED_LIVE_STATUSES,
    LIVE_SPRITES_HOST_SQL
} from '../src/modules/runtime-access/runtime-usage-counts'

// The quota, concurrency and admin-overview counts read the builder set, and a
// few scalar subqueries read the raw-SQL twin. A status in one and not the
// other made the two disagree about how many machines a user holds.
test('the raw-SQL live-host twin lists exactly the live statuses', () => {
    const listed = /h\.status in \(([^)]*)\)/.exec(LIVE_SPRITES_HOST_SQL)?.[1]
    assert.ok(listed, 'the twin filters on status')
    assert.deepEqual(
        listed
            .split(',')
            .map((s) => s.trim().replace(/^'|'$/g, ''))
            .sort(),
        [...HOSTED_LIVE_STATUSES].sort()
    )
})

// A sandbox in maintenance failed its provider's health check, but its machine
// still exists and is still billed: it keeps holding its slot.
test('a sandbox in maintenance still counts as a live machine', () => {
    assert.ok(HOSTED_LIVE_STATUSES.includes('maintenance'))
    assert.ok(!HOSTED_LIVE_STATUSES.includes('failed' as never))
})
