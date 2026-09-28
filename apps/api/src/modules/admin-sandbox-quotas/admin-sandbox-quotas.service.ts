import type {
    SandboxQuotaTimeseriesPoint,
    SandboxQuotaTimeseriesRange,
    SandboxQuotaTimeseriesResponse,
    SandboxQuotaUserRow,
    SandboxQuotaUsersPage,
    SandboxQuotasOverview
} from '@manyfold/shared'
import { Inject, Injectable } from '@nestjs/common'
import { count, desc, eq, gte, sql } from 'drizzle-orm'
import {
    plans,
    runtimeHosts,
    spriteQuotaSnapshots,
    users,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import {
    LIVE_SPRITES_HOST_SQL,
    RUNNING_SPRITES_HOST_SQL,
    liveHostedHosts
} from '@/modules/runtime-access/runtime-usage-counts'

const DEFAULT_USERS_LIMIT = 50
const MAX_USERS_LIMIT = 200

const rangeToInterval = (range: SandboxQuotaTimeseriesRange): string => {
    switch (range) {
        case '24h':
            return '24 hours'
        case '7d':
            return '7 days'
        case '30d':
            return '30 days'
    }
}

@Injectable()
export class AdminSandboxQuotasService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly adminSettings: AdminSettingsService,
        private readonly activeDuration: SandboxActiveDurationService
    ) {}

    async overview(): Promise<SandboxQuotasOverview> {
        // Effective, not policy: the dashboard has to show the ceiling
        // admission actually enforces, or it reads 50/50 healthy while wakes
        // are 503ing against a vendor limit of 10.
        const cap = await this.adminSettings.getCachedSpritesEffectiveCap()
        // Sandbox VM metrics are per host: running/warm/cold from the host's
        // power state, provisioned = every live sandbox host (incl.
        // agent-less). Storage is the host-level rootfs sum.
        const rows = await this.db
            .select({
                powerState: runtimeHosts.powerState,
                count: count()
            })
            .from(runtimeHosts)
            .where(liveHostedHosts('sprites'))
            .groupBy(runtimeHosts.powerState)

        let orgActive = 0
        let orgWarm = 0
        let orgCold = 0
        let orgProvisioned = 0
        for (const r of rows) {
            const n = Number(r.count ?? 0)
            orgProvisioned += n
            if (r.powerState === 'running') orgActive = n
            else if (r.powerState === 'suspended') orgWarm = n
            else if (r.powerState === 'stopped') orgCold = n
        }
        const [storageRow] = await this.db
            .select({
                storage: sql<number>`coalesce(sum(${runtimeHosts.storageBytes}), 0)::bigint`
            })
            .from(runtimeHosts)
            .where(liveHostedHosts('sprites'))
        const orgStorageBytes = Number(storageRow?.storage ?? 0)
        const softCap = Math.floor(
            (cap.activeCap * cap.softThresholdPct) / 100
        )
        return {
            wholesaleCap: cap.activeCap,
            softThresholdPct: cap.softThresholdPct,
            softCap,
            orgActive,
            orgWarm,
            orgCold,
            orgProvisioned,
            orgStorageBytes
        }
    }

    async listUsers(input: {
        cursor?: string
        limit?: number
    }): Promise<SandboxQuotaUsersPage> {
        const limit = Math.min(
            Math.max(1, input.limit ?? DEFAULT_USERS_LIMIT),
            MAX_USERS_LIMIT
        )
        const cursorVal = input.cursor ? Number.parseInt(input.cursor, 10) : 0
        const offset = Number.isFinite(cursorVal) && cursorVal >= 0 ? cursorVal : 0

        // provisioned + concurrentActive + storage are all per sandbox host
        // (incl. agent-less; storage is one whole-VM rootfs reading per host).
        // Scalar subqueries (not joins, which would cross-product the grains).
        // Active seconds resolve per-user billing windows in TS (page <= 200),
        // NOT as a scalar subquery — the window logic lives once, in
        // usage-period, and raw SQL would silently survive schema renames.
        const provisionedSql = sql<number>`(select count(*) from runtime_hosts h where h.user_id = ${users.id} and ${sql.raw(LIVE_SPRITES_HOST_SQL)})::int`
        const concurrentActiveSql = sql<number>`(select count(*) from runtime_hosts h where h.user_id = ${users.id} and ${sql.raw(RUNNING_SPRITES_HOST_SQL)})::int`
        const storageBytesSql = sql<number>`(select coalesce(sum(h.storage_bytes), 0) from runtime_hosts h where h.user_id = ${users.id} and ${sql.raw(LIVE_SPRITES_HOST_SQL)})::bigint`
        const rows = await this.db
            .select({
                userId: users.id,
                email: users.email,
                planId: users.planId,
                planName: plans.name,
                provisioned: provisionedSql,
                concurrentActive: concurrentActiveSql,
                storageBytes: storageBytesSql,
                lastActiveAt: sql<Date | null>`(select max(a.last_reconciled_at) from agents a join agent_runtimes r on r.id = a.runtime_id join runtime_hosts h on h.id = r.host_id where a.user_id = ${users.id} and h.kind = 'hosted')`
            })
            .from(users)
            .innerJoin(plans, eq(plans.id, users.planId))
            .orderBy(desc(concurrentActiveSql), desc(storageBytesSql), users.id)
            .limit(limit + 1)
            .offset(offset)

        const hasMore = rows.length > limit
        const sliced = hasMore ? rows.slice(0, limit) : rows
        const activeSeconds =
            await this.activeDuration.activeSecondsInPeriodByUser(
                sliced.map((r) => r.userId)
            )
        const mapped: SandboxQuotaUserRow[] = sliced.map((r) => ({
            userId: r.userId,
            email: r.email,
            planId: r.planId,
            planName: r.planName,
            provisioned: Number(r.provisioned ?? 0),
            concurrentActive: Number(r.concurrentActive ?? 0),
            storageBytes: Number(r.storageBytes ?? 0),
            lastActiveAt:
                r.lastActiveAt instanceof Date
                    ? r.lastActiveAt.toISOString()
                    : null,
            activeHoursThisPeriod: (activeSeconds.get(r.userId) ?? 0) / 3600
        }))
        return {
            users: mapped,
            nextCursor: hasMore ? String(offset + limit) : null
        }
    }

    async timeseries(
        range: SandboxQuotaTimeseriesRange
    ): Promise<SandboxQuotaTimeseriesResponse> {
        const interval = rangeToInterval(range)
        const since = await this.db
            .select({
                at: spriteQuotaSnapshots.at,
                orgActive: spriteQuotaSnapshots.orgActive,
                orgWarm: spriteQuotaSnapshots.orgWarm,
                orgCold: spriteQuotaSnapshots.orgCold,
                orgProvisioned: spriteQuotaSnapshots.orgProvisioned,
                orgStorageBytes: spriteQuotaSnapshots.orgStorageBytes
            })
            .from(spriteQuotaSnapshots)
            .where(
                gte(
                    spriteQuotaSnapshots.at,
                    sql`now() - interval '${sql.raw(interval)}'`
                )
            )
            .orderBy(spriteQuotaSnapshots.at)
        const points: SandboxQuotaTimeseriesPoint[] = since.map((r) => ({
            at: r.at.toISOString(),
            orgActive: r.orgActive,
            orgWarm: r.orgWarm,
            orgCold: r.orgCold,
            orgProvisioned: r.orgProvisioned,
            orgStorageBytes: Number(r.orgStorageBytes ?? 0)
        }))
        return { range, points }
    }
}
