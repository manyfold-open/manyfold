import {
    bigint,
    index,
    jsonb,
    pgTable,
    text,
    timestamp
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { chatSessions } from './chatSessions'

export const chatMessages = pgTable(
    'chat_messages',
    {
        id: text('id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => chatSessions.id, { onDelete: 'cascade' }),
        role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
        contentBlocksJson: jsonb('content_blocks_json').notNull(),
        // Which chat_stream_events row content_blocks_json corresponds to,
        // so a mid-turn subscriber can attach with "this content plus the
        // tail after it" instead of replaying the whole turn. The pairing
        // is exact in both directions: every CONTENT-BEARING row of this
        // message with id <= this value is folded into content_blocks_json,
        // and no row with a greater id is. NULL means the pairing cannot be
        // trusted (no checkpoint yet, resume/adoption path, truncated buffer,
        // an abandoned stream write, terminal content) and readers must fall
        // back to the full replay. Only ever written in the same UPDATE as
        // content_blocks_json — see ChatService.writeAssistantContent.
        contentCheckpointEventId: bigint('content_checkpoint_event_id', {
            mode: 'bigint'
        }),
        capabilityEventsJson: jsonb('capability_events_json'),
        daemonId: text('daemon_id'),
        daemonExecRef: text('daemon_exec_ref'),
        cancelRequestedAt: timestamp('cancel_requested_at', {
            withTimezone: true
        }),
        abortDispatchedAt: timestamp('abort_dispatched_at', {
            withTimezone: true
        }),
        // Stream-log compaction evidence, so a reader of a compacted turn can
        // tell "this turn was quiet" from "this turn's token/thinking rows were
        // deleted". Written only by the compaction statement that deletes the
        // rows, in the same statement, so the count can never claim a delete
        // that did not happen. Cumulative because a turn larger than the run's
        // remaining row budget is compacted across several runs.
        //
        // bigint avoids coupling this cumulative count to the signed range or
        // starting value of chat_stream_events.seq. The candidate is already
        // terminal, so normal writers cannot reinsert rows after compaction;
        // even the full 32-bit seq domain remains exactly representable by a
        // JavaScript number. Existing rows take the constant default without a
        // rewrite (pg 11+), so old turns read as never compacted.
        compactedStreamRows: bigint('compacted_stream_rows', { mode: 'number' })
            .notNull()
            .default(0),
        streamCompactedAt: timestamp('stream_compacted_at', {
            withTimezone: true
        }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        sessionCreatedIdx: index('chat_messages_session_created_idx').on(
            table.sessionId,
            table.createdAt
        ),
        daemonExecRefIdx: index('chat_messages_daemon_exec_ref_idx')
            .on(table.daemonId, table.daemonExecRef)
            .where(sql`${table.daemonExecRef} is not null`)
    })
)

export type ChatMessage = typeof chatMessages.$inferSelect
export type NewChatMessage = typeof chatMessages.$inferInsert
