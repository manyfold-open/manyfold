import type { Database } from '@manyfold/db'
import {
    resolveUsagePeriod,
    type UsagePeriod
} from '@/common/usage-period/usage-period'

export const USAGE_PERIOD_PORT = Symbol('USAGE_PERIOD_PORT')

// Resolves the current metering window for every usage meter (sandbox active
// seconds, api requests, automation runs, model spend). Callers pass their own
// db/tx handle — reserveAutomationRun resolves inside its transaction while
// the other meters read through the root connection, and the port must not
// collapse that difference.
export interface UsagePeriodPort {
    resolve(db: Database, userId: string, now?: Date): Promise<UsagePeriod>
    resolveMany(
        db: Database,
        userIds: string[],
        now?: Date
    ): Promise<Map<string, UsagePeriod>>
}

// The open-source binding, and the fallback when the port is absent in a
// hand-constructed test: nobody has a subscription, so every window is the
// no-subscription branch of the pure period math (UTC calendar month) — the
// same window a free user resolves on cloud, no invented semantics.
export const calendarUsagePeriodPort: UsagePeriodPort = {
    resolve: async (_db, _userId, now = new Date()) =>
        resolveUsagePeriod(null, now),
    resolveMany: async (_db, userIds, now = new Date()) => {
        const map = new Map<string, UsagePeriod>()
        for (const id of userIds) map.set(id, resolveUsagePeriod(null, now))
        return map
    }
}
