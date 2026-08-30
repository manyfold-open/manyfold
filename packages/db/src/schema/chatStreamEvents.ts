import {
    bigserial,
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { chatSessions } from './chatSessions'
import { chatMessages } from './chatMessages'

export const chatStreamEvents = pgTable(
    'chat_stream_events',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => chatSessions.id, { onDelete: 'cascade' }),
        messageId: text('message_id')
            .notNull()
            .references(() => chatMessages.id, { onDelete: 'cascade' }),
        seq: integer('seq').notNull(),
        eventType: text('event_type', {
            enum: [
                'token',
                'tool_call',
                'tool_result',
                'thinking',
                'replace',
                'error',
                'done',
                'suspended',
                'turn_status',
                'permission_request',
                'permission_resolution'
            ]
        }).notNull(),
        payloadJson: jsonb('payload_json').notNull(),
        sourceEventKey: text('source_event_key'),
        sourceEventOrdinal: integer('source_event_ordinal'),
        // Transport watermark for resuming a runner turn EXACTLY: every byte up
        // to this seq had already been emitted as an earlier row when this row
        // was written. Rows land in emit order, so a durable row proves its
        // predecessors are durable — which makes max(runner_seq) over rows a
        // cursor that neither skips content nor re-sends any.
        //
        // Why "already emitted before this row" and not "this row's content":
        // the broadcaster coalesces consecutive same-key token events, so a row
        // can span several transport chunks. A claim about the row's own extent
        // could not be bounded; a claim about everything preceding it can.
        // Re-sending is what makes delta streams unsafe (their (key, ordinal)
        // identity shifts with merge boundaries, so a replayed row collides with
        // different text and is silently dropped), so the cursor has to be exact
        // rather than conservative.
        runnerSeq: integer('runner_seq'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        messageSeqUnique: uniqueIndex(
            'chat_stream_events_message_seq_unique'
        ).on(table.messageId, table.seq),
        sessionIdIdIdx: index('chat_stream_events_session_id_id_idx').on(
            table.sessionId,
            table.id
        ),
        messageIdIdIdx: index('chat_stream_events_message_id_id_idx').on(
            table.messageId,
            table.id
        ),
        sourceDedupUnique: uniqueIndex(
            'chat_stream_events_source_dedup_unique'
        )
            .on(table.messageId, table.sourceEventKey, table.sourceEventOrdinal)
            .where(sql`${table.sourceEventKey} is not null`),
        // Terminal probe. noTerminalStreamEvent() asks "does this message
        // have a done/error row yet" on every newest-page message fetch, on
        // the SSE subscribes that carry neither a cursor nor a replay id
        // (a cold reload sends one, so it short-circuits there), on cancel
        // and channel checks, and on every dead-turn sweep — the list is
        // not exhaustive — and event_type is in no other index,
        // so the probe had to read every event row of the message and filter.
        // Partial on the two terminal types so it holds ~one row per message
        // instead of one per token. Written as `in ('done', 'error')` to
        // match the inArray() those callers emit: a partial index is only
        // usable when the planner can prove the query implies its predicate.
        // Measured on local pg 16 [2026-08-09], 9 assistant turns × 450 rows
        // each: the probe drops from a seq scan filtering 4,050 rows to an
        // Index Only Scan with Heap Fetches: 0 (59 → 3 shared buffers), and
        // the index is 16 kB against 144 kB for the message_id one.
        messageTerminalIdx: index('chat_stream_events_message_terminal_idx')
            .on(table.messageId)
            .where(sql`${table.eventType} in ('done', 'error')`)
    })
)

export type ChatStreamEventRow = typeof chatStreamEvents.$inferSelect
export type NewChatStreamEventRow = typeof chatStreamEvents.$inferInsert
