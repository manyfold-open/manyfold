import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const auditLogs = pgTable('audit_logs', {
    id: text('id').primaryKey(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    subject: text('subject'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert
