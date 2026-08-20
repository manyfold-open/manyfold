import { sql } from 'drizzle-orm'
import {
    boolean,
    index,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { channels } from './channels'
import { chatSessions } from './chatSessions'

export const channelSessions = pgTable(
    'channel_sessions',
    {
        id: text('id').primaryKey(),
        channelId: text('channel_id')
            .notNull()
            .references(() => channels.id, { onDelete: 'cascade' }),
        chatSessionId: text('chat_session_id')
            .notNull()
            .references(() => chatSessions.id, { onDelete: 'cascade' }),
        scopeKey: text('scope_key').notNull(),
        scopeName: text('scope_name'),
        remoteUserId: text('remote_user_id'),
        remoteThreadId: text('remote_thread_id'),
        displayName: text('display_name'),
        isActive: boolean('is_active').notNull().default(true),
        archivedAt: timestamp('archived_at', { withTimezone: true }),
        lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
        lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        channelScopeActiveUnique: uniqueIndex(
            'channel_sessions_active_unique'
        )
            .on(table.channelId, table.scopeKey)
            .where(sql`${table.isActive} = true AND ${table.archivedAt} IS NULL`),
        scopeHistoryIdx: index('channel_sessions_scope_history_idx').on(
            table.channelId,
            table.scopeKey,
            table.createdAt
        ),
        chatSessionIdx: index('channel_sessions_chat_session_idx').on(
            table.chatSessionId
        )
    })
)

export type ChannelSessionRow = typeof channelSessions.$inferSelect
export type NewChannelSessionRow = typeof channelSessions.$inferInsert
