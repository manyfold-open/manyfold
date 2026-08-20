import {
    check,
    integer,
    pgTable,
    primaryKey,
    text,
    timestamp
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'

// Per-(user, UTC day) public-API request counter. Day granularity so the
// enforced quota window can follow the user's billing period instead of the
// calendar month; day is 'YYYY-MM-DD' (UTC). Replaces month-bucketed
// user_monthly_api_usage (dropped in a follow-up).
export const userApiUsageDays = pgTable(
    'user_api_usage_days',
    {
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        day: text('day').notNull(),
        requestCount: integer('request_count').notNull().default(0),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        pk: primaryKey({ columns: [table.userId, table.day] }),
        // Historical hand-written CHECK, kept under its legacy name (see the
        // editions core baseline parity requirement).
        dayShape: check(
            'user_api_usage_days_day_shape',
            sql`${table.day} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
        )
    })
)

export type UserApiUsageDayRow = typeof userApiUsageDays.$inferSelect
export type NewUserApiUsageDayRow = typeof userApiUsageDays.$inferInsert
