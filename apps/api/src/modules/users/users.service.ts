import {
    AgentFramework,
    DEFAULT_USER_FRAMEWORK_RUNTIME_OVERRIDES,
    FrameworkRuntimeChoice,
    PlanId,
    SdkUserSummary,
    UpdateUserFrameworkRuntimeOverridesSettingsBody,
    UserFrameworkRuntimeOverridesSettings,
    UserRole,
    auditAction,
    configurableFrameworkRuntimeDefaults
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { and, asc, eq, gte, inArray, max, sql } from 'drizzle-orm'
import {
    auditLogs,
    chatMessages,
    chatSessions,
    plans,
    userApiUsageDays,
    users,
    type Database,
    type User
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { periodDayWindow } from '@/common/usage-period/usage-period'
import {
    USAGE_PERIOD_PORT,
    calendarUsagePeriodPort,
    type UsagePeriodPort
} from '@/common/ports/usage-period.ports'
import type { UpdateUserRuntimeAccessDto } from '@/modules/runtime-access/dto/runtime-access.dto'
import {
    emptyUsage,
    usageCountsForUsers as computeUsageCountsForUsers,
    type RuntimeUsageCounts
} from '@/modules/runtime-access/runtime-usage-counts'

const CONFIGURABLE_FRAMEWORK_RUNTIME_DEFAULTS: ReadonlySet<string> = new Set(
    configurableFrameworkRuntimeDefaults
)

interface PlanInfo {
    name: string
    monthlyApiRequestLimit: number | null
}

interface UserBilling {
    monthlyModelSpendUsd: number | null
    monthlyApiRequests: number
}

const emptyBilling = (): UserBilling => ({
    monthlyModelSpendUsd: null,
    monthlyApiRequests: 0
})

const BILLING_CHUNK = 500

const chunk = <T>(items: T[], size: number): T[][] => {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size))
    return out
}

const toSummary = (
    row: User,
    plan: PlanInfo | undefined,
    usage: RuntimeUsageCounts = emptyUsage(),
    lastMessageToAgentAt: Date | null = null,
    billing: UserBilling = emptyBilling()
): SdkUserSummary => ({
    id: row.id,
    email: row.email,
    role: row.role,
    planId: row.planId as PlanId,
    planName: plan?.name ?? row.planId,
    statefulSandboxLimit: row.statefulSandboxLimit,
    alwaysOnlineRuntimeBonus: row.alwaysOnlineRuntimeBonus,
    activeHoursBonus: row.activeHoursBonus,
    statefulSandboxUsage: usage.statefulSandboxUsage,
    alwaysOnlineRuntimesUsed: usage.alwaysOnlineRuntimesUsed,
    alwaysOnlineAgentsUsed: usage.alwaysOnlineAgentsUsed,
    monthlyModelSpendUsd: billing.monthlyModelSpendUsd,
    monthlyApiRequests: billing.monthlyApiRequests,
    monthlyApiRequestLimit: plan?.monthlyApiRequestLimit ?? null,
    lastMessageToAgentAt: lastMessageToAgentAt
        ? lastMessageToAgentAt.toISOString()
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

@Injectable()
export class UsersService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means calendar-month windows (no subscriptions).
        @Optional()
        @Inject(USAGE_PERIOD_PORT)
        private readonly usagePeriods: UsagePeriodPort = calendarUsagePeriodPort
    ) {}

    async list(): Promise<SdkUserSummary[]> {
        const rows = await this.db
            .select()
            .from(users)
            .orderBy(asc(users.createdAt))
        const userIds = rows.map((row) => row.id)
        const [plansById, usage, lastMessages, billing] = await Promise.all([
            this.plansById(),
            this.usageCountsForUsers(userIds),
            this.lastMessageToAgentForUsers(userIds),
            this.billingForUsers(userIds)
        ])
        return rows.map((row) =>
            toSummary(
                row,
                plansById.get(row.planId),
                usage.get(row.id),
                lastMessages.get(row.id) ?? null,
                billing.get(row.id)
            )
        )
    }

    async setRole(
        targetId: string,
        callerId: string,
        role: UserRole
    ): Promise<SdkUserSummary> {
        const [existing] = await this.db
            .select()
            .from(users)
            .where(eq(users.id, targetId))
            .limit(1)
        if (!existing) throw new NotFoundException('user not found')

        if (targetId === callerId && role === 'user')
            throw new BadRequestException('cannot demote yourself')

        const [updated] = await this.db
            .update(users)
            .set({ role, updatedAt: new Date() })
            .where(eq(users.id, targetId))
            .returning()
        return this.summary(updated)
    }

    async getFrameworkRuntimeOverrides(
        userId: string
    ): Promise<UserFrameworkRuntimeOverridesSettings> {
        const [row] = await this.db
            .select({
                frameworkRuntimeOverrides: users.frameworkRuntimeOverrides
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        if (!row) return { ...DEFAULT_USER_FRAMEWORK_RUNTIME_OVERRIDES }
        return {
            overrides:
                (row.frameworkRuntimeOverrides as Partial<
                    Record<AgentFramework, FrameworkRuntimeChoice>
                >) ?? {}
        }
    }

    async setFrameworkRuntimeOverrides(
        targetId: string,
        callerId: string,
        body: UpdateUserFrameworkRuntimeOverridesSettingsBody
    ): Promise<SdkUserSummary> {
        const [existing] = await this.db
            .select()
            .from(users)
            .where(eq(users.id, targetId))
            .limit(1)
        if (!existing) throw new NotFoundException('user not found')

        const normalized = this.normalizeFrameworkRuntimeOverrides(body)
        const [updated] = await this.db
            .update(users)
            .set({
                frameworkRuntimeOverrides: normalized.overrides,
                updatedAt: new Date()
            })
            .where(eq(users.id, targetId))
            .returning()
        await this.audit(
            callerId,
            auditAction.USER_RUNTIME_ACCESS_UPDATED,
            targetId,
            { frameworkRuntimeOverrides: normalized.overrides }
        )
        return this.summary(updated)
    }

    private normalizeFrameworkRuntimeOverrides(
        body: UpdateUserFrameworkRuntimeOverridesSettingsBody
    ): UserFrameworkRuntimeOverridesSettings {
        if (
            !body ||
            typeof body.overrides !== 'object' ||
            body.overrides === null
        )
            throw new BadRequestException('overrides must be an object')
        const validRuntimes: ReadonlySet<FrameworkRuntimeChoice> = new Set([
            'sprites',
            'k8s'
        ])
        const out: UserFrameworkRuntimeOverridesSettings['overrides'] = {}
        for (const [k, v] of Object.entries(body.overrides)) {
            if (v === undefined || v === null) continue
            if (!CONFIGURABLE_FRAMEWORK_RUNTIME_DEFAULTS.has(k))
                throw new BadRequestException(
                    `framework '${k}' override is not configurable`
                )
            if (!validRuntimes.has(v as FrameworkRuntimeChoice))
                throw new BadRequestException(
                    `framework '${k}' override must be one of: sprites, k8s`
                )
            out[k as keyof UserFrameworkRuntimeOverridesSettings['overrides']] =
                v as FrameworkRuntimeChoice
        }
        return { overrides: out }
    }

    async setRuntimeAccess(
        targetId: string,
        callerId: string,
        patch: UpdateUserRuntimeAccessDto
    ): Promise<SdkUserSummary> {
        const [existing] = await this.db
            .select()
            .from(users)
            .where(eq(users.id, targetId))
            .limit(1)
        if (!existing) throw new NotFoundException('user not found')

        const next: Partial<User> = { updatedAt: new Date() }
        if (patch.statefulSandboxLimit !== undefined)
            next.statefulSandboxLimit = patch.statefulSandboxLimit
        if (patch.alwaysOnlineRuntimeBonus !== undefined)
            next.alwaysOnlineRuntimeBonus = patch.alwaysOnlineRuntimeBonus
        if (patch.activeHoursBonus !== undefined)
            next.activeHoursBonus = patch.activeHoursBonus

        const [updated] = await this.db
            .update(users)
            .set(next)
            .where(eq(users.id, targetId))
            .returning()
        await this.audit(
            callerId,
            auditAction.USER_RUNTIME_ACCESS_UPDATED,
            targetId,
            {
                statefulSandboxLimit: updated.statefulSandboxLimit,
                alwaysOnlineRuntimeBonus: updated.alwaysOnlineRuntimeBonus,
                activeHoursBonus: updated.activeHoursBonus
            }
        )
        return this.summary(updated)
    }

    private async summary(row: User): Promise<SdkUserSummary> {
        const [plansById, usage, lastMessages, billing] = await Promise.all([
            this.plansById(),
            this.usageCountsForUsers([row.id]),
            this.lastMessageToAgentForUsers([row.id]),
            this.billingForUsers([row.id])
        ])
        return toSummary(
            row,
            plansById.get(row.planId),
            usage.get(row.id),
            lastMessages.get(row.id) ?? null,
            billing.get(row.id)
        )
    }

    private async plansById(): Promise<Map<string, PlanInfo>> {
        const rows = await this.db
            .select({
                id: plans.id,
                name: plans.name,
                monthlyApiRequestLimit: plans.monthlyApiRequestLimit
            })
            .from(plans)
        const map = new Map<string, PlanInfo>()
        for (const row of rows)
            map.set(row.id, {
                name: row.name,
                monthlyApiRequestLimit: row.monthlyApiRequestLimit
            })
        return map
    }

    // Per-user billing-period windows (the admin users list is unpaginated
    // over ALL users, so both aggregates are chunked). Model spend joins a
    // VALUES list of per-user [start, end) ranges — a single window can't work
    // because each subscriber's period starts on their own anchor day.
    private async billingForUsers(
        userIds: string[]
    ): Promise<Map<string, UserBilling>> {
        const result = new Map<string, UserBilling>()
        if (userIds.length === 0) return result
        const now = new Date()
        const periods = await this.usagePeriods.resolveMany(
            this.db,
            userIds,
            now
        )
        const ensure = (userId: string): UserBilling => {
            let current = result.get(userId)
            if (!current) {
                current = emptyBilling()
                result.set(userId, current)
            }
            return current
        }

        for (const ids of chunk(userIds, BILLING_CHUNK)) {
            const ranges = sql.join(
                ids.map((id) => {
                    const period = periods.get(id)
                    // ISO strings, NOT raw Dates: postgres-js crashes binding a JS
                    // Date interpolated into a sql`` fragment. The w.start_at/end_at
                    // columns are cast to ::timestamptz in the join below.
                    return sql`(${id}, ${(period?.start ?? now).toISOString()}, ${(period?.end ?? now).toISOString()})`
                }),
                sql`, `
            )
            const spendRows = (await this.db.execute(sql`
                select e.user_id as user_id, sum(e.cost_usd) as cost_usd
                from agent_usage_events e
                join (values ${ranges}) as w(user_id, start_at, end_at)
                  on w.user_id = e.user_id
                 and e.created_at >= w.start_at::timestamptz
                 and e.created_at < w.end_at::timestamptz
                group by e.user_id
            `)) as unknown as Array<{
                user_id: string
                cost_usd: string | null
            }>
            for (const row of spendRows)
                ensure(row.user_id).monthlyModelSpendUsd =
                    row.cost_usd === null ? null : Number(row.cost_usd)

            const windows = new Map(
                ids.flatMap((id) => {
                    const period = periods.get(id)
                    return period
                        ? [[id, periodDayWindow(period)] as const]
                        : []
                })
            )
            const minStartDay = [...windows.values()]
                .map((w) => w.startDay)
                .sort()[0]
            if (!minStartDay) continue
            const apiRows = await this.db
                .select({
                    userId: userApiUsageDays.userId,
                    day: userApiUsageDays.day,
                    requestCount: userApiUsageDays.requestCount
                })
                .from(userApiUsageDays)
                .where(
                    and(
                        inArray(userApiUsageDays.userId, ids),
                        gte(userApiUsageDays.day, minStartDay)
                    )
                )
            for (const row of apiRows) {
                const window = windows.get(row.userId)
                if (!window) continue
                if (row.day < window.startDay || row.day >= window.endDay)
                    continue
                ensure(row.userId).monthlyApiRequests += Number(
                    row.requestCount ?? 0
                )
            }
        }
        return result
    }

    private async usageCountsForUsers(
        userIds: string[]
    ): Promise<Map<string, RuntimeUsageCounts>> {
        return computeUsageCountsForUsers(this.db, userIds)
    }

    private async lastMessageToAgentForUsers(
        userIds: string[]
    ): Promise<Map<string, Date>> {
        const result = new Map<string, Date>()
        if (userIds.length === 0) return result
        const rows = await this.db
            .select({
                userId: chatSessions.userId,
                last: max(chatMessages.createdAt)
            })
            .from(chatMessages)
            .innerJoin(
                chatSessions,
                eq(chatMessages.sessionId, chatSessions.id)
            )
            .where(
                and(
                    eq(chatMessages.role, 'user'),
                    inArray(chatSessions.userId, userIds)
                )
            )
            .groupBy(chatSessions.userId)
        for (const row of rows) {
            if (row.last) result.set(row.userId, row.last)
        }
        return result
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch {}
    }
}
