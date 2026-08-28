import {
    check,
    index,
    integer,
    pgTable,
    primaryKey,
    text,
    timestamp
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'

// Per-(sandbox host, UTC day) accrued `running` seconds — the durable ledger
// behind sandbox active-duration metering. Day granularity so any billing
// period window (subscription-anchored, mid-month) can be summed at query
// time. host_id is a bare text column (NOT an FK): the host row can be
// reaped/deleted while this ledger must survive so the per-user rollup stays
// correct. user_id is denormalized (FK cascade) so the rollup keeps working
// after the host is gone; day is 'YYYY-MM-DD' (UTC) — fixed width, so
// lexicographic order == chronological (the migration also CHECKs the shape).
// Replaces month-bucketed sandbox_active_durations (dropped in a follow-up).
export const sandboxActiveDurationDays = pgTable(
    'sandbox_active_duration_days',
    {
        hostId: text('host_id').notNull(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        day: text('day').notNull(),
        activeSeconds: integer('active_seconds').notNull().default(0),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        pk: primaryKey({ columns: [table.hostId, table.day] }),
        // Historical hand-written CHECK, kept under its legacy name: deployed
        // databases hold it under that name; renaming buys nothing but
        // schema/DB drift.
        dayShape: check(
            'sandbox_active_duration_days_day_shape',
            sql`${table.day} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
        ),
        userDayIdx: index('sandbox_active_duration_days_user_day_idx').on(
            table.userId,
            table.day
        )
    })
)

export type SandboxActiveDurationDayRow =
    typeof sandboxActiveDurationDays.$inferSelect
export type NewSandboxActiveDurationDayRow =
    typeof sandboxActiveDurationDays.$inferInsert
