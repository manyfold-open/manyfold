import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Single-leader election for background loops that must run on exactly one
// API instance (e.g. the sprite-status sync). Keyed by loop name; the same
// TTL-takeover semantics as channel_leases, without a parent row.
export const serviceLeases = pgTable('service_leases', {
    name: text('name').primaryKey(),
    holderId: text('holder_id').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type ServiceLeaseRow = typeof serviceLeases.$inferSelect
export type NewServiceLeaseRow = typeof serviceLeases.$inferInsert
