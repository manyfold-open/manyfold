import {
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp
} from 'drizzle-orm/pg-core'
import { users } from './users'

// Device-code sessions for the A2A Connect flow (third-party apps acquiring
// External client tokens). Deliberately NOT a `kind` on cli_auth_sessions:
// a separate table makes cross-flow device-code redemption structurally
// impossible — /auth/cli/poll never reads this table.
export const a2aConnectSessions = pgTable(
    'a2a_connect_sessions',
    {
        id: text('id').primaryKey(),
        userCode: text('user_code').notNull().unique(),
        deviceCodeHash: text('device_code_hash').notNull().unique(),
        clientName: text('client_name').notNull(),
        clientUrl: text('client_url'),
        userId: text('user_id').references(() => users.id, {
            onDelete: 'cascade'
        }),
        status: text('status', {
            enum: ['pending', 'approved', 'exchanged', 'expired', 'denied']
        })
            .notNull()
            .default('pending'),
        approvedAgentIds: jsonb('approved_agent_ids').$type<string[]>(),
        expiresInDays: integer('expires_in_days'),
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
        statusExpiresIdx: index('a2a_connect_sessions_status_expires_idx').on(
            table.status,
            table.expiresAt
        )
    })
)

export type A2aConnectSession = typeof a2aConnectSessions.$inferSelect
export type NewA2aConnectSession = typeof a2aConnectSessions.$inferInsert
