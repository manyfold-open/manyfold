import {
    AgentFramework,
    FEATURE_TOGGLE_KEYS,
    Plan,
    PlanId,
    QuotaWarningCode,
    RuntimeAccessSummary,
    SandboxUsageBreakdown,
    createObjectId,
    frameworkCapabilities,
    frameworkCapability,
    runtimeKindLabel
} from '@manyfold/shared'
import {
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException, Optional } from '@nestjs/common'
import {
    and,
    count,
    eq,
    gte,
    isNull,
    lt,
    ne,
    sql,
    sum
} from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    automationRuns,
    automations,
    channels,
    runtimeHosts,
    plans,
    userApiUsageDays,
    users,
    type AgentRuntimeRow,
    type Database,
    type NewAgentRuntimeRow,
    type RuntimeHostRow,
    type User
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    CLOUD_COMPUTER_PORT,
    type CloudComputerPort
} from '@/common/ports/cloud-computer.ports'
import {
    periodDayWindow,
    type UsagePeriod
} from '@/common/usage-period/usage-period'
import {
    USAGE_PERIOD_PORT,
    calendarUsagePeriodPort,
    type UsagePeriodPort
} from '@/common/ports/usage-period.ports'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { nextFreeLabel } from '@/modules/agent-runtimes/runtime-label'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { buildSandboxUsageBreakdown } from './sandbox-usage-breakdown'
import {
    alwaysOnlineUsageInTx,
    emptyUsage,
    usageCountsForUsers as computeUsageCountsForUsers,
    type RuntimeUsageCounts
} from './runtime-usage-counts'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

// Advisory-lock namespaces on hashtextextended(userId, N):
//   0 — reserveRuntime    (per-user runtime agent-slot quota: daemon/k8s agents)
//   2 — reserveActiveSlot + enableKeepAlive (per-user concurrent active
//       sprite cap; SAME namespace on purpose so keep-alive enables
//       serialize against chat/terminal admissions)
//   3 — reserveAlwaysOnlineRuntimeSlot (per-user always-online runtime registration cap: daemon host or k8s container)
//   4 — reserveChannel    (per-user channels cap)
//   5 — reserveAutomation (per-user automation definitions cap)
//   6 — reserveAutomationRun (per-user monthly automation run quota)

// sprites.dev allows exactly ONE service holding `http_port` per sprite (a PUT
// claiming a second is rejected), and every service-kind framework serves its
// gateway on the sprite's single public URL. So a sandbox hosts at most one of
// them; coding frameworks need no port and mix freely.
const isServiceFramework = (
    framework: NewAgentRuntimeRow['framework']
): boolean => frameworkCapability(framework).kind === 'service'

const SERVICE_FRAMEWORKS = (
    Object.keys(frameworkCapabilities) as AgentFramework[]
).filter((framework) => frameworkCapabilities[framework].kind === 'service')

@Injectable()
export class RuntimeAccessService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly adminSettings: AdminSettingsService,
        private readonly telemetry: TelemetryService,
        private readonly activeDuration: SandboxActiveDurationService,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means the open default (zero subscriptions).
        @Optional()
        @Inject(CLOUD_COMPUTER_PORT)
        private readonly cloudComputer?: CloudComputerPort,
        // Same convention; absence means calendar-month metering windows.
        @Optional()
        @Inject(USAGE_PERIOD_PORT)
        private readonly usagePeriods: UsagePeriodPort = calendarUsagePeriodPort
    ) {}

    async summary(userId: string): Promise<RuntimeAccessSummary> {
        const [row] = await this.db
            .select({
                user: users,
                plan: plans
            })
            .from(users)
            .innerJoin(plans, eq(plans.id, users.planId))
            .where(eq(users.id, userId))
            .limit(1)
        if (!row) throw new NotFoundException('user not found')
        const usagePeriod = await this.usagePeriods.resolve(this.db, userId)
        const [
            counts,
            activeSandboxUsage,
            storageBytesTotal,
            channelsUsed,
            automationsUsed,
            automationRunsThisPeriod,
            apiRequestsThisPeriod,
            activeContainerSubscriptions,
            activeSecondsThisPeriod
        ] = await Promise.all([
            this.usageCountsForUsers([userId]),
            this.activeSandboxUsageFor(userId),
            this.storageBytesTotalFor(userId),
            this.channelCountFor(userId),
            this.automationCountFor(userId),
            this.automationRunCountInPeriod(userId, usagePeriod),
            this.apiRequestsInPeriod(userId, usagePeriod),
            this.cloudComputer?.activeContainerSubscriptionCount(userId) ?? 0,
            this.activeDuration.userActiveSecondsInPeriod(userId, usagePeriod)
        ])
        const cloudComputerEnabled = await this.adminSettings.isFeatureEnabled(
            FEATURE_TOGGLE_KEYS.CLOUD_COMPUTER
        )
        return accessSummary(
            row.user,
            planFromRow(row.plan),
            counts.get(userId) ?? emptyUsage(),
            activeSandboxUsage,
            usagePeriod,
            storageBytesTotal,
            activeSecondsThisPeriod / 3600,
            channelsUsed,
            automationsUsed,
            automationRunsThisPeriod,
            apiRequestsThisPeriod,
            activeContainerSubscriptions,
            cloudComputerEnabled
        )
    }

    // Meter drill-down: the same rows the two usage meters aggregate, grouped
    // per sandbox host. Totals equal the summary's storageBytesTotal /
    // activeHoursThisPeriod by construction (identical filters + windows).
    async sandboxUsage(userId: string): Promise<SandboxUsageBreakdown> {
        const usagePeriod = await this.usagePeriods.resolve(this.db, userId)
        const [hostRows, agentRows, secondsByHost] = await Promise.all([
            this.db
                .select({
                    id: runtimeHosts.id,
                    name: runtimeHosts.name,
                    spriteStatus: runtimeHosts.spriteStatus,
                    storageBytes: runtimeHosts.storageBytes,
                    storageMeasuredAt: runtimeHosts.storageMeasuredAt,
                    storageBreakdown: runtimeHosts.storageBreakdown
                })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.userId, userId),
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.status, 'active')
                    )
                ),
            this.db
                .select({
                    id: agents.id,
                    name: agents.name,
                    framework: agents.framework,
                    hostId: agents.hostId
                })
                .from(agents)
                .where(
                    and(
                        eq(agents.userId, userId),
                        eq(agents.runtime, 'sprites'),
                        ne(agents.status, 'failed')
                    )
                ),
            this.activeDuration.userActiveSecondsInPeriodByHost(
                userId,
                usagePeriod
            )
        ])
        return buildSandboxUsageBreakdown(
            usagePeriod,
            hostRows,
            agentRows,
            secondsByHost
        )
    }

    private async channelCountFor(userId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(channels)
            .where(eq(channels.userId, userId))
        return Number(row?.value ?? 0)
    }

    // Tombstoned automations free their plan slot immediately; run counts
    // below deliberately keep counting a deleted automation's runs — the
    // usage happened, and refunding it on delete would let a user cycle
    // delete/create to evade the monthly quota (#588).
    private async automationCountFor(userId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(automations)
            .where(
                and(
                    eq(automations.userId, userId),
                    isNull(automations.deletedAt)
                )
            )
        return Number(row?.value ?? 0)
    }

    // Automation runs are counted on raw timestamps, so the period window is
    // exact (no day-bucket boundary fuzz).
    private async automationRunCountInPeriod(
        userId: string,
        period: UsagePeriod
    ): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(automationRuns)
            .where(
                and(
                    eq(automationRuns.userId, userId),
                    gte(automationRuns.startedAt, period.start),
                    lt(automationRuns.startedAt, period.end)
                )
            )
        return Number(row?.value ?? 0)
    }

    private async apiRequestsInPeriod(
        userId: string,
        period: UsagePeriod
    ): Promise<number> {
        const { startDay, endDay } = periodDayWindow(period)
        const [row] = await this.db
            .select({
                value: sql<number>`coalesce(sum(${userApiUsageDays.requestCount}), 0)::bigint`
            })
            .from(userApiUsageDays)
            .where(
                and(
                    eq(userApiUsageDays.userId, userId),
                    gte(userApiUsageDays.day, startDay),
                    lt(userApiUsageDays.day, endDay)
                )
            )
        return Number(row?.value ?? 0)
    }


    // Host-grained: sprites.dev bills each VM's rootfs once, so the meter sums
    // one whole-VM reading per sandbox host (not per agent — co-resident
    // agents share the VM and must not multiply-count it).
    private async storageBytesTotalFor(userId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: sum(runtimeHosts.storageBytes) })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.status, 'active')
                )
            )
        return Number(row?.value ?? 0)
    }

    // Effective included hours = plan hours + per-user bonus; null = unlimited
    // or enforcement toggle off. Reads run on this.db (the day-bucket ledger is
    // written by the status-sync loop, not by admissions), keeping advisory-lock
    // transactions short.
    private async activeHoursStatus(input: {
        userId: string
        monthlyActiveHoursIncluded: number | null
        activeHoursBonus: number
    }): Promise<{
        exhausted: boolean
        usedHours: number
        limitHours: number
    } | null> {
        if (input.monthlyActiveHoursIncluded === null) return null
        if (
            !(await this.adminSettings.isFeatureEnabled(
                FEATURE_TOGGLE_KEYS.ACTIVE_HOURS_ENFORCEMENT
            ))
        )
            return null
        const period = await this.usagePeriods.resolve(this.db, input.userId)
        const seconds = await this.activeDuration.userActiveSecondsInPeriod(
            input.userId,
            period
        )
        const limitHours =
            input.monthlyActiveHoursIncluded + input.activeHoursBonus
        return {
            exhausted: seconds >= limitHours * 3600,
            usedHours: Math.round((seconds / 3600) * 10) / 10,
            limitHours
        }
    }

    private async assertActiveHoursAvailable(input: {
        userId: string
        planName: string
        monthlyActiveHoursIncluded: number | null
        activeHoursBonus: number
    }): Promise<void> {
        const status = await this.activeHoursStatus(input)
        if (!status?.exhausted) return
        throw new ForbiddenException({
            message: `active hours quota reached (${status.limitHours}h included for ${input.planName} plan this billing period)`,
            code: 'ACTIVE_HOURS_QUOTA_REACHED',
            current: status.usedHours,
            limit: status.limitHours,
            planName: input.planName
        })
    }

    // The one quota the reserveActiveSlot fast path cannot skip. Concurrency
    // and the org cap are about acquiring a slot that a still-running host
    // already holds, so re-testing them on that host would be meaningless.
    // Active hours are the opposite: the host staying `running` is what
    // CONSUMES them, so an exhausted user's next turn has to be refused even
    // though — especially though — the VM is already up. Seen on prod
    // [2026-09-03]: a free sandbox pinned `running` by a leaked exec session
    // went on admitting turns while the meter read 52h against a 5h plan,
    // because every one of those turns took this path and never looked.
    //
    // Costs nothing in the default configuration: the toggle read is cached
    // and returns before any query. A user with no plan row is not gated
    // here, matching isActiveHoursExhausted — the slow path is where a broken
    // planId surfaces as an error, and inventing a second failure mode for it
    // on the turn-admission hot path would trade a billing leak for an outage.
    private async assertActiveHoursOnRunningHost(
        userId: string
    ): Promise<void> {
        if (
            !(await this.adminSettings.isFeatureEnabled(
                FEATURE_TOGGLE_KEYS.ACTIVE_HOURS_ENFORCEMENT
            ))
        )
            return
        const [row] = await this.db
            .select({
                planName: plans.name,
                activeHoursBonus: users.activeHoursBonus,
                monthlyActiveHoursIncluded: plans.monthlyActiveHoursIncluded
            })
            .from(users)
            .innerJoin(plans, eq(plans.id, users.planId))
            .where(eq(users.id, userId))
            .limit(1)
        if (!row) return
        await this.assertActiveHoursAvailable({
            userId,
            planName: row.planName,
            monthlyActiveHoursIncluded: row.monthlyActiveHoursIncluded,
            activeHoursBonus: row.activeHoursBonus
        })
    }

    // Non-throwing probe for fire-and-forget wake paths. Fails open: a
    // metering hiccup must degrade to "not exhausted", never block wakes.
    async isActiveHoursExhausted(userId: string): Promise<boolean> {
        try {
            const [row] = await this.db
                .select({
                    activeHoursBonus: users.activeHoursBonus,
                    monthlyActiveHoursIncluded:
                        plans.monthlyActiveHoursIncluded
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, userId))
                .limit(1)
            if (!row) return false
            const status = await this.activeHoursStatus({
                userId,
                monthlyActiveHoursIncluded: row.monthlyActiveHoursIncluded,
                activeHoursBonus: row.activeHoursBonus
            })
            return status?.exhausted ?? false
        } catch {
            return false
        }
    }

    // Hard block for NEW sprite provisioning only: waking an existing sandbox
    // adds no storage and must stay allowed so users can shrink their usage.
    private async assertStorageQuotaAvailable(
        tx: Tx,
        input: { userId: string; maxStorageGb: number; planName: string }
    ): Promise<void> {
        if (
            !(await this.adminSettings.isFeatureEnabled(
                FEATURE_TOGGLE_KEYS.STORAGE_HARD_LIMIT
            ))
        )
            return
        const [row] = await tx
            .select({ value: sum(runtimeHosts.storageBytes) })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, input.userId),
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.status, 'active')
                )
            )
        const current = Number(row?.value ?? 0)
        const limit = input.maxStorageGb * 1_000_000_000
        if (current >= limit)
            throw new ForbiddenException({
                message: `sandbox storage limit reached (${input.maxStorageGb} GB for ${input.planName} plan)`,
                code: 'STORAGE_LIMIT_REACHED',
                current,
                limit,
                planName: input.planName
            })
    }

    async evaluateQuotaThresholds(userId: string): Promise<
        Array<{
            code: QuotaWarningCode
            usage: number
            limit: number
            planName: string
        }>
    > {
        const summary = await this.summary(userId)
        const plan = summary.plan
        const candidates: Array<{
            code: QuotaWarningCode
            usage: number
            limit: number
            due: boolean
        }> = []

        // A null limit is "unlimited" on this plan, and a zero limit means the
        // feature is off — neither has a threshold worth warning about.
        const meter = (
            code: QuotaWarningCode,
            usage: number,
            limit: number | null,
            threshold: number
        ): void => {
            if (limit === null || limit <= 0) return
            candidates.push({ code, usage, limit, due: usage / limit >= threshold })
        }

        // Count caps also warn with one slot left. A pure ratio is useless when
        // the cap is small: 0.9 of Free's 2 channels is 1.8, so the banner would
        // first appear at 2/2 — the moment the user is already blocked, which is
        // not a warning. NOTE: `provisioned` deliberately stays ratio-only below
        // so this change doesn't move an existing banner's timing; unifying the
        // two is a follow-up, not something to quietly fold in here.
        const countCap = (
            code: QuotaWarningCode,
            usage: number,
            limit: number | null,
            threshold: number
        ): void => {
            if (limit === null || limit <= 0) return
            candidates.push({
                code,
                usage,
                limit,
                due: usage / limit >= threshold || limit - usage <= 1
            })
        }

        meter(
            'storage',
            summary.storageBytesTotal,
            plan.maxStorageGb * 1_000_000_000,
            0.95
        )
        meter(
            'provisioned',
            summary.statefulSandboxUsage,
            summary.statefulSandboxLimit,
            0.9
        )
        meter(
            'active_hours',
            summary.activeHoursThisPeriod ?? 0,
            summary.activeHoursLimit,
            0.8
        )
        countCap('channels', summary.channelsUsed, plan.maxChannels, 0.9)
        countCap('automations', summary.automationsUsed, plan.maxAutomations, 0.9)
        meter(
            'automation_runs',
            summary.automationRunsThisPeriod,
            plan.maxAutomationRunsMonthly,
            0.8
        )
        meter(
            'api_requests',
            summary.apiRequestsThisPeriod,
            plan.monthlyApiRequestLimit,
            0.8
        )
        // `concurrent` and `wholesale_soft` have no candidate here on purpose:
        // Free sits at 1/1 whenever any agent runs, and the wholesale banner is
        // emitted by the status-sync loop against org-wide state, not per user.

        const dueNow = new Date()
        const cutoff = new Date(dueNow.getTime() - 24 * 60 * 60 * 1000)
        const [userRow] = await this.db
            .select({ last: users.lastQuotaWarningsAt })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        const last: Partial<Record<QuotaWarningCode, string>> =
            userRow?.last ?? {}
        const due = candidates.filter((c) => {
            if (!c.due) return false
            const lastAt = last[c.code]
            if (!lastAt) return true
            return new Date(lastAt) < cutoff
        })
        if (due.length === 0) return []

        const merged: Record<string, string> = { ...last }
        for (const c of due) merged[c.code] = dueNow.toISOString()
        await this.db
            .update(users)
            .set({ lastQuotaWarningsAt: merged, updatedAt: dueNow })
            .where(eq(users.id, userId))

        return due.map((c) => ({
            code: c.code,
            usage: c.usage,
            limit: c.limit,
            planName: plan.name
        }))
    }

    private async activeSandboxUsageFor(userId: string): Promise<number> {
        // Per running sandbox VM (host-level sprite_status), so a bare sandbox
        // with an open terminal (no agent) still counts toward the cap.
        // Co-resident agents share one host and count once.
        const [row] = await this.db
            .select({ value: count() })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.spriteStatus, 'running')
                )
            )
        return Number(row?.value ?? 0)
    }

    async usageCountsForUsers(
        userIds: string[]
    ): Promise<Map<string, RuntimeUsageCounts>> {
        return computeUsageCountsForUsers(this.db, userIds)
    }

    async reserveRuntime(input: NewAgentRuntimeRow): Promise<AgentRuntimeRow> {
        if (
            input.kind === 'k8s' &&
            !(await this.adminSettings.isFeatureEnabled(
                FEATURE_TOGGLE_KEYS.CLOUD_COMPUTER
            ))
        )
            throw new ForbiddenException({
                message: 'cloud computer is not currently available',
                code: 'CLOUD_COMPUTER_DISABLED',
                kind: 'k8s'
            })
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`
            )
            if (input.kind === 'k8s') {
                await tx.execute(
                    sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 3))`
                )
            }
            const [row] = await tx
                .select({
                    userId: users.id,
                    statefulSandboxLimit: users.statefulSandboxLimit,
                    alwaysOnlineRuntimeBonus: users.alwaysOnlineRuntimeBonus,
                    planName: plans.name,
                    maxAgentsProvisioned: plans.maxAgentsProvisioned,
                    maxAlwaysOnlineRuntimes: plans.maxAlwaysOnlineRuntimes,
                    maxAlwaysOnlineAgents: plans.maxAlwaysOnlineAgents
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, input.userId))
                .limit(1)
            if (!row) throw new NotFoundException('user not found')

            // 'sprites' never reaches here — those go through
            // reserveSpriteRuntime / reserveStandaloneSandbox, which meter per
            // sandbox VM. A branch counting agent_runtimes used to sit here and
            // was unreachable; with co-residence (4 runtimes per VM) it also
            // disagreed with the live path by up to 4x, so it was the wrong
            // thing to copy from and is gone.
            if (input.kind === 'external') {
                await this.assertProvisionedQuotaAvailable(tx, {
                    userId: input.userId,
                    statefulSandboxLimit: row.statefulSandboxLimit,
                    maxAgentsProvisioned: row.maxAgentsProvisioned,
                    planName: row.planName,
                    kind: 'external'
                })
            } else if (input.kind === 'daemon' || input.kind === 'k8s') {
                const usage = await alwaysOnlineUsageInTx(tx, input.userId)
                const agentsLimit =
                    row.maxAlwaysOnlineAgents + row.alwaysOnlineRuntimeBonus
                if (usage.agentsUsed >= agentsLimit)
                    throw new ForbiddenException({
                        message: `always-online agent limit reached (${agentsLimit} for ${row.planName} plan)`,
                        code: 'ALWAYS_ONLINE_AGENT_LIMIT_REACHED',
                        kind: input.kind,
                        current: usage.agentsUsed,
                        limit: agentsLimit,
                        planName: row.planName
                    })
                if (input.kind === 'k8s') {
                    const runtimesLimit =
                        row.maxAlwaysOnlineRuntimes +
                        row.alwaysOnlineRuntimeBonus
                    if (usage.runtimesUsed >= runtimesLimit)
                        throw new ForbiddenException({
                            message: `always-online runtime limit reached (${runtimesLimit} for ${row.planName} plan)`,
                            code: 'ALWAYS_ONLINE_LIMIT_REACHED',
                            kind: 'k8s',
                            current: usage.runtimesUsed,
                            limit: runtimesLimit,
                            planName: row.planName
                        })
                }
            }

            const [inserted] = await tx
                .insert(agentRuntimes)
                .values(input)
                .returning()
            return inserted
        })
    }

    // plans.maxAgentsProvisioned is documented as the user's TOTAL agent count,
    // so it covers both things a user can provision without a wake: sandbox VMs
    // and external-provider runtimes (Dify / Langflow / A2A). External runtimes
    // were previously counted by nothing at all — reserveRuntime had no branch
    // for them — which left them unbounded on every plan.
    //
    // One shared count rather than a second cap: a dedicated
    // plans.maxExternalRuntimes column would be a migration plus four pricing
    // numbers to invent, and sharing matches the field's stated meaning. If
    // product wants external agents priced separately, that column is the
    // follow-up. Verified against prod before shipping: the heaviest user sits
    // at 17 sandboxes + 3 external against a cap of 75, so nothing goes
    // retroactively over.
    private async provisionedUnitsInTx(
        tx: Tx,
        userId: string
    ): Promise<number> {
        const [hosts] = await tx
            .select({ value: count() })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.userId, userId),
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.status, 'active')
                )
            )
        const [external] = await tx
            .select({ value: count() })
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.userId, userId),
                    eq(agentRuntimes.kind, 'external'),
                    ne(agentRuntimes.status, 'failed')
                )
            )
        return Number(hosts?.value ?? 0) + Number(external?.value ?? 0)
    }

    private async assertProvisionedQuotaAvailable(
        tx: Tx,
        input: {
            userId: string
            statefulSandboxLimit: number
            maxAgentsProvisioned: number
            planName: string
            kind: 'sprites' | 'external'
        }
    ): Promise<void> {
        const current = await this.provisionedUnitsInTx(tx, input.userId)
        const limit = effectiveStatefulSandboxLimit(
            input.statefulSandboxLimit,
            input.maxAgentsProvisioned
        )
        if (current >= limit)
            throw new ForbiddenException({
                message: `${runtimeKindLabel(input.kind)} limit reached (${limit} for ${input.planName} plan)`,
                code: 'RUNTIME_LIMIT_REACHED',
                kind: input.kind,
                current,
                limit,
                planName: input.planName
            })
    }

    // Next per-user sandbox label (sandbox-001, sandbox-002, …). MAX-suffix+1
    // so deletes leave gaps rather than re-using a number; race-safe because
    // every caller holds the namespace-0 per-user advisory lock.
    private async nextSandboxName(tx: Tx, userId: string): Promise<string> {
        const rows = (await tx.execute(sql`
            select coalesce(
                max((regexp_match(name, '^sandbox-([0-9]+)$'))[1]::int),
                0
            ) as max
            from runtime_hosts
            where user_id = ${userId} and kind = 'sandbox'
        `)) as unknown as Array<{ max: number | string | null }>
        const next = Number(rows[0]?.max ?? 0) + 1
        return `sandbox-${String(next).padStart(3, '0')}`
    }

    // Derive a runtime label from its host: <sandbox-name>-<framework>.
    // Runtime names are not db-unique — the numeric suffix only keeps
    // auto-generated labels tellable apart, and users may rename afterwards.
    private async nextRuntimeName(
        tx: Tx,
        userId: string,
        hostName: string,
        framework: NewAgentRuntimeRow['framework']
    ): Promise<string> {
        const rows = await tx
            .select({ name: agentRuntimes.name })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.userId, userId))
        return nextFreeLabel(
            `${hostName}-${framework}`,
            new Set(rows.map((r) => r.name))
        )
    }

    async reserveStandaloneSandbox(input: {
        userId: string
        name?: string
        accountId: string
    }): Promise<RuntimeHostRow> {
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`
            )
            const [row] = await tx
                .select({
                    statefulSandboxLimit: users.statefulSandboxLimit,
                    planName: plans.name,
                    maxAgentsProvisioned: plans.maxAgentsProvisioned,
                    maxStorageGb: plans.maxStorageGb
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, input.userId))
                .limit(1)
            if (!row) throw new NotFoundException('user not found')

            await this.assertStorageQuotaAvailable(tx, {
                userId: input.userId,
                maxStorageGb: row.maxStorageGb,
                planName: row.planName
            })
            await this.assertProvisionedQuotaAvailable(tx, {
                userId: input.userId,
                statefulSandboxLimit: row.statefulSandboxLimit,
                maxAgentsProvisioned: row.maxAgentsProvisioned,
                planName: row.planName,
                kind: 'sprites'
            })

            const hostId = createObjectId('sandboxHost')
            const [inserted] = await tx
                .insert(runtimeHosts)
                .values({
                    id: hostId,
                    userId: input.userId,
                    kind: 'sandbox',
                    name: input.name ?? (await this.nextSandboxName(tx, input.userId)),
                    accountId: input.accountId,
                    spriteName: hostId.replace(/_/g, '-'),
                    status: 'active',
                    emptiedAt: new Date()
                })
                .returning()
            return inserted
        })
    }

    // Sprite reservation owns the sandbox-host find-or-create so it stays atomic
    // with the runtime insert under the same per-user lock (namespace 0).
    // Placement is deliberately predictable: `hostId` given means "this sandbox,
    // or fail" (co-residence); `hostId` absent means "a fresh VM", never an
    // implicit reuse of whatever VM happened to be free. Provisioned quota is
    // metered per sandbox VM (distinct host_id), not per runtime, so attaching
    // to an existing sandbox consumes no extra slot.
    async reserveSpriteRuntime(input: {
        id: string
        userId: string
        framework: NewAgentRuntimeRow['framework']
        accountId: string
        hostId?: string
        mountPath: string
        currentPhase?: AgentRuntimeRow['currentPhase']
    }): Promise<{ runtime: AgentRuntimeRow; hostCreated: boolean }> {
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`
            )
            const [row] = await tx
                .select({
                    statefulSandboxLimit: users.statefulSandboxLimit,
                    planName: plans.name,
                    maxAgentsProvisioned: plans.maxAgentsProvisioned,
                    maxStorageGb: plans.maxStorageGb
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, input.userId))
                .limit(1)
            if (!row) throw new NotFoundException('user not found')

            // Every new runtime is a new workspace that grows storage, so the
            // storage hard block covers attach, reuse and fresh-VM paths alike.
            await this.assertStorageQuotaAvailable(tx, {
                userId: input.userId,
                maxStorageGb: row.maxStorageGb,
                planName: row.planName
            })

            // Explicit attach to a user-named sandbox: place the runtime on that
            // host, never auto-create. Any framework may co-reside; the attach
            // clears emptied_at so the reaper won't delete the host.
            if (input.hostId) {
                const target = (
                    (await tx.execute(sql`
                        select h.name as host_name,
                               h.sprite_name as sprite_name,
                               h.sprite_id as sprite_id,
                               exists(
                                   select 1 from agent_runtimes r
                                   where r.host_id = h.id
                                     and r.framework = ${input.framework}
                                     and r.status not in ('failed', 'stopped')
                               ) as framework_present,
                               (
                                   select r.framework from agent_runtimes r
                                   where r.host_id = h.id
                                     and r.framework <> ${input.framework}
                                     and r.framework in (${sql.join(
                                         SERVICE_FRAMEWORKS.map(
                                             (framework) => sql`${framework}`
                                         ),
                                         sql`, `
                                     )})
                                     and r.status not in ('failed', 'stopped')
                                   limit 1
                               ) as service_framework
                        from runtime_hosts h
                        where h.id = ${input.hostId}
                          and h.user_id = ${input.userId}
                          and h.kind = 'sandbox'
                          and h.status = 'active'
                          and h.account_id = ${input.accountId}
                          and h.sprite_id is not null
                    `)) as unknown as Array<{
                        host_name: string
                        sprite_name: string | null
                        sprite_id: string | null
                        framework_present: boolean
                        service_framework: string | null
                    }>
                )[0]
                if (!target)
                    throw new NotFoundException({
                        message: `sandbox ${input.hostId} not available`,
                        code: 'SANDBOX_NOT_FOUND'
                    })
                // Callers route same-framework creates into the existing instance
                // (add-agent) before reaching here, so this only fires on a race
                // — the partial unique index on (host_id, framework) is the last
                // line of defence.
                if (target.framework_present)
                    throw new ConflictException({
                        message: `sandbox already runs ${input.framework}`,
                        code: 'SANDBOX_FRAMEWORK_EXISTS'
                    })
                if (isServiceFramework(input.framework) && target.service_framework)
                    throw new ConflictException({
                        message: `sandbox already runs ${target.service_framework}; a sandbox can host only one of ${SERVICE_FRAMEWORKS.join(', ')} because its sprite exposes a single public port`,
                        code: 'SANDBOX_SERVICE_SLOT_TAKEN',
                        existingFramework: target.service_framework
                    })
                await tx
                    .update(runtimeHosts)
                    .set({ emptiedAt: null, updatedAt: new Date() })
                    .where(eq(runtimeHosts.id, input.hostId))
                const runtimeName = await this.nextRuntimeName(
                    tx,
                    input.userId,
                    target.host_name,
                    input.framework
                )
                const [attached] = await tx
                    .insert(agentRuntimes)
                    .values({
                        id: input.id,
                        userId: input.userId,
                        name: runtimeName,
                        framework: input.framework,
                        kind: 'sprites',
                        status: 'pending',
                        accountId: input.accountId,
                        spriteName: target.sprite_name,
                        spriteId: target.sprite_id,
                        hostId: input.hostId,
                        mountPath: input.mountPath,
                        currentPhase: input.currentPhase ?? null
                    })
                    .returning()
                return { runtime: attached, hostCreated: false }
            }

            // No sandbox named: always a fresh VM. Reuse is opt-in via hostId so
            // the caller (and the user) can tell where the agent will land — a new
            // VM counts against the per-user provisioned quota, metered per
            // distinct sandbox host (not per runtime).
            await this.assertProvisionedQuotaAvailable(tx, {
                userId: input.userId,
                statefulSandboxLimit: row.statefulSandboxLimit,
                maxAgentsProvisioned: row.maxAgentsProvisioned,
                planName: row.planName,
                kind: 'sprites'
            })
            const hostId = createObjectId('sandboxHost')
            const hostName = await this.nextSandboxName(tx, input.userId)
            const spriteName = hostId.replace(/_/g, '-')
            await tx.insert(runtimeHosts).values({
                id: hostId,
                userId: input.userId,
                kind: 'sandbox',
                name: hostName,
                accountId: input.accountId,
                spriteName,
                status: 'active'
            })

            const runtimeName = await this.nextRuntimeName(
                tx,
                input.userId,
                hostName,
                input.framework
            )
            const [inserted] = await tx
                .insert(agentRuntimes)
                .values({
                    id: input.id,
                    userId: input.userId,
                    name: runtimeName,
                    framework: input.framework,
                    kind: 'sprites',
                    status: 'pending',
                    accountId: input.accountId,
                    spriteName,
                    spriteId: null,
                    hostId,
                    mountPath: input.mountPath,
                    currentPhase: input.currentPhase ?? null
                })
                .returning()
            return { runtime: inserted, hostCreated: true }
        })
    }

    async reserveChannelSlot(userId: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 4))`
            )
            const [row] = await tx
                .select({
                    planName: plans.name,
                    maxChannels: plans.maxChannels
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, userId))
                .limit(1)
            if (!row) throw new NotFoundException('user not found')
            const [usage] = await tx
                .select({ value: count() })
                .from(channels)
                .where(eq(channels.userId, userId))
            const current = Number(usage?.value ?? 0)
            if (current >= row.maxChannels)
                throw new ForbiddenException({
                    message: `channel limit reached (${row.maxChannels} for ${row.planName} plan)`,
                    code: 'CHANNEL_LIMIT_REACHED',
                    current,
                    limit: row.maxChannels,
                    planName: row.planName
                })
        })
    }

    async reserveAutomationSlot(userId: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 5))`
            )
            const [row] = await tx
                .select({
                    planName: plans.name,
                    maxAutomations: plans.maxAutomations
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, userId))
                .limit(1)
            if (!row) throw new NotFoundException('user not found')
            const [usage] = await tx
                .select({ value: count() })
                .from(automations)
                .where(
                    and(
                        eq(automations.userId, userId),
                        isNull(automations.deletedAt)
                    )
                )
            const current = Number(usage?.value ?? 0)
            if (current >= row.maxAutomations)
                throw new ForbiddenException({
                    message: `automation limit reached (${row.maxAutomations} for ${row.planName} plan)`,
                    code: 'AUTOMATION_LIMIT_REACHED',
                    current,
                    limit: row.maxAutomations,
                    planName: row.planName
                })
        })
    }

    async reserveAutomationRun(userId: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 6))`
            )
            const [row] = await tx
                .select({
                    planName: plans.name,
                    maxAutomationRunsMonthly: plans.maxAutomationRunsMonthly
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, userId))
                .limit(1)
            if (!row) throw new NotFoundException('user not found')
            if (row.maxAutomationRunsMonthly === null) return
            const period = await this.usagePeriods.resolve(
                tx as unknown as Database,
                userId
            )
            const [usage] = await tx
                .select({ value: count() })
                .from(automationRuns)
                .where(
                    and(
                        eq(automationRuns.userId, userId),
                        gte(automationRuns.startedAt, period.start),
                        lt(automationRuns.startedAt, period.end)
                    )
                )
            const current = Number(usage?.value ?? 0)
            if (current >= row.maxAutomationRunsMonthly)
                throw new ForbiddenException({
                    message: `automation run quota reached (${row.maxAutomationRunsMonthly} for ${row.planName} plan this billing period)`,
                    code: 'AUTOMATION_RUN_QUOTA_REACHED',
                    current,
                    limit: row.maxAutomationRunsMonthly,
                    planName: row.planName
                })
        })
    }

    async lockDaemonHostRegistrationInTx(
        tx: Tx,
        userId: string
    ): Promise<void> {
        await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 3))`
        )
    }

    async assertDaemonHostSlotAvailableInTx(
        tx: Tx,
        userId: string
    ): Promise<void> {
        const [row] = await tx
            .select({
                alwaysOnlineRuntimeBonus: users.alwaysOnlineRuntimeBonus,
                planName: plans.name,
                maxAlwaysOnlineRuntimes: plans.maxAlwaysOnlineRuntimes
            })
            .from(users)
            .innerJoin(plans, eq(plans.id, users.planId))
            .where(eq(users.id, userId))
            .limit(1)
        if (!row) throw new NotFoundException('user not found')
        const usage = await alwaysOnlineUsageInTx(tx, userId)
        const runtimesLimit =
            row.maxAlwaysOnlineRuntimes + row.alwaysOnlineRuntimeBonus
        if (usage.runtimesUsed >= runtimesLimit)
            throw new ForbiddenException({
                message: `always-online runtime limit reached (${runtimesLimit} for ${row.planName} plan)`,
                code: 'ALWAYS_ONLINE_LIMIT_REACHED',
                kind: 'daemon',
                current: usage.runtimesUsed,
                limit: runtimesLimit,
                planName: row.planName
            })
    }

    async reserveDaemonHostSlot(userId: string): Promise<void> {
        await this.db.transaction(async (tx) => {
            await this.lockDaemonHostRegistrationInTx(tx, userId)
            await this.assertDaemonHostSlotAvailableInTx(tx, userId)
        })
    }

    async reserveActiveSlot(input: {
        userId: string
        hostId: string
    }): Promise<{
        plan: Plan | null
        activeCount: number
        wholesale: {
            current: number
            activeCap: number
            softCap: number
        } | null
        fastPath?: boolean
    }> {
        // Fast path: the target host is already running with an open accrual
        // watermark, so this admission adds no VM — both COUNTs below exclude
        // the target host and the committed-running write would be a no-op.
        // Consecutive turns in an active conversation drop from an advisory-
        // lock transaction (~5 statements) to one indexed read plus the hours
        // check below. Trade-off: a plan downgrade mid-conversation is not
        // re-checked while the VM stays running — the slot is already held, and
        // the next admission after the sync loop settles the host back to warm
        // re-checks everything.
        const [existing] = await this.db
            .select({
                spriteStatus: runtimeHosts.spriteStatus,
                activeAccrualSince: runtimeHosts.activeAccrualSince
            })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.id, input.hostId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
            .limit(1)
        if (
            existing?.spriteStatus === 'running' &&
            existing.activeAccrualSince
        ) {
            await this.assertActiveHoursOnRunningHost(input.userId)
            return {
                plan: null,
                activeCount: 0,
                wholesale: null,
                fastPath: true
            }
        }

        const cap = await this.adminSettings.getCachedSpritesEffectiveCap()
        return this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 2))`
            )

            const [row] = await tx
                .select({
                    plan: plans,
                    activeHoursBonus: users.activeHoursBonus
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, input.userId))
                .limit(1)
            if (!row) throw new NotFoundException('user not found')
            const plan = planFromRow(row.plan)

            // Hours exhaustion wins over CONCURRENT as the reported error:
            // stopping another sandbox wouldn't unblock an over-quota user.
            await this.assertActiveHoursAvailable({
                userId: input.userId,
                planName: plan.name,
                monthlyActiveHoursIncluded: plan.monthlyActiveHoursIncluded,
                activeHoursBonus: row.activeHoursBonus
            })

            const [usage] = await tx
                .select({ value: count() })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.userId, input.userId),
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.spriteStatus, 'running'),
                        ne(runtimeHosts.id, input.hostId)
                    )
                )
            const activeCount = Number(usage?.value ?? 0)

            if (activeCount >= plan.maxConcurrentActive)
                throw new ForbiddenException({
                    message: `concurrent active sprite limit reached (${plan.maxConcurrentActive} for ${plan.name} plan)`,
                    code: 'CONCURRENT_ACTIVE_LIMIT_REACHED',
                    current: activeCount,
                    limit: plan.maxConcurrentActive,
                    planName: plan.name
                })

            const [orgRow] = await tx
                .select({ value: count() })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.spriteStatus, 'running'),
                        // Exclude the target host: it ends up running either way,
                        // so the cap applies to the OTHER running VMs. Starting a
                        // 2nd framework on an already running VM adds no VM and
                        // must not trip the org cap.
                        ne(runtimeHosts.id, input.hostId)
                    )
                )
            const orgActive = Number(orgRow?.value ?? 0)
            const softCap = Math.floor(
                (cap.activeCap * cap.softThresholdPct) / 100
            )

            if (orgActive >= cap.activeCap) {
                this.telemetry.event('wholesale_capacity_hard_cap', {
                    orgActive,
                    activeCap: cap.activeCap,
                    policyActiveCap: cap.policyActiveCap,
                    vendorRunningLimit: cap.vendorRunningLimit,
                    clamped: cap.clamped,
                    softCap,
                    userId: input.userId
                })
                throw new ServiceUnavailableException({
                    message: 'platform capacity reached — try again shortly',
                    code: 'WHOLESALE_CAPACITY_REACHED',
                    retryAfterSec: 30,
                    current: orgActive,
                    limit: cap.activeCap
                })
            }
            if (orgActive >= softCap) {
                this.telemetry.event('wholesale_capacity_soft_cap', {
                    orgActive,
                    activeCap: cap.activeCap,
                    policyActiveCap: cap.policyActiveCap,
                    vendorRunningLimit: cap.vendorRunningLimit,
                    clamped: cap.clamped,
                    softCap,
                    userId: input.userId
                })
            }

            // B2: commit the target host as running under the same lock so a
            // concurrent admission counts it. A cold bare-sandbox terminal has
            // no agent/publishStatus to flip it; sync reconciles it back to
            // warm/cold when the VM actually goes idle.
            const now = new Date()
            await tx
                .update(runtimeHosts)
                .set({
                    spriteStatus: 'running',
                    // Open the active-duration watermark in the same admission
                    // write so a chat/terminal session is metered from the moment
                    // its slot is reserved — the periodic sync only observes the
                    // later running→warm release. coalesce keeps an open interval.
                    // ms-precision ISO string, NOT a raw Date: postgres-js binds a
                    // JS Date interpolated into a sql`` fragment as text and crashes
                    // in Buffer.byteLength. The ::timestamptz cast keeps ms precision
                    // — the accrue/settle CAS compares this column to a ms value, and
                    // SQL now() (µs) would wedge it.
                    activeAccrualSince: sql`coalesce(${runtimeHosts.activeAccrualSince}, ${now.toISOString()}::timestamptz)`,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(runtimeHosts.id, input.hostId),
                        eq(runtimeHosts.kind, 'sandbox')
                    )
                )

            return {
                plan,
                activeCount,
                wholesale: {
                    current: orgActive,
                    activeCap: cap.activeCap,
                    softCap
                }
            }
        })
    }

    async enableKeepAlive(input: {
        userId: string
        runtimeId: string
        hostId: string
    }): Promise<void> {
        const cap = await this.adminSettings.getCachedSpritesEffectiveCap()
        await this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 2))`
            )

            const [row] = await tx
                .select({
                    plan: plans,
                    activeHoursBonus: users.activeHoursBonus
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(eq(users.id, input.userId))
                .limit(1)
            if (!row) throw new NotFoundException('user not found')
            const plan = planFromRow(row.plan)

            await this.assertActiveHoursAvailable({
                userId: input.userId,
                planName: plan.name,
                monthlyActiveHoursIncluded: plan.monthlyActiveHoursIncluded,
                activeHoursBonus: row.activeHoursBonus
            })

            // Committed capacity = running sprites UNION enabled runtimes
            // (excluding the target so enabling an in-use sprite doesn't
            // double-charge its own slot). Counting only running rows would
            // let two concurrent enables on two COLD sprites both pass with
            // one slot left.
            const usageRows = (await tx.execute(sql`
                select count(*)::int as value from (
                    select id as host_id from runtime_hosts
                    where user_id = ${input.userId}
                      and kind = 'sandbox'
                      and sprite_status = 'running'
                      and id != ${input.hostId}
                    union
                    select distinct host_id from agent_runtimes
                    where user_id = ${input.userId}
                      and kind = 'sprites'
                      and keep_alive_enabled = true
                      and host_id is not null
                      and host_id != ${input.hostId}
                ) committed
            `)) as unknown as Array<{ value?: unknown }>
            const current = Number(usageRows[0]?.value ?? 0)

            if (current >= plan.maxConcurrentActive)
                throw new ForbiddenException({
                    message: `concurrent active sprite limit reached (${plan.maxConcurrentActive} for ${plan.name} plan)`,
                    code: 'CONCURRENT_ACTIVE_LIMIT_REACHED',
                    current,
                    limit: plan.maxConcurrentActive,
                    planName: plan.name
                })

            const [orgRow] = await tx
                .select({ value: count() })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.spriteStatus, 'running'),
                        // Exclude the target host: it ends up running either way,
                        // so the cap applies to the OTHER running VMs. Starting a
                        // 2nd framework on an already running VM adds no VM and
                        // must not trip the org cap.
                        ne(runtimeHosts.id, input.hostId)
                    )
                )
            const orgActive = Number(orgRow?.value ?? 0)
            const softCap = Math.floor(
                (cap.activeCap * cap.softThresholdPct) / 100
            )

            if (orgActive >= cap.activeCap) {
                this.telemetry.event('wholesale_capacity_hard_cap', {
                    orgActive,
                    activeCap: cap.activeCap,
                    policyActiveCap: cap.policyActiveCap,
                    vendorRunningLimit: cap.vendorRunningLimit,
                    clamped: cap.clamped,
                    softCap,
                    userId: input.userId
                })
                throw new ServiceUnavailableException({
                    message: 'platform capacity reached — try again shortly',
                    code: 'WHOLESALE_CAPACITY_REACHED',
                    retryAfterSec: 30,
                    current: orgActive,
                    limit: cap.activeCap
                })
            }
            if (orgActive >= softCap) {
                this.telemetry.event('wholesale_capacity_soft_cap', {
                    orgActive,
                    activeCap: cap.activeCap,
                    policyActiveCap: cap.policyActiveCap,
                    vendorRunningLimit: cap.vendorRunningLimit,
                    clamped: cap.clamped,
                    softCap,
                    userId: input.userId
                })
            }

            // Same tx as the cap checks — admission and commitment are
            // atomic, so a crash mid-toggle leaves either nothing or a
            // committed flag the reconcile loop converges on.
            await tx
                .update(agentRuntimes)
                .set({ keepAliveEnabled: true, updatedAt: new Date() })
                .where(eq(agentRuntimes.id, input.runtimeId))
        })
    }

    /**
     * Read-only org headroom for the reconcile ensure pass: cached cap +
     * countDistinct running, no lock, no throw.
     */
    async spritesWholesaleHeadroom(): Promise<{
        orgActive: number
        activeCap: number
    }> {
        const cap = await this.adminSettings.getCachedSpritesEffectiveCap()
        const [row] = await this.db
            .select({ value: count() })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.spriteStatus, 'running')
                )
            )
        return {
            orgActive: Number(row?.value ?? 0),
            activeCap: cap.activeCap
        }
    }
}

export const effectiveStatefulSandboxLimit = (
    userStatefulSandboxLimit: number,
    planMaxAgentsProvisioned: number
): number => Math.max(userStatefulSandboxLimit, planMaxAgentsProvisioned)

export const accessSummary = (
    user: Pick<
        User,
        | 'id'
        | 'statefulSandboxLimit'
        | 'alwaysOnlineRuntimeBonus'
        | 'activeHoursBonus'
    >,
    plan: Plan,
    usage: RuntimeUsageCounts,
    activeSandboxUsage: number,
    usagePeriod: UsagePeriod,
    storageBytesTotal = 0,
    activeHoursThisPeriod: number | null = null,
    channelsUsed = 0,
    automationsUsed = 0,
    automationRunsThisPeriod = 0,
    apiRequestsThisPeriod = 0,
    activeContainerSubscriptions = 0,
    cloudComputerEnabled = false
): RuntimeAccessSummary => {
    const alwaysOnlineRuntimeLimit =
        plan.maxAlwaysOnlineRuntimes + user.alwaysOnlineRuntimeBonus
    const alwaysOnlineAgentsLimit =
        plan.maxAlwaysOnlineAgents + user.alwaysOnlineRuntimeBonus
    const statefulSandboxLimit = effectiveStatefulSandboxLimit(
        user.statefulSandboxLimit,
        plan.maxAgentsProvisioned
    )
    return {
        userId: user.id,
        plan,
        statefulSandboxLimit,
        alwaysOnlineRuntimeBonus: user.alwaysOnlineRuntimeBonus,
        alwaysOnlineRuntimeLimit,
        alwaysOnlineRuntimesUsed: usage.alwaysOnlineRuntimesUsed,
        alwaysOnlineRuntimesRemaining: Math.max(
            alwaysOnlineRuntimeLimit - usage.alwaysOnlineRuntimesUsed,
            0
        ),
        alwaysOnlineAgentsLimit,
        alwaysOnlineAgentsUsed: usage.alwaysOnlineAgentsUsed,
        alwaysOnlineAgentsRemaining: Math.max(
            alwaysOnlineAgentsLimit - usage.alwaysOnlineAgentsUsed,
            0
        ),
        persistentContainersUsed: usage.persistentContainersUsed,
        localDaemonsUsed: usage.localDaemonsUsed,
        cloudComputerEnabled,
        statefulSandboxUsage: usage.statefulSandboxUsage,
        statefulSandboxRemaining: Math.max(
            statefulSandboxLimit - usage.statefulSandboxUsage,
            0
        ),
        activeSandboxUsage,
        activeSandboxRemaining: Math.max(
            plan.maxConcurrentActive - activeSandboxUsage,
            0
        ),
        storageBytesTotal,
        usagePeriod: {
            start: usagePeriod.start.toISOString(),
            end: usagePeriod.end.toISOString(),
            source: usagePeriod.source
        },
        activeHoursThisPeriod,
        activeHoursLimit:
            plan.monthlyActiveHoursIncluded === null
                ? null
                : plan.monthlyActiveHoursIncluded + user.activeHoursBonus,
        activeHoursBonus: user.activeHoursBonus,
        channelsUsed,
        automationsUsed,
        automationRunsThisPeriod,
        apiRequestsThisPeriod,
        activeContainerSubscriptions
    }
}

export const planFromRow = (row: {
    id: string
    name: string
    maxAgentsProvisioned: number
    maxConcurrentActive: number
    maxStorageGb: number
    monthlyActiveHoursIncluded: number | null
    maxAlwaysOnlineRuntimes: number
    maxAlwaysOnlineAgents: number
    maxChannels: number
    maxAutomations: number
    maxAutomationRunsMonthly: number | null
    messageHistoryRetentionDays: number | null
    monthlyApiRequestLimit: number | null
}): Plan => ({
    id: row.id as PlanId,
    name: row.name,
    maxAgentsProvisioned: row.maxAgentsProvisioned,
    maxConcurrentActive: row.maxConcurrentActive,
    maxStorageGb: row.maxStorageGb,
    monthlyActiveHoursIncluded: row.monthlyActiveHoursIncluded,
    maxAlwaysOnlineRuntimes: row.maxAlwaysOnlineRuntimes,
    maxAlwaysOnlineAgents: row.maxAlwaysOnlineAgents,
    maxChannels: row.maxChannels,
    maxAutomations: row.maxAutomations,
    maxAutomationRunsMonthly: row.maxAutomationRunsMonthly,
    messageHistoryRetentionDays: row.messageHistoryRetentionDays,
    monthlyApiRequestLimit: row.monthlyApiRequestLimit
})
