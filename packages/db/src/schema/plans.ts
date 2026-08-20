import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const plans = pgTable('plans', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    maxAgentsProvisioned: integer('max_agents_provisioned').notNull(),
    maxConcurrentActive: integer('max_concurrent_active').notNull(),
    maxStorageGb: integer('max_storage_gb').notNull(),
    monthlyActiveHoursIncluded: integer('monthly_active_hours_included'),
    maxAlwaysOnlineRuntimes: integer('max_always_online_runtimes')
        .notNull()
        .default(0),
    maxAlwaysOnlineAgents: integer('max_always_online_agents')
        .notNull()
        .default(0),
    maxChannels: integer('max_channels').notNull().default(0),
    maxAutomations: integer('max_automations').notNull().default(0),
    maxAutomationRunsMonthly: integer('max_automation_runs_monthly'),
    messageHistoryRetentionDays: integer('message_history_retention_days'),
    monthlyApiRequestLimit: integer('monthly_api_request_limit'),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type PlanRow = typeof plans.$inferSelect
export type NewPlanRow = typeof plans.$inferInsert
