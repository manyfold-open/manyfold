import { sql } from 'drizzle-orm'
import {
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { chatMessages } from './chatMessages'
import { chatSessions } from './chatSessions'

export const chatMessageSources = pgTable(
    'chat_message_sources',
    {
        id: text('id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => chatSessions.id, { onDelete: 'cascade' }),
        messageId: text('message_id').references(() => chatMessages.id, {
            onDelete: 'set null'
        }),
        sourceKind: text('source_kind', {
            enum: ['live_stream', 'local_session_recovery']
        }).notNull(),
        framework: text('framework').notNull(),
        runtime: text('runtime').notNull(),
        sourceRef: text('source_ref'),
        sourceFile: text('source_file'),
        sourceSeq: integer('source_seq').notNull(),
        // Transport sequence of the runner event that carried this raw line
        // (daemon/runner `event.seq`). Durable because the row is: the highest
        // value present for a message is how far a resume may skip ahead.
        runnerSeq: integer('runner_seq'),
        sourceEventKey: text('source_event_key').notNull(),
        externalId: text('external_id'),
        parentExternalId: text('parent_external_id'),
        rawFormat: text('raw_format', {
            enum: ['jsonl', 'json', 'sqlite_row']
        }).notNull(),
        rawText: text('raw_text'),
        rawJson: jsonb('raw_json'),
        rawSha256: text('raw_sha256').notNull(),
        rawBytes: integer('raw_bytes').notNull(),
        parserName: text('parser_name').notNull(),
        parserVersion: text('parser_version').notNull(),
        parsedAt: timestamp('parsed_at', { withTimezone: true }).notNull(),
        rawClearedAt: timestamp('raw_cleared_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        sourceEventKeyUnique: uniqueIndex(
            'chat_message_sources_event_key_unique'
        ).on(table.sourceEventKey),
        sessionIdx: index('chat_message_sources_session_idx').on(
            table.sessionId
        ),
        messageIdx: index('chat_message_sources_message_idx').on(
            table.messageId
        ),
        rawClearedIdx: index('chat_message_sources_raw_cleared_idx').on(
            table.rawClearedAt
        ),
        // The age-based raw-clear sweep's whole access path. Leading on
        // created_at so the scan is a range that STOPS at the cutoff: once
        // the backlog drains, the daily run finds the range empty instead of
        // walking every uncleared row to prove there is nothing left. Partial
        // on raw_cleared_at is null so a cleared row leaves the index for
        // good, which is what keeps the sweep's cost off the table's history
        // rather than proportional to it. id is the tiebreak the keyset
        // cursor pages on.
        rawPendingIdx: index('chat_message_sources_raw_pending_idx')
            .on(table.createdAt, table.id)
            .where(sql`${table.rawClearedAt} is null`)
    })
)

export type ChatMessageSource = typeof chatMessageSources.$inferSelect
export type NewChatMessageSource = typeof chatMessageSources.$inferInsert
