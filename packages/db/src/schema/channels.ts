import { sql } from 'drizzle-orm'
import {
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agents } from './agents'

export interface ChannelOrigin {
    kind: 'narranexus'
    runtimeId: string
    nxAgentId: string
    contentHash?: string
}

export const channels = pgTable(
    'channels',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        provider: text('provider', {
            enum: [
                'fake',
                'lark',
                'telegram',
                'slack',
                'discord',
                'matrix',
                'weixin',
                'linear',
                'github'
            ]
        }).notNull(),
        label: text('label').notNull(),
        status: text('status', {
            enum: ['draft', 'active', 'paused', 'error']
        })
            .notNull()
            .default('draft'),
        configJson: jsonb('config_json').notNull(),
        credentialsCiphertext: text('credentials_ciphertext'),
        keyVersion: integer('key_version').notNull().default(1),
        // Non-secret provider-side identity used to enforce one-binding-per
        // external-account (e.g. the iLink bot id for WeChat). NULL for
        // providers that do not scope by external identity.
        externalId: text('external_id'),
        // Present when this row mirrors an external framework binding (a
        // NarraNexus channel credential) and is owned by the sync reconciler:
        // user-facing edits are rejected and plan quotas do not apply.
        origin: jsonb('origin').$type<ChannelOrigin>(),
        lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
        lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
        lastErrorMessage: text('last_error_message'),
        reconnectAttempts: integer('reconnect_attempts').notNull().default(0),
        nextReconnectAt: timestamp('next_reconnect_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userUpdatedIdx: index('channels_user_updated_idx').on(
            table.userId,
            table.updatedAt
        ),
        agentIdx: index('channels_agent_idx').on(table.agentId),
        statusIdx: index('channels_status_idx').on(table.status),
        // One channel per (provider, external identity). Partial so the many
        // providers that leave external_id NULL are never constrained.
        providerExternalIdx: uniqueIndex('channels_provider_external_idx')
            .on(table.provider, table.externalId)
            .where(sql`${table.externalId} is not null`)
    })
)

export type ChannelRow = typeof channels.$inferSelect
export type NewChannelRow = typeof channels.$inferInsert
