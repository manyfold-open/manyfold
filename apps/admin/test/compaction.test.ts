import assert from 'node:assert/strict'
import test from 'node:test'
import {
    sessionCompaction,
    turnCompaction
} from '../src/pages/ChatSessions/compaction'

// #672. The Chat session page counts the stream rows still stored, so a turn
// retention emptied and a turn that never said much render the same number.
// These are the two functions the page asks for the difference, and every case
// below is a shape the API can really return: a turn from before the columns
// existed (0 / null), a partially compacted turn a later run will finish, and
// a stored count with no timestamp.
const turn = (
    compactedStreamRows: number,
    streamCompactedAt: string | null = null
): { compactedStreamRows: number; streamCompactedAt: string | null } => ({
    compactedStreamRows,
    streamCompactedAt
})

test('a turn nothing compacted reads as a turn nothing compacted', () => {
    const result = turnCompaction(turn(0), 'en-US')
    assert.equal(result.compacted, false)
    assert.equal(result.label, '—')
    assert.equal(result.at, '')
})

test('a compacted turn reports how many rows it lost and when', () => {
    const result = turnCompaction(
        turn(1420, '2026-08-14T03:04:05.000Z'),
        'en-US'
    )
    assert.equal(result.compacted, true)
    assert.equal(
        result.label,
        'compacted ×1,420',
        'the count is grouped, because these run to six figures'
    )
    assert.ok(
        result.at.includes('2026'),
        `the timestamp is rendered for a reader, got ${JSON.stringify(result.at)}`
    )
})

test('a count with no timestamp says so instead of rendering Invalid Date', () => {
    assert.equal(turnCompaction(turn(7), 'en-US').at, 'time unknown')
    assert.equal(
        turnCompaction(turn(7, 'not-a-date'), 'en-US').at,
        'time unknown'
    )
    // The count is the durable claim; a missing or unparsable timestamp must
    // not take the fact of compaction down with it.
    assert.equal(turnCompaction(turn(7, 'not-a-date'), 'en-US').compacted, true)
})

test('a nonsensical count is not treated as evidence', () => {
    for (const rows of [-1, Number.NaN, Number.POSITIVE_INFINITY])
        assert.equal(
            turnCompaction(turn(rows), 'en-US').compacted,
            false,
            `${rows} is not a number of deleted rows`
        )
})

test('a session with nothing compacted gets no note at all', () => {
    const result = sessionCompaction([turn(0), turn(0)], 'en-US')
    assert.equal(result.turns, 0)
    assert.equal(result.rows, 0)
    assert.equal(
        result.note,
        null,
        'the page must not warn about compaction that never happened'
    )
})

test('the session note says the counts on the page are post-compaction', () => {
    const result = sessionCompaction(
        [turn(0), turn(1200, '2026-08-14T03:04:05.000Z'), turn(300)],
        'en-US'
    )
    assert.equal(result.turns, 2)
    assert.equal(result.rows, 1500)
    assert.equal(
        result.note,
        'Counts are post-compaction: retention has deleted 1,500 token/thinking rows from 2 of the turns listed below.'
    )
})

test('the note stays grammatical when one turn lost one row', () => {
    assert.equal(
        sessionCompaction([turn(1)], 'en-US').note,
        'Counts are post-compaction: retention has deleted 1 token/thinking row from the turn listed below.'
    )
})

test('a bad count cannot poison the session total', () => {
    const result = sessionCompaction([turn(Number.NaN), turn(10)], 'en-US')
    assert.equal(result.turns, 1)
    assert.equal(result.rows, 10)
})
