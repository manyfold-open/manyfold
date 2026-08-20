import { sql } from 'drizzle-orm'
import {
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { users } from './users'
import { tokenCredentials } from './tokenCredentials'

// Agent identity, not authorization: an agent runtime holds this to prove
// "I am agent X". Carries no scopes — what X may do lives in agent_permissions.
// Grain is per (agent, runtime_kind) so a sprite and a k8s pod for the same
// agent each hold their own identity and rotate independently.
export const agentRuntimeTokens = pgTable(
    'agent_runtime_tokens',
    {
        id: text('id').primaryKey(),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        runtimeKind: text('runtime_kind', {
            enum: ['sprites', 'k8s', 'daemon', 'external']
        }).notNull(),
        tokenHash: text('token_hash')
            .notNull()
            .unique()
            .references(() => tokenCredentials.tokenHash, {
                onDelete: 'cascade'
            }),
        name: text('name').notNull(),
        // Encrypted copy of the token plaintext (AES via CryptoService) so the
        // API can inject the per-agent identity at exec time — required for
        // co-resident sandbox VMs where one shared shell profile can't hold
        // every agent's token. Null for legacy tokens minted before this column:
        // those still rely on the plaintext written to their sprite profile.
        tokenCiphertext: text('token_ciphertext'),
        tokenKeyVersion: integer('token_key_version'),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        agentIdx: index('agent_runtime_tokens_agent_id_idx').on(table.agentId),
        agentKindActiveUnique: uniqueIndex(
            'agent_runtime_tokens_agent_kind_active_uq'
        )
            .on(table.agentId, table.runtimeKind)
            .where(sql`${table.revokedAt} is null`)
    })
)

export type AgentRuntimeToken = typeof agentRuntimeTokens.$inferSelect
export type NewAgentRuntimeToken = typeof agentRuntimeTokens.$inferInsert
