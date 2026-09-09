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
        // minted. Every value other than 'user' is what makes a register
        // quota-exempt and its host platform-managed; the user-facing mint
        // (POST /api/daemon/tokens) can never ask for one, and the register's
        // own name/body are the client's word. Defaults to 'user' so every
        // token that already exists keeps paying quota.
        //
        // 'sprite_runner' is the daemon the platform installs into a sandbox
        // VM. 'pod_runner' is the daemon that ships inside a k8s agent image;
        // it is a separate value rather than a reuse because the two differ in
        // who owns bring-up (we exec a sprite; a pod's entrypoint owns itself),
        // so a token minted for one must never satisfy the other's lookup.
        purpose: text('purpose', {
            enum: ['user', 'sprite_runner', 'pod_runner']
        })
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

export type DaemonTokenPurpose = DaemonToken['purpose']

// The single place that says which purposes mean "the platform created and owns
// this host". Registration reads it to set runtime_hosts.managed, which in turn
// exempts the host from quota and hides it from the user's machine list — so a
// new purpose that forgets to land here silently becomes a user-visible,
// quota-paying host instead.
export const MANAGED_DAEMON_TOKEN_PURPOSES = [
    'sprite_runner',
    'pod_runner'
] as const satisfies readonly DaemonTokenPurpose[]

export const isManagedDaemonTokenPurpose = (
    purpose: DaemonTokenPurpose
): boolean =>
    (MANAGED_DAEMON_TOKEN_PURPOSES as readonly string[]).includes(purpose)
