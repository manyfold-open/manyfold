import { sql } from 'drizzle-orm'
import {
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { users } from './users'

// A2A Peer Access as a standalone relationship: "caller agent may call target
// agent". Per-call bearers are minted internally (stateless), never stored.
// Intra-user only — caller and target share one owner.
export const a2aAgentGrants = pgTable(
    'a2a_agent_grants',
    {
        id: text('id').primaryKey(),
        callerAgentId: text('caller_agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        targetAgentId: text('target_agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        scopes: jsonb('scopes')
            .$type<string[]>()
            .notNull()
            .default(sql`'["a2a:edit"]'::jsonb`),
        name: text('name'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true })
    },
    (table) => ({
        callerTargetActiveUnique: uniqueIndex(
            'a2a_agent_grants_caller_target_active_uq'
        )
            .on(table.callerAgentId, table.targetAgentId)
            .where(sql`${table.revokedAt} is null`),
        callerTargetIdx: index('a2a_agent_grants_caller_target_idx').on(
            table.callerAgentId,
            table.targetAgentId,
            table.revokedAt
        )
    })
)

export type A2aAgentGrant = typeof a2aAgentGrants.$inferSelect
export type NewA2aAgentGrant = typeof a2aAgentGrants.$inferInsert
