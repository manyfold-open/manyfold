import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users'
import { agents } from './agents'
import { channels } from './channels'
import { chatSessions } from './chatSessions'
import { chatMessages } from './chatMessages'

export interface AutomationOrigin {
    kind: 'narranexus'
    runtimeId: string
    jobId: string
    contentHash?: string
}

export const automations = pgTable(
    'automations',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        title: text('title').notNull(),
        prompt: text('prompt').notNull(),
        status: text('status', { enum: ['active', 'paused'] })
            .notNull()
            .default('active'),
        schedulePreset: text('schedule_preset', {
            enum: ['hourly', 'daily', 'weekdays', 'weekly', 'custom']
        }).notNull(),
        rrule: text('rrule').notNull(),
        timezone: text('timezone').notNull(),
        dtstart: timestamp('dtstart', { withTimezone: true }).notNull(),
        model: text('model'),
        // Optional result delivery: send each run's outcome through this
        // bound channel to an explicit target ({kind: 'chat'|'user', id}) or
        // an existing conversation scope ({kind: 'scope', scopeKey}).
        // Both set or both null; the channel FK nulls out on channel delete
        // and the service treats a half-configured pair as delivery-off.
        deliveryChannelId: text('delivery_channel_id').references(
            () => channels.id,
            { onDelete: 'set null' }
        ),
        deliveryTarget: jsonb('delivery_target'),
        // Present when this row mirrors an external framework object (a
        // NarraNexus job) and is owned by the sync reconciler: user-facing
        // edits are rejected and plan quotas do not apply.
        origin: jsonb('origin').$type<AutomationOrigin>(),
        nextRunAt: timestamp('next_run_at', { withTimezone: true }),
        lastRunAt: timestamp('last_run_at', { withTimezone: true }),
        // Tombstone: deletion is two-phase. A non-null value removes the row
        // from every product surface immediately; the retention sweep hard-
        // deletes it (cascading automation_runs) once it passes the
        // configured window. User/agent hard-deletes still cascade instantly
        // through the FKs above — that is the deliberate privacy exception.
        deletedAt: timestamp('deleted_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userUpdatedIdx: index('automations_user_updated_idx').on(
            table.userId,
            table.updatedAt
        ),
        agentIdx: index('automations_agent_idx').on(table.agentId),
        dueIdx: index('automations_due_idx').on(table.status, table.nextRunAt),
        deletedAtIdx: index('automations_deleted_at_idx').on(table.deletedAt)
    })
)

export const automationRuns = pgTable(
    'automation_runs',
    {
        id: text('id').primaryKey(),
        automationId: text('automation_id')
            .notNull()
            .references(() => automations.id, { onDelete: 'cascade' }),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        trigger: text('trigger', { enum: ['manual', 'scheduled'] }).notNull(),
        status: text('status', {
            enum: ['running', 'succeeded', 'failed']
        }).notNull(),
        chatSessionId: text('chat_session_id').references(
            () => chatSessions.id,
            { onDelete: 'set null' }
        ),
        assistantMessageId: text('assistant_message_id').references(
            () => chatMessages.id,
            { onDelete: 'set null' }
        ),
        errorMessage: text('error_message'),
        // Outcome of the run's channel delivery: null = no delivery
        // configured, 'suppressed' = the agent answered [SILENT].
        deliveryStatus: text('delivery_status'),
        // First line of the answer, snapshotted when the run finished so list
        // surfaces never re-read the transcript. Null for failed/running runs.
        resultPreview: text('result_preview'),
        titleSnapshot: text('title_snapshot').notNull(),
        promptSnapshot: text('prompt_snapshot').notNull(),
        rruleSnapshot: text('rrule_snapshot').notNull(),
        modelSnapshot: text('model_snapshot'),
        startedAt: timestamp('started_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        finishedAt: timestamp('finished_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        automationStartedIdx: index(
            'automation_runs_automation_started_idx'
        ).on(table.automationId, table.startedAt),
        statusIdx: index('automation_runs_status_idx').on(table.status),
        messageIdx: index('automation_runs_message_idx').on(
            table.assistantMessageId
        )
    })
)

export type AutomationRow = typeof automations.$inferSelect
export type NewAutomationRow = typeof automations.$inferInsert
export type AutomationRunRow = typeof automationRuns.$inferSelect
export type NewAutomationRunRow = typeof automationRuns.$inferInsert
