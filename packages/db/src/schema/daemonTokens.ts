import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'
import { runtimeHosts } from './runtimeHosts'

export const daemonTokens = pgTable(
    'daemon_tokens',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        daemonId: text('daemon_id').references(() => runtimeHosts.id, {
            onDelete: 'cascade'
        }),
        name: text('name').notNull(),
        // Server-controlled admission claim, set only where the token is
        // minted. 'sprite_runner' is what makes a register quota-exempt and
        // its host platform-managed; the user-facing mint
        // (POST /api/daemon/tokens) can never ask for it, and the register's
        // own name/body are the client's word. Defaults to 'user' so every
        // token that already exists keeps paying quota.
        purpose: text('purpose', { enum: ['user', 'sprite_runner'] })
            .notNull()
            .default('user'),
        tokenHash: text('token_hash').notNull().unique(),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        // Admin daemon host listing counts tokens per daemon (#607).
        daemonIdx: index('daemon_tokens_daemon_id_idx').on(table.daemonId),
        // GET /api/daemon/tokens lists a user's tokens by user_id (#607).
        userIdx: index('daemon_tokens_user_id_idx').on(table.userId)
    })
)

export type DaemonToken = typeof daemonTokens.$inferSelect
export type NewDaemonToken = typeof daemonTokens.$inferInsert
