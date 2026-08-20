import {
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    Logger,
    Optional
} from '@nestjs/common'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { plans, userApiUsageDays, users, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    periodDayWindow,
    utcDayBucket,
    type UsagePeriod
} from '@/common/usage-period/usage-period'
import {
    USAGE_PERIOD_PORT,
    calendarUsagePeriodPort,
    type UsagePeriodPort
} from '@/common/ports/usage-period.ports'

interface CachedLimit {
    limit: number | null
    planName: string
    cachedAt: number
}

interface CachedPeriod {
    period: UsagePeriod
    cachedAt: number
}

const PLAN_LIMIT_TTL_MS = 60_000

@Injectable()
export class ApiQuotaService {
    private readonly log = new Logger(ApiQuotaService.name)
    private readonly limitCache = new Map<string, CachedLimit>()
    private readonly periodCache = new Map<string, CachedPeriod>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means calendar-month windows (no subscriptions).
        @Optional()
        @Inject(USAGE_PERIOD_PORT)
        private readonly usagePeriods: UsagePeriodPort = calendarUsagePeriodPort
    ) {}

    // Increment-before-check: rejected requests still count, matching the old
    // month-bucket behavior. The whole metering path (period lookup, day
    // upsert, prior-days sum) fails OPEN on non-HttpException errors — a
    // metering hiccup (migration window, DB blip) must never be the thing that
    // 500s the public API; the request will fail on its own DB access if the
    // database is really down. The 429 rethrows.
    async assertAndIncrement(userId: string): Promise<void> {
        try {
            const limit = await this.planLimitFor(userId)
            const now = new Date()
            const today = utcDayBucket(now)
            const [row] = await this.db
                .insert(userApiUsageDays)
                .values({
                    userId,
                    day: today,
                    requestCount: 1,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: [userApiUsageDays.userId, userApiUsageDays.day],
                    set: {
                        requestCount: sql`${userApiUsageDays.requestCount} + 1`,
                        updatedAt: now
                    }
                })
                .returning({ requestCount: userApiUsageDays.requestCount })
            if (limit.limit === null) return
            // Period total = closed prior days (immutable) + today's
            // post-increment count from the upsert. The upsert serializes on
            // the (user, today) row, so concurrent requests still observe
            // N, N+1, … exactly like the old single-bucket compare — no
            // "both sum the final total and both 429" race.
            const period = await this.periodFor(userId, now)
            const { startDay } = periodDayWindow(period)
            const [prior] = await this.db
                .select({
                    value: sql<number>`coalesce(sum(${userApiUsageDays.requestCount}), 0)::bigint`
                })
                .from(userApiUsageDays)
                .where(
                    and(
                        eq(userApiUsageDays.userId, userId),
                        gte(userApiUsageDays.day, startDay),
                        lt(userApiUsageDays.day, today)
                    )
                )
            const current =
                Number(prior?.value ?? 0) + Number(row?.requestCount ?? 0)
            if (current > limit.limit) {
                throw new HttpException(
                    {
                        message: `API request quota reached (${limit.limit} for ${limit.planName} plan this billing period)`,
                        code: 'API_REQUEST_QUOTA_REACHED',
                        current,
                        limit: limit.limit,
                        planName: limit.planName
                    },
                    HttpStatus.TOO_MANY_REQUESTS
                )
            }
        } catch (err) {
            if (err instanceof HttpException) throw err
            this.log.error(
                `api quota metering failed open for user=${userId}: ${(err as Error).message}`
            )
        }
    }

    private async periodFor(userId: string, now: Date): Promise<UsagePeriod> {
        const cached = this.periodCache.get(userId)
        if (cached && now.getTime() - cached.cachedAt < PLAN_LIMIT_TTL_MS)
            return cached.period
        const period = await this.usagePeriods.resolve(this.db, userId, now)
        this.periodCache.set(userId, { period, cachedAt: now.getTime() })
        return period
    }

    private async planLimitFor(
        userId: string
    ): Promise<{ limit: number | null; planName: string }> {
        const now = Date.now()
        const cached = this.limitCache.get(userId)
        if (cached && now - cached.cachedAt < PLAN_LIMIT_TTL_MS)
            return { limit: cached.limit, planName: cached.planName }
        const [row] = await this.db
            .select({
                limit: plans.monthlyApiRequestLimit,
                planName: plans.name
            })
            .from(users)
            .innerJoin(plans, eq(plans.id, users.planId))
            .where(eq(users.id, userId))
            .limit(1)
        const entry: CachedLimit = {
            limit: row?.limit ?? null,
            planName: row?.planName ?? 'unknown',
            cachedAt: now
        }
        this.limitCache.set(userId, entry)
        return { limit: entry.limit, planName: entry.planName }
    }
}
