import { sql } from 'drizzle-orm'
import {
    boolean,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { users } from './users'
import { tokenCredentials } from './tokenCredentials'

export const apiTokens = pgTable(
    'api_tokens',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id').references(() => agents.id, {
            onDelete: 'cascade'
        }),
        name: text('name').notNull(),
        tokenHash: text('token_hash')
            .notNull()
            .unique()
            .references(() => tokenCredentials.tokenHash, {
                onDelete: 'cascade'
            }),
        scopes: jsonb('scopes').$type<string[]>().notNull(),
        enforceAgentBinding: boolean('enforce_agent_binding')
            .notNull()
            .default(false),
        createdVia: text('created_via', {
            enum: ['cli-poll', 'user-grant', 'cli-browser', 'api']
        }),
        tokenKind: text('token_kind', {
            // 'a2a-ephemeral' is mint-retired (replaced by stateless a2a
            // tickets) but stays in the enum: rows may survive in databases
            // whose deploys predate the switch, and the hourly reaper only
            // deletes them once seen expired.
            enum: ['user-grant', 'a2a-grant', 'a2a-ephemeral', 'terminal']
        })
            .notNull()
            .default('user-grant'),
        callerAgentId: text('caller_agent_id').references(() => agents.id, {
            onDelete: 'cascade'
        }),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        agentIdx: index('api_tokens_agent_id_idx').on(table.agentId),
        callerAgentIdx: index('api_tokens_caller_agent_id_idx').on(
            table.callerAgentId
        ),
        createdViaIdx: index('api_tokens_created_via_idx').on(
            table.createdVia
        ),
        agentActiveUnique: uniqueIndex('api_tokens_agent_id_active_uq')
            .on(table.agentId)
            .where(
                sql`${table.revokedAt} is null and ${table.agentId} is not null and ${table.tokenKind} = 'user-grant'`
            ),
        a2aGrantUnique: uniqueIndex('api_tokens_a2a_grant_uq')
            .on(table.agentId, table.callerAgentId)
            .where(
                sql`${table.tokenKind} = 'a2a-grant' and ${table.revokedAt} is null`
            )
    })
)

export type ApiToken = typeof apiTokens.$inferSelect
export type NewApiToken = typeof apiTokens.$inferInsert
