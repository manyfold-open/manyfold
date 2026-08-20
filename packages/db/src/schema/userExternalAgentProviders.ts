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

export const userExternalAgentProviders = pgTable(
    'user_external_agent_providers',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        provider: text('provider', {
            enum: ['dify', 'langflow', 'a2a']
        }).notNull(),
        label: text('label').notNull(),
        endpointUrl: text('endpoint_url').notNull(),
        apiKeyCiphertext: text('api_key_ciphertext').notNull(),
        keyVersion: integer('key_version').notNull().default(1),
        metadataJson: jsonb('metadata_json')
            .$type<Record<string, unknown>>()
            .notNull()
            .default({}),
        lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
        lastTestStatus: text('last_test_status', {
            enum: ['ok', 'error']
        }),
        lastTestMessage: text('last_test_message'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userIdx: index('user_external_agent_providers_user_idx').on(
            table.userId
        ),
        userProviderLabelUnique: uniqueIndex(
            'user_external_agent_providers_user_provider_label_unique'
        ).on(table.userId, table.provider, table.label)
    })
)

export type UserExternalAgentProviderRow =
    typeof userExternalAgentProviders.$inferSelect
export type NewUserExternalAgentProviderRow =
    typeof userExternalAgentProviders.$inferInsert
