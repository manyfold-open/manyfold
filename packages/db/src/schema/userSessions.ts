import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'

export const userSessions = pgTable(
    'user_sessions',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        tokenHash: text('token_hash').notNull().unique(),
        provider: text('provider', {
            enum: ['email', 'google', 'oidc', 'netmind']
        }).notNull(),
        subject: text('subject').notNull(),
        userAgent: text('user_agent'),
        ip: text('ip'),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userIdx: index('user_sessions_user_id_idx').on(table.userId),
        activeIdx: index('user_sessions_active_idx').on(
            table.revokedAt,
            table.expiresAt
        )
    })
)

export type UserSession = typeof userSessions.$inferSelect
export type NewUserSession = typeof userSessions.$inferInsert
