import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { plans } from './plans'

export type QuotaWarningCode =
    | 'storage'
    | 'provisioned'
    | 'concurrent'
    | 'wholesale_soft'
    | 'active_hours'

export type LastQuotaWarningsAt = Partial<Record<QuotaWarningCode, string>>

export const users = pgTable('users', {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    // Optional display name shown instead of the email. Not a handle: no
    // uniqueness, cleared back to null when the user empties it.
    displayName: text('display_name'),
    role: text('role', { enum: ['user', 'admin'] })
        .notNull()
        .default('user'),
    // Per-user override floor: effective stateful-sandbox limit =
    // max(this, plans.maxAgentsProvisioned). Default 1 = no override (plan wins).
    // Raised by admin runtime-access.
    statefulSandboxLimit: integer('stateful_sandbox_limit')
        .notNull()
        .default(1),
    // Bonus always-online runtime + agent capacity added on top of plan limits.
    // DB column name kept as persistent_runtime_limit for migration continuity.
    alwaysOnlineRuntimeBonus: integer('persistent_runtime_limit')
        .notNull()
        .default(0),
    // Bonus sandbox active hours added on top of plans.monthly_active_hours_included
    // this billing period. Admin relief valve for the active-hours hard block.
    activeHoursBonus: integer('active_hours_bonus').notNull().default(0),
    planId: text('plan_id')
        .notNull()
        .default('free')
        .references(() => plans.id, { onDelete: 'restrict' }),
    lastQuotaWarningsAt: jsonb('last_quota_warnings_at')
        .$type<LastQuotaWarningsAt>()
        .notNull()
        .default({}),
    // Per-user override of framework_runtime_defaults admin setting. Takes
    // priority over the global setting for this user only. Shape:
    // { hermes?: 'sprites'|'k8s', openclaw?: 'sprites'|'k8s' }
    frameworkRuntimeOverrides: jsonb('framework_runtime_overrides')
        .$type<Partial<Record<string, 'sprites' | 'k8s'>>>()
        .notNull()
        .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
