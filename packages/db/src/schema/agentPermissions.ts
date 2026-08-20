import { sql } from 'drizzle-orm'
import {
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { users } from './users'

// What an agent may do — one row per agent, the scope list mutated in place
// via UPSERT (grant appends, revoke removes). Looked up per request; api.full
// and chat.completions are never stored here (those are external-token only).
export const agentPermissions = pgTable(
    'agent_permissions',
    {
        id: text('id').primaryKey(),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        scopes: jsonb('scopes')
            .$type<string[]>()
            .notNull()
            .default(sql`'[]'::jsonb`),
        grantedBy: text('granted_by'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        agentUnique: uniqueIndex('agent_permissions_agent_id_uq').on(
            table.agentId
        )
    })
)

export type AgentPermission = typeof agentPermissions.$inferSelect
export type NewAgentPermission = typeof agentPermissions.$inferInsert
