import { sql } from 'drizzle-orm'
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
import { channels } from './channels'
import { chatSessions } from './chatSessions'
import { chatMessages } from './chatMessages'

export const channelDeliveries = pgTable(
    'channel_deliveries',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        channelId: text('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        chatSessionId: text('chat_session_id').references(
            () => chatSessions.id,
            { onDelete: 'set null' }
        ),
        chatMessageId: text('chat_message_id').references(
            () => chatMessages.id,
            { onDelete: 'set null' }
        ),
        direction: text('direction', {
            enum: ['inbound', 'outbound', 'system']
        }).notNull(),
        scopeKey: text('scope_key').notNull(),
        providerEventId: text('provider_event_id'),
        providerMessageId: text('provider_message_id'),
        eventJson: jsonb('event_json'),
        summaryText: text('summary_text'),
        status: text('status', {
            enum: [
                'pending',
                'queued',
                'processing',
                'accepted',
                'sent',
                'dropped',
                'failed',
                'dead'
            ]
        }).notNull(),
        errorMessage: text('error_message'),
        attemptCount: integer('attempt_count').notNull().default(0),
        nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
        // Stamped right before a provider send attempt and cleared once the
        // attempt's outcome is known (sent, or a caught provider error). A row
        // still carrying it was interrupted mid-send: the platform may or may
        // not have received the message, so a blind retry can duplicate.
        sendAttemptStartedAt: timestamp('send_attempt_started_at', {
            withTimezone: true
        }),
        // Assistant message id planned for an inbound event's turn, written
        // before the turn is created. Deliberately no FK: it records intent,
        // and the message row never exists when the crash landed before turn
        // creation.
        turnMessageId: text('turn_message_id'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        channelCreatedIdx: index('channel_deliveries_channel_created_idx').on(
            table.channelId,
            table.createdAt
        ),
        sessionIdx: index('channel_deliveries_session_idx').on(
            table.chatSessionId
        ),
        statusIdx: index('channel_deliveries_status_idx').on(table.status),
        recoveryIdx: index('channel_deliveries_recovery_idx')
            .on(table.direction, table.status, table.nextAttemptAt)
            .where(sql`${table.status} in ('queued', 'failed', 'processing')`),
        inboundEventUnique: uniqueIndex(
            'channel_deliveries_inbound_event_unique'
        )
            .on(table.channelId, table.providerEventId)
            .where(
                sql`${table.direction} = 'inbound' and ${table.providerEventId} is not null`
            )
    })
)

export type ChannelDeliveryRow = typeof channelDeliveries.$inferSelect
export type NewChannelDeliveryRow = typeof channelDeliveries.$inferInsert
