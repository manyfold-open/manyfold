import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { chatSessions } from './chatSessions'
import { users } from './users'

// The row id (css_…) doubles as the unlisted share URL slug: 74 random bits
// plus rate limiting make enumeration infeasible, and unlike credentials a
// hash buys nothing — the content the id unlocks lives in the same database.
// The cutoff columns freeze the shared transcript at share time: the public
// endpoints only serve messages at or before (cutoffCreatedAt, cutoffMessageId).
export const chatSessionShares = pgTable(
    'chat_session_shares',
    {
        id: text('id').primaryKey(),
        sessionId: text('session_id')
            .notNull()
            .references(() => chatSessions.id, { onDelete: 'cascade' }),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        cutoffMessageId: text('cutoff_message_id').notNull(),
        cutoffCreatedAt: timestamp('cutoff_created_at', {
            withTimezone: true
        }).notNull(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        activeSessionUnique: uniqueIndex('chat_session_shares_active_session_uq')
            .on(table.sessionId)
            .where(sql`${table.revokedAt} is null`)
    })
)

export type ChatSessionShareRow = typeof chatSessionShares.$inferSelect
export type NewChatSessionShareRow = typeof chatSessionShares.$inferInsert
