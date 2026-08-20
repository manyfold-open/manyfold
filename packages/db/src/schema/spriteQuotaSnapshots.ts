import { bigint, integer, pgTable, timestamp } from 'drizzle-orm/pg-core'

export const spriteQuotaSnapshots = pgTable('sprite_quota_snapshots', {
    at: timestamp('at', { withTimezone: true }).primaryKey(),
    orgActive: integer('org_active').notNull(),
    orgWarm: integer('org_warm').notNull(),
    orgCold: integer('org_cold').notNull(),
    orgProvisioned: integer('org_provisioned').notNull(),
    orgStorageBytes: bigint('org_storage_bytes', { mode: 'number' })
        .notNull()
        .default(0)
})

export type SpriteQuotaSnapshot = typeof spriteQuotaSnapshots.$inferSelect
export type NewSpriteQuotaSnapshot = typeof spriteQuotaSnapshots.$inferInsert
