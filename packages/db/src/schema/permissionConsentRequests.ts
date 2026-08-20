import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { users } from './users'

// One row per `mf request-permission` consent URL. The URL carries only an
// encrypted {id, v} reference; this row is authoritative for the agent,
// requested scopes, expiry, and decision. Approve/deny claim it with a
// conditional UPDATE, so a second click — or a card re-rendered from chat
// history hours later — reads the terminal state instead of re-offering the
// buttons. Rows outlive the token on purpose: they record what the owner chose.
export const permissionConsentRequests = pgTable(
    'permission_consent_requests',
    {
        id: text('id').primaryKey(),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        requestedScopes: jsonb('requested_scopes').$type<string[]>().notNull(),
        status: text('status', { enum: ['pending', 'approved', 'denied'] })
            .notNull()
            .default('pending'),
        approvedScopes: jsonb('approved_scopes').$type<string[]>(),
        resolvedBy: text('resolved_by').references(() => users.id, {
            onDelete: 'set null'
        }),
        resolvedAt: timestamp('resolved_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        agentCreatedIdx: index(
            'permission_consent_requests_agent_created_idx'
        ).on(table.agentId, table.createdAt)
    })
)

export type PermissionConsentRequest =
    typeof permissionConsentRequests.$inferSelect
export type NewPermissionConsentRequest =
    typeof permissionConsentRequests.$inferInsert
