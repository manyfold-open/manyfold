import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

// Account-deletion state machine rows (Phase-4 P4-5, ADR-0023). userId is a
// BARE text column on purpose — the auditLogs.actorId pattern: this record
// must survive the hard delete it describes, so it can never carry a users
// FK. No email or other PII is snapshotted; the opaque id is the only
// reference left behind.
export const userDeletions = pgTable('user_deletions', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    status: text('status', {
        enum: ['pending', 'restored', 'executed']
    })
        .notNull()
        .default('pending'),
    requestedBy: text('requested_by').notNull(),
    reason: text('reason'),
    requestedAt: timestamp('requested_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    // Sweep claim marker: claim-by-update replaces row locks so the slow
    // external teardown never holds a transaction; a stale claim (crashed
    // instance) is re-claimable after the staleness window.
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    restoredAt: timestamp('restored_at', { withTimezone: true }),
    lastError: jsonb('last_error').$type<{
        step: string
        message: string
        at: string
    } | null>()
})

export type UserDeletionRow = typeof userDeletions.$inferSelect
