import { sql, type SQL } from 'drizzle-orm'
import { chatMessages, chatStreamEvents } from '@manyfold/db'
import { ASSISTANT_BLOCKS_TRUNCATION_MARKER } from '@/modules/chat/assistant-blocks'
import { isRepresentableWindowDays } from './retention-window'

// The only rows a finished turn no longer needs. Everything else in the log is
// still read after the fact: tool_call/tool_result carry the transcript the UI
// renders, replace carries a moderated or upstream-converged answer, suspended
// and done/error are the terminal evidence every recovery path arbitrates on
// (findTerminalStreamEvent, terminalErrorsForMessages).
export const COMPACTABLE_EVENT_TYPES = ['token', 'thinking'] as const

// Compacting a turn that finished minutes ago races the readers that are still
// pointed at it: an SSE client resuming from Last-Event-ID, a cold reload using
// replayMessageId, a channel/A2A consumer converging on the same message. None
// of those are bounded by anything shorter than a browser session, so a
// sub-week value is clamped UP rather than honoured — same reasoning as the
// #668 turn budgets. `0`/unset stays the explicit off switch.
export const STREAM_LOG_COMPACT_FLOOR_DAYS = 7

// Messages per batch. Each one cascades into hundreds of token rows, so this is
// deliberately the same 200 the retention sweep uses for message deletes.
export const STREAM_LOG_COMPACT_BATCH_SIZE = 200
export const STREAM_LOG_COMPACT_BATCH_PAUSE_MS = 200
// Two caps because the rows-per-message ratio is not knowable in advance: a
// fleet of chatty turns hits the row cap after a few hundred messages, a fleet
// of one-line answers would otherwise walk the whole table to reach it.
export const STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN = 200_000
export const STREAM_LOG_COMPACT_MAX_MESSAGES_PER_RUN = 20_000

export const resolveCompactAfterDays = (raw: string | undefined): number => {
    if (raw === undefined || raw.trim() === '') return 0
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 1) return 0
    const days = Math.max(STREAM_LOG_COMPACT_FLOOR_DAYS, Math.floor(parsed))
    // A window whose cutoff is not a representable date throws on
    // toISOString() in the candidate query and rejects the whole run. `0` is
    // already this knob's answer to anything it cannot read, so an
    // out-of-range value is off rather than a crash.
    return isRepresentableWindowDays(days) ? days : 0
}

export const compactionCutoff = (now: Date, afterDays: number): Date =>
    new Date(now.getTime() - afterDays * 24 * 60 * 60 * 1000)

// One catalog read, no table access: reltuples is the planner's own estimate
// and pg_total_relation_size sums heap + indexes + toast from the same catalog.
// A count(*) on this table is the exact scan #672 exists to avoid.
export const streamLogSizeQuery = (): SQL => sql`
    select
        coalesce(
            (
                select c.reltuples
                from pg_class c
                where c.oid = to_regclass('public.chat_stream_events')
            ),
            -1
        )::float8 as estimated_rows,
        coalesce(
            pg_total_relation_size(to_regclass('public.chat_stream_events')),
            0
        )::float8 as total_bytes
`

// Candidates are driven from chat_messages, never from a scan of
// chat_stream_events.created_at — that column has no index and the issue rules
// out building one on the largest table in the schema. The keyset on m.id (a
// UUIDv7-derived ObjectId, so id order is insert order) walks chat_messages_pkey
// once per run instead of restarting at row 0 for every batch, which is what
// turns a full drain from O(n^2) into O(n).
//
// The terminal test is "the NEWEST row of this message is a done|error older
// than the cutoff", which is deliberately stricter than "has a done|error older
// than the cutoff". Two reasons: it costs exactly one backward index tuple on
// (message_id, id) regardless of how many rows the turn produced, where the
// looser form scans forward through every token row before reaching the
// terminal; and a message that gained a row after its terminal is a message
// something is still writing to, which is precisely what compaction must not
// touch. Refusing to compact it is the safe direction of the error.
export const streamLogCandidateQuery = (
    cutoff: Date,
    afterId: string,
    limit: number
): SQL => {
    // A raw sql`` template has no column to infer an encoder from, and the
    // driver refuses a bare Date there — so the cutoff is bound as text with an
    // explicit cast rather than left to guess.
    const at = cutoff.toISOString()
    return sql`
    select m.id as id
    from ${chatMessages} m
    cross join lateral (
        select e.event_type as event_type, e.created_at as created_at
        from ${chatStreamEvents} e
        where e.message_id = m.id
        order by e.id desc
        limit 1
    ) newest
    where m.role = 'assistant'
      and m.created_at < ${at}::timestamptz
      and m.id > ${afterId}
      and left(
              coalesce(m.content_blocks_json -> 0 ->> 'text', ''),
              ${ASSISTANT_BLOCKS_TRUNCATION_MARKER.length}
          ) <> ${ASSISTANT_BLOCKS_TRUNCATION_MARKER}
      and newest.event_type in ('done', 'error')
      and newest.created_at < ${at}::timestamptz
      and exists (
          select 1
          from ${chatStreamEvents} t
          where t.message_id = m.id
            and t.event_type in ('token', 'thinking')
      )
    order by m.id
    limit ${limit}
`
}

export interface StreamLogCompactBatch {
    rowsDeleted: number
    messagesCompacted: number
    // Messages whose evidence columns were written. Equal to messagesCompacted
    // on every path this statement controls; the caller reports a divergence
    // rather than trusting it, because the only way to reach one is rows
    // vanishing under the delete, and then some turn lost its rows without
    // recording that it did.
    messagesStamped: number
}

// One statement that selects, deletes and records — so the run cap is enforced
// by the thing that mutates rows rather than by a count taken before it.
//
// The victim CTE's LIMIT is the cap. #672's failure was structural: the loop
// tested its budget between batches, then issued one unbounded delete per
// batch, so a single turn with more rows than the whole run's budget blew
// through it in one statement and 200 ordinary turns did the same in
// aggregate. A LIMIT inside the selection cannot be overshot by a batch,
// by a message, or by a row count that changed since it was measured.
//
// Driven per message through a LATERAL rather than as one
// `message_id = any(...) ... order by message_id, id limit n`: the LATERAL is
// a nested loop by construction, so it reads one index range per message and
// stops the moment the outer LIMIT is satisfied. The flat form asks the
// planner for globally ordered output from a ScalarArrayOpExpr index scan,
// which only PostgreSQL 17+ can deliver without a Sort — and a Sort has to
// read every matching row of the batch before the LIMIT can discard any,
// which is the work the cap exists to avoid. Deletion order follows from
// that shape: candidates in the batch's order, rows within a message in id
// order, so a truncated run leaves ONE partially compacted message rather
// than a hundred. No cursor is kept over it. A message that kept rows still
// satisfies the candidate predicate's `exists (token|thinking)`, and every
// run restarts the keyset at '', so the residue is simply picked up again.
//
// Measured on local pg 16.13 [2026-08-14], 20 candidate messages × 2,500 rows
// (stream-log-compaction.pg.test.ts pins it): with a budget narrower than a
// message — the case the cap exists for — the selection is Nested Loop ->
// Function Scan on unnest + Index Scan using
// chat_stream_events_message_id_id_idx with no Sort, and the delete resolves
// its victims through chat_stream_events_pkey. With a budget wider than every
// message in the batch the planner switches each inner scan to a bitmap scan
// plus a per-message Sort; that reads no row the statement does not then
// delete, so it is left alone rather than hinted away.
export const streamLogCompactStatement = (
    messageIds: string[],
    rowBudget: number,
    apply: boolean
): SQL => {
    const ids = sql.join(
        messageIds.map((id) => sql`${id}`),
        sql`, `
    )
    const types = sql.join(
        COMPACTABLE_EVENT_TYPES.map((type) => sql`${type}`),
        sql`, `
    )
    const batch = apply
        ? sql`locked_batch as materialized (
        select locked.message_id as message_id
        from unnest(array[${ids}]::text[]) as candidate(message_id)
        cross join lateral (
            select m.id as message_id
            from ${chatMessages} m
            where m.id = candidate.message_id
            for update
        ) locked
    ),`
        : sql``
    const batchSource = apply
        ? sql`locked_batch as batch`
        : sql`unnest(array[${ids}]::text[]) as batch(message_id)`
    const victim = sql`victim as (
        select v.id as id, v.message_id as message_id
        from ${batchSource}
        cross join lateral (
            select e.id as id, e.message_id as message_id
            from ${chatStreamEvents} e
            where e.message_id = batch.message_id
              and e.event_type in (${types})
            order by e.id
            limit ${rowBudget}
        ) v
        limit ${rowBudget}
    )`
    // A dry run is the same selection with the two data-modifying CTEs
    // removed, so it previews the capped set exactly — including which
    // message the cap truncates — and writes neither rows nor evidence.
    // The message count is grouped rather than count(distinct): a DISTINCT
    // aggregate is sort-only in postgres, and at the shipped budget that is a
    // 200,000-row sort a HashAggregate does for nothing.
    if (!apply)
        return sql`
    with ${batch}${victim}
    select
        (select count(*) from victim)::int as rows_deleted,
        (
            select count(*)
            from (select message_id from victim group by message_id) m
        )::int as messages_compacted,
        0 as messages_stamped
`
    // Evidence is written from the delete's own RETURNING, in the same
    // statement, so it is exactly as durable as the deletion: a statement that
    // fails leaves neither, and a re-run that deletes nothing produces an
    // empty per_message and therefore stamps nothing. Cumulative addition is
    // what makes a turn compacted across several runs come out right.
    //
    // Lock each parent before reading its event range. Message retention locks
    // that same parent before its FK cascade reaches events, so an expired
    // lease that briefly lets both jobs overlap cannot invert the two tables'
    // lock order. The locked CTE is consumed by victim, and FOR UPDATE prevents
    // it from being inlined into the event scan. Dry runs use the lock-free
    // batch source above.
    return sql`
    with ${batch}${victim},
    deleted as (
        delete from ${chatStreamEvents} d
        where d.id in (select id from victim)
        returning d.message_id as message_id
    ),
    per_message as (
        select message_id, count(*)::int as rows_deleted
        from deleted
        group by message_id
    ),
    stamped as (
        update ${chatMessages} m
        set compacted_stream_rows = m.compacted_stream_rows + pm.rows_deleted,
            stream_compacted_at = now()
        from per_message pm
        where m.id = pm.message_id
        returning m.id as id
    )
    select
        (select count(*) from deleted)::int as rows_deleted,
        (select count(*) from per_message)::int as messages_compacted,
        (select count(*) from stamped)::int as messages_stamped
`
}

export const readStreamLogCompactBatch = (
    rows: unknown[]
): StreamLogCompactBatch => {
    const row = rows[0] as
        | {
              rows_deleted: number | string | null
              messages_compacted: number | string | null
              messages_stamped: number | string | null
          }
        | undefined
    return {
        rowsDeleted: Number(row?.rows_deleted ?? 0),
        messagesCompacted: Number(row?.messages_compacted ?? 0),
        messagesStamped: Number(row?.messages_stamped ?? 0)
    }
}
