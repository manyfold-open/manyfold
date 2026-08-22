import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'

// GDPR takeout bundles (ADR-0023 §9.2, V2-B). Unlike user_deletions this row
// carries a real users FK ON DELETE cascade: an export is an artifact OF the
// account and has no reason to outlive it — when the deletion sweep removes
// the user, the export record (and, before that, the retention sweep removes
// the takeout object itself) goes with it.
export const userExports = pgTable('user_exports', {
    id: text('id').primaryKey(),
    userId: text('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    // queued → running → ready | failed; ready → expired once the retention
    // sweep has deleted the stored object. failed is terminal — the user (or
    // admin) re-requests rather than the sweep retrying a poisoned collector
    // forever; a CRASHED run (running + stale claimed_at) is re-claimed.
    status: text('status', {
        enum: ['queued', 'running', 'ready', 'failed', 'expired']
    })
        .notNull()
        .default('queued'),
    // Storage key of the finished bundle. Set when ready, cleared when the
    // retention sweep deletes the object, so "non-null" means "downloadable".
    objectKey: text('object_key'),
    // When the stored bundle is deleted (ready time + retention window). The
    // sweep enforces this itself — a bucket lifecycle rule cannot be assumed
    // on self-hosted storage.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // Sweep claim marker (the user_deletions pattern): claim-by-update
    // instead of row locks so the slow collect/zip/upload work never holds a
    // transaction; a stale claim from a crashed instance is re-claimable.
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastError: jsonb('last_error').$type<{
        step: string
        message: string
        at: string
    } | null>(),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type UserExportRow = typeof userExports.$inferSelect
