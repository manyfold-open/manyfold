import assert from 'node:assert/strict'
import test from 'node:test'
import {
    pickRunnerHostRow,
    staleRunnerTwins
} from '../src/modules/chat/runner/runner-host-rows'

// WHY: a double registration left two runner rows for one sprite, and the
// two lookups by name disagreed — the wake found the live one, the account
// list waited on the twin. One rule for both, and the twin is recognised.
const at = (s: string): Date => new Date(`2026-09-11T${s}Z`)
const row = (
    id: string,
    connected: string | null,
    seen: string | null,
    created = '14:16:06'
) => ({
    id,
    createdAt: at(created),
    rpcConnectedAt: connected ? at(connected) : null,
    rpcLastSeenAt: seen ? at(seen) : null
})

test('the row the runner last answered on wins over a twin nothing connected to', () => {
    const twin = row('dh_twin', null, null)
    const live = row('dh_live', '17:12:00', '17:32:50')
    assert.equal(pickRunnerHostRow([twin, live])?.id, 'dh_live')
    assert.equal(pickRunnerHostRow([live, twin])?.id, 'dh_live')
})

test('among rows that never answered the newest registration wins, and no rows is null', () => {
    const older = row('dh_old', null, null, '14:16:06')
    const newer = row('dh_new', null, null, '14:16:07')
    assert.equal(pickRunnerHostRow([older, newer])?.id, 'dh_new')
    assert.equal(pickRunnerHostRow([]), null)
})

test('a never-connected row older than the grace is a stale twin only beside a sibling that connected', () => {
    const now = at('17:40:00').getTime()
    const twin = row('dh_twin', null, null)
    const live = row('dh_live', '17:12:00', '17:32:50')
    assert.deepEqual(
        staleRunnerTwins([twin, live], now).map((r) => r.id),
        ['dh_twin']
    )
    // Alone, or with nothing ever connected, nothing is dropped.
    assert.deepEqual(staleRunnerTwins([twin], now), [])
    assert.deepEqual(
        staleRunnerTwins([twin, row('dh_other', null, null)], now),
        []
    )
    // A fresh registration still dialling in is not a twin yet.
    const fresh = row('dh_fresh', null, null, '17:35:00')
    assert.deepEqual(staleRunnerTwins([fresh, live], now), [])
})
