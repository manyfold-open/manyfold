import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Durable cache of the public pricing tables the metering engine matches against,
// one row per source. This replaces a snapshot file checked into the API bundle:
// a file goes stale on its own schedule and can only be corrected by a deploy,
// while a row is refreshed in place and survives restarts on every machine.
//
// `prices` holds the SAME normalized per-token shape for both sources, so the
// matcher, the pin lookup and the admin candidate list all read one map type.
// models.dev publishes per-MILLION-token costs and is divided down on the way in.
export const modelPriceSnapshots = pgTable('model_price_snapshots', {
    source: text('source', {
        enum: ['litellm', 'models_dev', 'netmind']
    }).primaryKey(),
    // Sent back as If-None-Match so the daily refresh is usually a 304 instead of
    // re-downloading a few MB per machine.
    etag: text('etag'),
    entryCount: integer('entry_count').notNull(),
    prices: jsonb('prices')
        .$type<Record<string, ModelPriceSnapshotEntry>>()
        .notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

// Mirrors LiteLlmModelPricing in the API. Kept structural rather than imported so
// packages/db stays free of app-layer imports.
export interface ModelPriceSnapshotEntry {
    input_cost_per_token?: number
    output_cost_per_token?: number
    cache_creation_input_token_cost?: number
    cache_read_input_token_cost?: number
}

export type ModelPriceSnapshotSource = 'litellm' | 'models_dev' | 'netmind'

export type ModelPriceSnapshotRow = typeof modelPriceSnapshots.$inferSelect
export type NewModelPriceSnapshotRow = typeof modelPriceSnapshots.$inferInsert
