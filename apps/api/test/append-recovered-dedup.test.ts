import assert from 'node:assert/strict'
import test from 'node:test'
import type { NewChatMessage, NewChatMessageSource } from '@manyfold/db'
import { dedupRecoveredRowsBySourceKey } from '../src/modules/chat/recovered-dedup'

const message = (id: string): NewChatMessage => ({ id }) as NewChatMessage
const source = (messageId: string, sourceEventKey: string): NewChatMessageSource =>
    ({ messageId, sourceEventKey }) as NewChatMessageSource

// The first sync of a fresh terminal delta stores everything.
test('keeps every message when no source key is stored yet', () => {
    const rows = [message('m1'), message('m2')]
    const sources = [source('m1', 'k1'), source('m2', 'k2')]
    const res = dedupRecoveredRowsBySourceKey(rows, sources, new Set())
    assert.deepEqual(
        res.messageRows.map((r) => r.id),
        ['m1', 'm2']
    )
    assert.equal(res.sourceRows.length, 2)
})

// A concurrent second sync computed the same delta from stale state; by the
// time it runs the lock has let the first commit, so both keys already exist
// and it appends nothing — the whole point of the fix.
test('drops the whole delta on a full re-sync (idempotent)', () => {
    const rows = [message('m1'), message('m2')]
    const sources = [source('m1', 'k1'), source('m2', 'k2')]
    const res = dedupRecoveredRowsBySourceKey(
        rows,
        sources,
        new Set(['k1', 'k2'])
    )
    assert.equal(res.messageRows.length, 0)
    assert.equal(res.sourceRows.length, 0)
})

// A partial overlap keeps only the genuinely new lines and their sources.
test('drops only the messages whose source key is already stored', () => {
    const rows = [message('m1'), message('m2'), message('m3')]
    const sources = [
        source('m1', 'k1'),
        source('m2', 'k2'),
        source('m3', 'k3')
    ]
    const res = dedupRecoveredRowsBySourceKey(
        rows,
        sources,
        new Set(['k1', 'k3'])
    )
    assert.deepEqual(
        res.messageRows.map((r) => r.id),
        ['m2']
    )
    assert.deepEqual(
        res.sourceRows.map((s) => s.sourceEventKey),
        ['k2']
    )
})
