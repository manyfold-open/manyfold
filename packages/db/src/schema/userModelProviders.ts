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

export const userModelProviders = pgTable(
    'user_model_providers',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        inferenceProtocol: text('inference_protocol', {
            enum: [
                'openai_chat_completions',
                'openai_responses',
                'anthropic_messages',
                'google_generate_content',
                'mistral_chat_completions'
            ]
        }),
        builtInId: text('built_in_id'),
        // Set when the row was auto-provisioned from an external account (e.g.
        // NetMind userSystemCode); NULL for manually pasted keys.
        externalAccountId: text('external_account_id'),
        providerName: text('provider_name').notNull(),
        apiKeyCiphertext: text('api_key_ciphertext').notNull(),
        baseUrl: text('base_url'),
        modelsListUrl: text('models_list_url'),
        keyVersion: integer('key_version').notNull().default(1),
        source: text('source', {
            enum: ['byo', 'managed']
        })
            .notNull()
            .default('byo'),
        // Opaque managed-supply tag (editions §3.5): the cloud edition narrows
        // it in its own types; the column is compile-time-only text either way.
        managedService: text('managed_service'),
        managedKeyId: text('managed_key_id'),
        managedBrand: text('managed_brand', {
            enum: [
                'anthropic',
                'openai',
                'google',
                'antigravity',
                'antigravity_claude'
            ]
        }),
        lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
        lastTestStatus: text('last_test_status', {
            enum: ['ok', 'error']
        }),
        lastTestMessage: text('last_test_message'),
        lastTestModels: jsonb('last_test_models').$type<
            Record<string, string[]>
        >(),
        enabledModels: jsonb('enabled_models').$type<Record<
            string,
            string[]
        > | null>(),
        // Persisted (encrypted) NetMind loginToken for a login-connected netmind
        // row, so balance/recharge work server-side without a per-session sign-in
        // popup. Nullable (only netmind login rows have it); NEVER returned to the
        // browser or included in the provider summary. expiresAt is the JWT `exp`,
        // a soft gate to prompt reconnect before hitting the billing API.
        netmindLoginTokenCiphertext: text('netmind_login_token_ciphertext'),
        netmindLoginTokenKeyVersion: integer('netmind_login_token_key_version'),
        netmindLoginTokenExpiresAt: timestamp('netmind_login_token_expires_at', {
            withTimezone: true
        }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userIdx: index('user_model_providers_user_idx').on(table.userId),
        customNameUnique: uniqueIndex(
            'user_model_providers_custom_name_unique'
        )
            .on(table.userId, table.providerName)
            .where(
                sql`${table.builtInId} is null and ${table.source} = 'byo'`
            ),
        byoExternalAccountUnique: uniqueIndex(
            'user_model_providers_byo_external_account_unique'
        )
            .on(table.userId, table.builtInId, table.externalAccountId)
            .where(
                sql`${table.externalAccountId} is not null and ${table.source} = 'byo'`
            ),
        managedBrandUnique: uniqueIndex(
            'user_model_providers_managed_brand_unique'
        )
            .on(table.userId, table.managedService, table.managedBrand)
            .where(sql`${table.source} = 'managed'`),
        managedKeyIdx: index('user_model_providers_managed_key_idx').on(
            table.managedService,
            table.managedKeyId
        )
    })
)

export type UserModelProviderRow = typeof userModelProviders.$inferSelect
export type NewUserModelProviderRow = typeof userModelProviders.$inferInsert
