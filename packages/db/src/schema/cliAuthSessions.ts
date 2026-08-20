import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { apiTokens } from './apiTokens'
import { users } from './users'

export const cliAuthSessions = pgTable(
    'cli_auth_sessions',
    {
        id: text('id').primaryKey(),
        userCode: text('user_code').notNull().unique(),
        redirectUri: text('redirect_uri'),
        userId: text('user_id').references(() => users.id, {
            onDelete: 'cascade'
        }),
        authCodeHash: text('auth_code_hash').unique(),
        status: text('status', {
            enum: ['pending', 'approved', 'exchanged', 'expired']
        })
            .notNull()
            .default('pending'),
        tokenId: text('token_id').references(() => apiTokens.id, {
            onDelete: 'set null'
        }),
        requestedScopes: jsonb('requested_scopes').$type<string[]>(),
        approvedScopes: jsonb('approved_scopes').$type<string[]>(),
        requestedAgentId: text('requested_agent_id').references(
            () => agents.id,
            { onDelete: 'cascade' }
        ),
        deviceCodeHash: text('device_code_hash').unique(),
        polledAt: timestamp('polled_at', { withTimezone: true }),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        approvedAt: timestamp('approved_at', { withTimezone: true }),
        exchangedAt: timestamp('exchanged_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        statusExpiresIdx: index('cli_auth_sessions_status_expires_idx').on(
            table.status,
            table.expiresAt
        )
    })
)

export type CliAuthSession = typeof cliAuthSessions.$inferSelect
export type NewCliAuthSession = typeof cliAuthSessions.$inferInsert
