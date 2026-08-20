import { sql, type SQL } from 'drizzle-orm'
import { chatStreamEvents, type NewChatStreamEventRow } from '@manyfold/db'
import type { TurnExecutionFence } from './turn-fence'

// One statement for a non-terminal stream event, in place of BEGIN / advisory
// lock / INSERT / COMMIT. A lone statement runs inside its own implicit
// transaction, so pg_advisory_xact_lock is still taken and released around
// exactly this one row, and the lock is released only after the row is
// visible. The same lock also orders the live-session row check below. Its
// `for update` predicate is rechecked after a concurrent terminal clears the
// claim, so a writer on another API instance cannot append behind it.
//
// `from lk` is what makes the lock happen BEFORE the id is drawn, and it is not
// decoration. pg_advisory_xact_lock is volatile, so Postgres cannot inline the
// CTE; the insert's rows then come from a CTE Scan on lk, which has to
// materialise lk (acquiring the lock) before it can project a row — and
// nextval() for the bigserial id is part of that projection. Drop the `from lk`
// and the CTE becomes an unreferenced SELECT that is never evaluated at all.
//
// Measured on local pg 16.10 [2026-08-09]: EXPLAIN VERBOSE puts
// `nextval('chat_stream_events_id_seq')` in the CTE Scan's output list, and
// with the lock held from another connection this statement blocks with the
// sequence untouched — while the same statement without `from lk` does not
// block and burns a sequence value.
//
// Measured on local pg 16.10 [2026-08-09], counting protocol messages on the
// socket: 6 wire exchanges down to 2. The driver runs with prepare: false, so
// every parameterised statement costs Parse/Describe/Flush, a wait for the
// parameter metadata, then Bind/Execute/Sync — two exchanges, not one. The old
// four statements were BEGIN (1, simple query) + lock (2) + insert (2) +
// COMMIT (1).
export const nonTerminalStreamEventInsert = (
    row: NewChatStreamEventRow,
    fence?: TurnExecutionFence
): SQL => {
    // Only the keyed shape can collide on the partial dedup index; a null key
    // is not in that index at all, so the plain shape stays plain rather than
    // paying for arbiter inference it can never use.
    const onConflict =
        row.sourceEventKey == null
            ? sql``
            : sql`on conflict (message_id, source_event_key, source_event_ordinal)
        where source_event_key is not null do nothing`
    const createdAt =
        row.createdAt === undefined
            ? sql`now()`
            : sql`${sql.param(row.createdAt, chatStreamEvents.createdAt)}::timestamptz`
    // A plain EXISTS is only a statement-snapshot predicate: it can read the
    // old generation while a takeover is uncommitted, then let the stale insert
    // commit after that takeover. Lock the execution tuple instead. READ
    // COMMITTED re-evaluates this predicate against the updated tuple after a
    // wait, so exactly one order is possible: either this row commits while the
    // old generation is locked and takeover follows it, or takeover commits
    // first and this CTE returns no row.
    const fenceCte = fence
        ? sql`, fence as materialized (
              select turn_executions.message_id
              from turn_executions, lk
              where turn_executions.message_id = ${fence.messageId}
                and turn_executions.session_id = ${row.sessionId}
                and turn_executions.owner_id = ${fence.ownerId}
                and turn_executions.generation = ${fence.generation}
              for update of turn_executions
          )`
        : sql``
    const liveDependency = fence ? sql`fence` : sql`lk`
    return sql`
        with lk as materialized (
            select pg_advisory_xact_lock(
                hashtext('chat_stream_events'),
                hashtext(${row.sessionId})
            )
        )${fenceCte}, live as (
            select 1
            from chat_sessions, ${liveDependency}
            where chat_sessions.id = ${row.sessionId}
              and chat_sessions.inflight_message_id = ${row.messageId}
            for update of chat_sessions
        )
        insert into chat_stream_events (
            session_id, message_id, seq, event_type, payload_json,
            source_event_key, source_event_ordinal, runner_seq, created_at
        )
        select
            ${row.sessionId}::text,
            ${row.messageId}::text,
            ${row.seq}::integer,
            ${row.eventType}::text,
            ${sql.param(row.payloadJson, chatStreamEvents.payloadJson)}::jsonb,
            ${row.sourceEventKey ?? null}::text,
            ${row.sourceEventOrdinal ?? null}::integer,
            ${row.runnerSeq ?? null}::integer,
            ${createdAt}
        from live
        ${onConflict}
        returning id
    `
}
