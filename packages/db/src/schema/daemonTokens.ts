import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'
import { runtimeHosts } from './runtimeHosts'

// A daemon registration credential. Binding to a host is the whole trust
// boundary (ADR-0036): a token the user minted has no host until its first
// register creates a `local` one; a token the platform minted for a hosted
// host is bound at mint, can only register onto that host and can never create
// one. Bound tokens never change host.
export const daemonTokens = pgTable(
    'daemon_tokens',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        hostId: text('host_id').references(() => runtimeHosts.id, {
            onDelete: 'cascade'
        }),
        name: text('name').notNull(),
        tokenHash: text('token_hash').notNull().unique(),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        hostIdx: index('daemon_tokens_host_id_idx').on(table.hostId),
        userIdx: index('daemon_tokens_user_id_idx').on(table.userId)
    })
)

export type DaemonToken = typeof daemonTokens.$inferSelect
export type NewDaemonToken = typeof daemonTokens.$inferInsert
