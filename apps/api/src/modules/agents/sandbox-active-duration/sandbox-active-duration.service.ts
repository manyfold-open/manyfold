import { Inject, Injectable, Optional } from '@nestjs/common'
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import {
    runtimeHosts,
    sandboxActiveDurationDays,
    userApiUsageDays,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
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
import { accrualBuckets } from './sandbox-active-duration-math'

// ~3× the slow status-sampling interval (30s). In steady state two consecutive
// samples of a running host are never further apart than the slow cadence, so a
// gap longer than this is a sync blackout (deploy / process restart / account
// backoff). We cap such gaps by advancing the interval start to now - CAP: this
// bounds blackout mis-accrual and biases the meter conservative (rather under-
// than over-count), which is the right default for a customer-visible number.
const ACCRUAL_CAP_MS = 90_000

type HostWatermark = Pick<RuntimeHostRow, 'id' | 'userId' | 'activeAccrualSince'>

@Injectable()
export class SandboxActiveDurationService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means calendar-month windows (no subscriptions).
        @Optional()
        @Inject(USAGE_PERIOD_PORT)
        private readonly usagePeriods: UsagePeriodPort = calendarUsagePeriodPort
    ) {}

    // Observe a sandbox host's running state on a status-sync sample and accrue
    // any open running interval. The watermark is compare-and-swapped so that
    // with several API instances sampling the same host, only the one that wins
    // the advance writes to the ledger — no double-count. Advances the watermark
    // on every running sample (incremental accrual) so the still-open interval
    // is never longer than one sample, bounding loss on an un-settled delete.
    async accrue(
        host: HostWatermark,
        observedRunning: boolean,
        now: Date
    ): Promise<void> {
        const since = host.activeAccrualSince
        if (since) {
            const claimed = await this.db
                .update(runtimeHosts)
                .set({
                    activeAccrualSince: observedRunning ? now : null,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(runtimeHosts.id, host.id),
                        eq(runtimeHosts.activeAccrualSince, since)
                    )
                )
                .returning({ id: runtimeHosts.id })
            if (claimed.length > 0)
                await this.accrueLedger(host.userId, host.id, since, now)
        } else if (observedRunning) {
            await this.db
                .update(runtimeHosts)
                .set({ activeAccrualSince: now, updatedAt: now })
                .where(
                    and(
                        eq(runtimeHosts.id, host.id),
                        isNull(runtimeHosts.activeAccrualSince)
                    )
                )
        }
    }

    // Settle + clear an open watermark before a host's running status is cleared
    // or its row is deleted (teardown / explicit delete / reaper). Reads the
    // watermark fresh and closes it under the same CAS as accrue(), so a racing
    // sampler can't double-count the final interval. Safe to call when there is
    // no open interval (no-op).
    async settleHostNotRunning(
        hostId: string,
        userId: string,
        now: Date
    ): Promise<void> {
        const [row] = await this.db
            .select({ since: runtimeHosts.activeAccrualSince })
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, hostId))
            .limit(1)
        const since = row?.since
        if (!since) return
        const claimed = await this.db
            .update(runtimeHosts)
            .set({ activeAccrualSince: null, updatedAt: now })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.activeAccrualSince, since)
                )
            )
            .returning({ id: runtimeHosts.id })
        if (claimed.length > 0)
            await this.accrueLedger(userId, hostId, since, now)
    }

    private async accrueLedger(
        userId: string,
        hostId: string,
        since: Date,
        now: Date
    ): Promise<void> {
        const buckets = accrualBuckets(
            since.getTime(),
            now.getTime(),
            ACCRUAL_CAP_MS
        )
        for (const bucket of buckets) {
            await this.db
                .insert(sandboxActiveDurationDays)
                .values({
                    hostId,
                    userId,
                    day: bucket.day,
                    activeSeconds: bucket.seconds,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: [
                        sandboxActiveDurationDays.hostId,
                        sandboxActiveDurationDays.day
                    ],
                    set: {
                        activeSeconds: sql`${sandboxActiveDurationDays.activeSeconds} + ${bucket.seconds}`,
                        updatedAt: now
                    }
                })
        }
    }

    async userActiveSecondsInPeriod(
        userId: string,
        period: UsagePeriod
    ): Promise<number> {
        const { startDay, endDay } = periodDayWindow(period)
        const [row] = await this.db
            .select({
                value: sql<number>`coalesce(sum(${sandboxActiveDurationDays.activeSeconds}), 0)::bigint`
            })
            .from(sandboxActiveDurationDays)
            .where(
                and(
                    eq(sandboxActiveDurationDays.userId, userId),
                    gte(sandboxActiveDurationDays.day, startDay),
                    lt(sandboxActiveDurationDays.day, endDay)
                )
            )
        return Number(row?.value ?? 0)
    }

    // Same predicate as userActiveSecondsInPeriod plus GROUP BY host_id, so the
    // map's values sum to that method's result by construction. Deleted hosts
    // are included (host_id is deliberately not an FK; their seconds still
    // count toward the meter) — that is why this is not built on
    // activeSecondsInPeriodByHost, which only sees the hosts it is handed.
    async userActiveSecondsInPeriodByHost(
        userId: string,
        period: UsagePeriod
    ): Promise<Map<string, number>> {
        const { startDay, endDay } = periodDayWindow(period)
        const rows = await this.db
            .select({
                hostId: sandboxActiveDurationDays.hostId,
                value: sql<number>`coalesce(sum(${sandboxActiveDurationDays.activeSeconds}), 0)::bigint`
            })
            .from(sandboxActiveDurationDays)
            .where(
                and(
                    eq(sandboxActiveDurationDays.userId, userId),
                    gte(sandboxActiveDurationDays.day, startDay),
                    lt(sandboxActiveDurationDays.day, endDay)
                )
            )
            .groupBy(sandboxActiveDurationDays.hostId)
        return new Map(rows.map((r) => [r.hostId, Number(r.value ?? 0)]))
    }

    // Drop ledger rows older than `months` whole calendar months, so the tables
    // (which keep rows for reaped hosts) don't grow without bound. day is
    // fixed-width 'YYYY-MM-DD' so a lexicographic `<` is a correct compare.
    async pruneOlderThan(months: number, now = new Date()): Promise<void> {
        const cutoff = utcDayBucket(
            new Date(
                Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1)
            )
        )
        await this.db
            .delete(sandboxActiveDurationDays)
            .where(lt(sandboxActiveDurationDays.day, cutoff))
        await this.db
            .delete(userApiUsageDays)
            .where(lt(userApiUsageDays.day, cutoff))
    }

    // Per-user period totals for a batch (admin quota surfaces). Windows are
    // resolved per user and applied in TS — the anniversary clamp is
    // deliberately not re-implemented in SQL.
    async activeSecondsInPeriodByUser(
        userIds: string[],
        now = new Date()
    ): Promise<Map<string, number>> {
        const map = new Map<string, number>()
        if (userIds.length === 0) return map
        const periods = await this.usagePeriods.resolveMany(
            this.db,
            userIds,
            now
        )
        const windows = new Map(
            [...periods].map(([userId, period]) => [
                userId,
                periodDayWindow(period)
            ])
        )
        const minStartDay = [...windows.values()]
            .map((w) => w.startDay)
            .sort()[0]
        const rows = await this.db
            .select({
                userId: sandboxActiveDurationDays.userId,
                day: sandboxActiveDurationDays.day,
                value: sandboxActiveDurationDays.activeSeconds
            })
            .from(sandboxActiveDurationDays)
            .where(
                and(
                    inArray(sandboxActiveDurationDays.userId, userIds),
                    gte(sandboxActiveDurationDays.day, minStartDay)
                )
            )
        for (const row of rows) {
            const window = windows.get(row.userId)
            if (!window) continue
            if (row.day < window.startDay || row.day >= window.endDay) continue
            map.set(
                row.userId,
                (map.get(row.userId) ?? 0) + Number(row.value ?? 0)
            )
        }
        return map
    }

    // Per-host period totals. Hosts may span several owners (admin sandbox
    // list), so each host's window is its OWNER's billing period; rows carry
    // the denormalized user_id, so filtering happens against the owner's
    // window in TS — the anniversary clamp is deliberately not re-implemented
    // in SQL.
    async activeSecondsInPeriodByHost(
        hosts: Array<{ id: string; userId: string }>,
        now = new Date()
    ): Promise<Map<string, number>> {
        const map = new Map<string, number>()
        if (hosts.length === 0) return map
        const periods = await this.usagePeriods.resolveMany(
            this.db,
            [...new Set(hosts.map((h) => h.userId))],
            now
        )
        const windows = new Map(
            [...periods].map(([userId, period]) => [
                userId,
                periodDayWindow(period)
            ])
        )
        const minStartDay = [...windows.values()]
            .map((w) => w.startDay)
            .sort()[0]
        const rows = await this.db
            .select({
                hostId: sandboxActiveDurationDays.hostId,
                userId: sandboxActiveDurationDays.userId,
                day: sandboxActiveDurationDays.day,
                value: sandboxActiveDurationDays.activeSeconds
            })
            .from(sandboxActiveDurationDays)
            .where(
                and(
                    inArray(
                        sandboxActiveDurationDays.hostId,
                        hosts.map((h) => h.id)
                    ),
                    gte(sandboxActiveDurationDays.day, minStartDay)
                )
            )
        for (const row of rows) {
            const window = windows.get(row.userId)
            if (!window) continue
            if (row.day < window.startDay || row.day >= window.endDay) continue
            map.set(
                row.hostId,
                (map.get(row.hostId) ?? 0) + Number(row.value ?? 0)
            )
        }
        return map
    }
}
