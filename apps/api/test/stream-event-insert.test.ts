import assert from 'node:assert/strict'
import test from 'node:test'
import { getTableColumns } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { chatStreamEvents } from '@manyfold/db'
import { nonTerminalStreamEventInsert } from '../src/modules/chat/stream-event-insert'

// The house fake db never builds SQL, so a malformed statement on the busiest
// write path in the product would pass every other test in this directory and
// fail only in production. This file runs the real Drizzle serializer over the
// statement and asserts its shape; whether Postgres agrees is settled by
// chat-inflight-claim.pg.test.ts, which EXPLAINs the same node.

const dialect = new PgDialect()
const serialize = (
    row: Parameters<typeof nonTerminalStreamEventInsert>[0],
    fence?: Parameters<typeof nonTerminalStreamEventInsert>[1]
): { sql: string; params: unknown[] } => {
    const q = dialect.sqlToQuery(nonTerminalStreamEventInsert(row, fence))
    return { sql: q.sql, params: q.params }
}

const BASE = {
    sessionId: 'cts_1',
    messageId: 'msg_1',
    seq: 7,
    eventType: 'token' as const,
    payloadJson: { type: 'token', text: 'hi' },
    createdAt: new Date('2026-08-09T01:02:03.456Z')
}

test('the lock CTE is declared before the insert and the insert depends on it', () => {
    const { sql } = serialize(BASE)
    const lock = sql.indexOf('pg_advisory_xact_lock')
    const insert = sql.indexOf('insert into chat_stream_events')
    const from = sql.indexOf('from live')
    assert.ok(lock >= 0 && insert > lock, 'lock CTE must precede the insert')
    // WHY this assertion exists: live depends on lk, and the insert must
    // depend on live; otherwise Postgres can skip the lock/claim checks.
    assert.ok(from > insert, 'the insert must select FROM the live CTE')
    assert.ok(sql.indexOf('returning id') > from)
})

test('a non-terminal row requires the message to own the session turn', () => {
    const { sql, params } = serialize(BASE)
    const lock = sql.indexOf('from chat_sessions, lk')
    const insert = sql.indexOf('insert into chat_stream_events')
    assert.ok(lock >= 0 && insert > lock)
    assert.match(
        sql,
        /where chat_sessions\.id = \$\d+\s+and chat_sessions\.inflight_message_id = \$\d+\s+for update of chat_sessions/
    )
    assert.deepEqual(params.slice(1, 3), [BASE.sessionId, BASE.messageId])
    assert.ok(sql.indexOf('from live') > insert)
})

test('a fenced insert locks and rechecks the exact execution generation', () => {
    const fence = {
        messageId: BASE.messageId,
        ownerId: 'replica-a',
        generation: 7
    }
    const { sql, params } = serialize(BASE, fence)
    assert.match(sql, /fence as materialized/)
    assert.match(
        sql,
        /turn_executions\.message_id = \$\d+\s+and turn_executions\.session_id = \$\d+\s+and turn_executions\.owner_id = \$\d+\s+and turn_executions\.generation = \$\d+\s+for update of turn_executions/
    )
    assert.ok(
        sql.indexOf('from turn_executions, lk') <
            sql.indexOf('from chat_sessions, fence'),
        'the stream advisory lock and execution tuple precede the session row'
    )
    assert.deepEqual(params.slice(0, 7), [
        BASE.sessionId,
        BASE.messageId,
        BASE.sessionId,
        fence.ownerId,
        fence.generation,
        BASE.sessionId,
        BASE.messageId
    ])
})

test('every column of chat_stream_events except the serial id is written', () => {
    const { sql } = serialize(BASE)
    const columns = Object.values(getTableColumns(chatStreamEvents))
        .map((c) => c.name)
        .filter((name) => name !== 'id')
    const header = sql.slice(
        sql.indexOf('insert into chat_stream_events'),
        sql.indexOf('select', sql.indexOf('insert into chat_stream_events'))
    )
    for (const name of columns)
        assert.ok(header.includes(name), `${name} is not written by the insert`)
})

test('a keyed row dedups on the partial index, an unkeyed row does not try to', () => {
    const keyed = serialize({
        ...BASE,
        sourceEventKey: 'k1',
        sourceEventOrdinal: 2
    })
    assert.match(
        keyed.sql,
        /on conflict \(message_id, source_event_key, source_event_ordinal\)\s+where source_event_key is not null do nothing/
    )
    // A null key is not in the partial unique index, so the plain shape cannot
    // collide there and must not pay for arbiter inference.
    assert.ok(!serialize(BASE).sql.includes('on conflict'))
})

test('values are bound in column order and through the column encoders', () => {
    const { params } = serialize({
        ...BASE,
        sourceEventKey: 'k1',
        sourceEventOrdinal: 2,
        runnerSeq: 42
    })
    assert.deepEqual(params, [
        // hashtext() argument, the live-session guard, then nine column values
        'cts_1',
        'cts_1',
        'msg_1',
        'cts_1',
        'msg_1',
        7,
        'token',
        '{"type":"token","text":"hi"}',
        'k1',
        2,
        42,
        '2026-08-09T01:02:03.456Z'
    ])
})

test('an absent createdAt falls back to the column default rather than binding null', () => {
    const { sql, params } = serialize({
        sessionId: 'cts_1',
        messageId: 'msg_1',
        seq: 1,
        eventType: 'thinking',
        payloadJson: {}
    })
    assert.ok(sql.includes('now()'))
    assert.equal(params.length, 11)
    assert.deepEqual(params.slice(8), [null, null, null])
})
