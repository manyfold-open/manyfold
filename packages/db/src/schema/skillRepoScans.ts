import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export interface SkillRepoSnapshotEntry {
    sourcePath: string
    name: string
    description: string | null
    version: string | null
}

// One canonical GitHub repository/ref owns the bounded successful snapshot.
// Stable catalog aliases keep their IDs and independently publish that result.
export const skillRepoScans = pgTable('skill_repo_scans', {
    key: text('key').primaryKey(),
    revision: text('revision'),
    snapshot: jsonb('snapshot').$type<SkillRepoSnapshotEntry[]>(),
    publishedAliases: jsonb('published_aliases')
        .$type<Array<{ owner: string; name: string }>>()
        .notNull()
        .default([]),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    holderId: text('holder_id'),
    generation: integer('generation').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type SkillRepoScanRow = typeof skillRepoScans.$inferSelect
