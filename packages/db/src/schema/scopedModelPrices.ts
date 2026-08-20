import { sql } from 'drizzle-orm'
import {
    index,
    numeric,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { userModelProviders } from './userModelProviders'

// Per-scope model prices layered in front of the global managed catalog
// overrides: a built_in_id row is an admin's platform-wide default for one
// built-in provider, a provider_id row is a user's price for their own BYO row.
// Exactly one of the two scope columns is set (service-enforced; two real
// columns rather than a polymorphic scope_id so the provider scope gets a real
// FK and deleting a provider deletes its prices).
//
// A row with every price null and no pin is a "manual add": it makes the model
// id visible in the admin list before any user has probed it, without pricing
// it. The pricing engine's load filters those rows out.
//
// These prices feed agent_usage_events.cost_usd, which is REPORTING ONLY today
// (usage aggregates, per-provider display, channel HUD). If cost_usd ever
// becomes a billing input, user-editable provider-scope rows must be
// revisited first.
export const scopedModelPrices = pgTable(
    'scoped_model_prices',
    {
        id: text('id').primaryKey(),
        builtInId: text('built_in_id'),
        providerId: text('provider_id').references(
            () => userModelProviders.id,
            { onDelete: 'cascade' }
        ),
        modelId: text('model_id').notNull(),
        inputCostPerToken: numeric('input_cost_per_token', {
            precision: 20,
            scale: 12
        }),
        outputCostPerToken: numeric('output_cost_per_token', {
            precision: 20,
            scale: 12
        }),
        cacheReadCostPerToken: numeric('cache_read_cost_per_token', {
            precision: 20,
            scale: 12
        }),
        cacheCreationCostPerToken: numeric('cache_creation_cost_per_token', {
            precision: 20,
            scale: 12
        }),
        priceRefSource: text('price_ref_source', {
            enum: ['litellm', 'models_dev', 'netmind']
        }),
        priceRefKey: text('price_ref_key'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        builtInModelUnique: uniqueIndex(
            'scoped_model_prices_built_in_model_unique'
        )
            .on(table.builtInId, table.modelId)
            .where(sql`${table.builtInId} is not null`),
        providerModelUnique: uniqueIndex(
            'scoped_model_prices_provider_model_unique'
        )
            .on(table.providerId, table.modelId)
            .where(sql`${table.providerId} is not null`),
        providerIdx: index('scoped_model_prices_provider_idx').on(
            table.providerId
        )
    })
)

export type ScopedModelPriceRow = typeof scopedModelPrices.$inferSelect
export type NewScopedModelPriceRow = typeof scopedModelPrices.$inferInsert
