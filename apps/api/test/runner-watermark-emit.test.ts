import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'

// The emit side of the exact resume cursor. `runner_seq` on a stream-event row
// means "everything through this transport seq had ALREADY been emitted as an
// earlier row". The broadcaster is the only place that can honour that, because
// it is what merges consecutive token events into one row — so a row's own
// extent is unbounded and only a claim about what PRECEDES it can be proven.
//
// Getting the direction wrong is not a cosmetic bug: the cursor would claim
// content that is still being written, and resuming past un-persisted delta text
// loses it permanently (its (key, ordinal) identity shifts between runs, so the
// replacement collides with a stored row and is dropped).

interface Row {
    seq: number
    eventType: string
    payloadJson: Record<string, unknown>
    sourceEventKey: string | null
    runnerSeq: number | null
}

const buildBroadcaster = () => {
    const rows: Row[] = []
    let nextId = 1n
    const repo = {
        insertStreamEvent: async (row: Row) => {
            rows.push(row)
            return { id: nextId++ }
        },
        maxStreamEventSeq: async () => 0,
        listStreamEventsSince: async () => []
    }
    const bus = {
        onMessage: () => {},
        onListenEstablished: () => {},
        notify: () => {}
    }
    const b = new ChatSseBroadcaster(repo as never, bus as never)
    // kick() pumps rows to subscribers; there are none here and it would need a
    // full session pump, so it is neutralised.
    ;(b as unknown as { kick: () => void }).kick = () => {}
    return { b, rows }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

test('a non-buffered row carries the watermark it was emitted with', async () => {
    const { b, rows } = buildBroadcaster()
    b.beginStream('cts_1', 'msg_1')

    await b.emit('msg_1', {
        type: 'tool_call',
        payload: { type: 'tool_call' },
        runnerSeq: 7
    } as never)
    await settle()

    assert.equal(rows.length, 1)
    assert.equal(rows[0].runnerSeq, 7)
})

test('a coalesced row carries the LAST watermark of its run, not the first', async () => {
    const { b, rows } = buildBroadcaster()
    b.beginStream('cts_1', 'msg_1')

    // One merged row spanning three deltas of the same block. Chunk boundaries
    // fell after the first and third.
    await b.emit('msg_1', {
        type: 'token',
        payload: { type: 'token', text: 'a' },
        sourceEventKey: 'k1',
        runnerSeq: 3
    } as never)
    await b.emit('msg_1', {
        type: 'token',
        payload: { type: 'token', text: 'b' },
        sourceEventKey: 'k1',
        runnerSeq: null
    } as never)
    await b.emit('msg_1', {
        type: 'token',
        payload: { type: 'token', text: 'c' },
        sourceEventKey: 'k1',
        runnerSeq: 8
    } as never)
    b.endStream('msg_1')
    await settle()

    const tokens = rows.filter((r) => r.eventType === 'token')
    // The first delta of an idle stream gets a leading-edge write of its own
    // (that rule exists so first-token latency is unaffected), so 'b' and 'c'
    // are the ones that coalesce.
    assert.equal(tokens.length, 2)
    assert.equal(tokens[0].payloadJson.text, 'a')
    assert.equal(tokens[0].runnerSeq, 3)
    assert.equal(tokens[1].payloadJson.text, 'bc')
    // WHY the max and not the first: this row CONTAINS the text up to seq 8. An
    // unstamped 'b' merged with a stamped 'c' must publish 8 — publishing null
    // or an older seq would make a resume re-send text this row already holds,
    // and a re-sent delta row is the case that gets silently dropped.
    assert.equal(tokens[1].runnerSeq, 8)
})

test('an unstamped run stays unstamped rather than inheriting a stale seq', async () => {
    const { b, rows } = buildBroadcaster()
    b.beginStream('cts_1', 'msg_1')

    await b.emit('msg_1', {
        type: 'token',
        payload: { type: 'token', text: 'x' },
        sourceEventKey: 'k1',
        runnerSeq: 5
    } as never)
    // Different key ⇒ new row. It has no watermark of its own, and must not
    // borrow the previous one: nothing has proven those bytes are durable yet.
    await b.emit('msg_1', {
        type: 'token',
        payload: { type: 'token', text: 'y' },
        sourceEventKey: 'k2',
        runnerSeq: null
    } as never)
    b.endStream('msg_1')
    await settle()

    const tokens = rows.filter((r) => r.eventType === 'token')
    assert.equal(tokens.length, 2)
    assert.equal(tokens[0].runnerSeq, 5)
    assert.equal(tokens[1].runnerSeq, null)
})
