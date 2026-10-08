import {
    FEATURE_TOGGLE_KEYS,
    daemonOnline,
    type SandboxHealthCheckSource,
    type SandboxHealthVerdict
} from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
    and,
    asc,
    count,
    eq,
    gt,
    gte,
    inArray,
    isNotNull,
    isNull,
    lte,
    or,
    sql,
    type SQL
} from 'drizzle-orm'
import {
    hostDaemons,
    runtimeHosts,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AppEventsService } from '@/common/events/app-events.service'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { inBackgroundContext } from '@/common/telemetry/background-context'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { providerRefLabel } from '@/modules/agent-runtimes/host-ref'
import { HostPowerSyncService } from '@/modules/agents/sprite-status/host-power-sync.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { HostProviderResolver } from '@/modules/hosts/providers/host-provider-resolver.service'
import type { ProviderHealthReport } from '@/modules/hosts/providers/sandbox-provider'
import { hostedOnProviderKind } from '@/modules/runtime-access/runtime-usage-counts'
import {
    HEALTH_CHECK_LEASE_MS,
    decideTransition,
    maintenanceReasonText,
    recheckDelayMs,
    sandboxHealthConfig,
    truncateReason
} from './sandbox-health-policy'

export const SANDBOX_HEALTH_CHECKED_EVENT = 'sandbox_health.checked'
export const SANDBOX_HEALTH_CHECK_FAILED_EVENT = 'sandbox_health.check_failed'
export const SANDBOX_MAINTENANCE_ENTERED_EVENT = 'sandbox_maintenance.entered'
export const SANDBOX_MAINTENANCE_EXITED_EVENT = 'sandbox_maintenance.exited'

const TICK_MS = 30_000
const LEASE_NAME = 'sandbox-health'
const LEASE_TTL_MS = 90_000
const RECHECK_BATCH = 10
// The turns on one machine, and a turn and its retries, fail together: one
// check answers for all of them.
const FAILURE_DEBOUNCE_MS = 60_000
// A daemon seen this recently proves its machine runs; the sweep skips it.
const PROVEN_ALIVE_MS = 24 * 60 * 60_000
const MIN_SWEEP_AGE_MS = 24 * 60 * 60_000

export type SandboxHealthOutcome =
    | 'entered'
    | 'exited'
    | 'stayed'
    | 'recorded'
    | 'suppressed'
    | 'error'
    | 'gone'
    | 'lost'
    | 'in_progress'
    | 'not_applicable'
    | 'unsupported'

export interface SandboxHealthResult {
    outcome: SandboxHealthOutcome
    verdict?: SandboxHealthVerdict
    reason?: string | null
    error?: string
}

type Recorded = {
    outcome: Exclude<
        SandboxHealthOutcome,
        'error' | 'gone' | 'in_progress' | 'not_applicable' | 'unsupported'
    >
    previousStatus?: RuntimeHostRow['status']
    maintenanceSince?: Date | null
    retryInMs?: number
    suppressed?: 'shadow' | 'capped'
}

// The provider's health check on hosted sandboxes, and the maintenance stage it
// drives. A check is asked after a machine fails to come up (when the toggle is
// on), by a daily sweep of machines nothing has proven alive (its own toggle),
// on a backoff for every sandbox already in maintenance (always: it is the only
// way out), and by an admin. Any verdict but healthy puts a ready sandbox into
// maintenance, where nothing wakes it and every turn on it is refused at once.
//
// The check itself can act on the machine (sprites restarts a stopped one), so
// it is never asked about a machine whose daemon is connected, and every claim
// is a compare-and-set: one check per machine across instances, and a verdict
// that comes back after its lease was taken or cleared is dropped.
@Injectable()
export class SandboxHealthService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(SandboxHealthService.name)
    private timer: NodeJS.Timeout | null = null
    private inflight = false
    private isLeader = false
    private stopWatchingConnects: (() => void) | null = null
    private readonly leaseHolderId =
        process.env.FLY_MACHINE_ID || process.env.HOSTNAME || randomUUID()
    private readonly recentFailures = new Map<string, number>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hostProviders: HostProviderResolver,
        private readonly adminSettings: AdminSettingsService,
        private readonly telemetry: TelemetryService,
        private readonly powerSync: HostPowerSyncService,
        // Not @Optional: each one gates behaviour (the failure trigger, a
        // single leader, the reconnect expedite), and a module that cannot
        // see one must fail to boot rather than run without it. Optional in
        // TS only, for positional test construction.
        private readonly appEvents?: AppEventsService,
        private readonly serviceLeases?: ServiceLeaseService,
        private readonly registry?: DaemonRegistryService
    ) {}

    onModuleInit(): void {
        this.appEvents?.on('host.failure_observed', ({ hostId, cause }) =>
            this.noteFailure(hostId, cause)
        )
        this.stopWatchingConnects =
            this.registry?.onConnected((hostId) => {
                void this.expedite(hostId)
            }) ?? null
        this.timer = setInterval(
            inBackgroundContext(() => {
                void this.tick()
            }),
            TICK_MS
        )
        if (typeof this.timer.unref === 'function') this.timer.unref()
    }

    onModuleDestroy(): void {
        this.stopWatchingConnects?.()
        this.stopWatchingConnects = null
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        if (this.isLeader)
            void this.serviceLeases
                ?.release(LEASE_NAME, this.leaseHolderId)
                .catch(() => undefined)
    }

    // An admin's check: past the toggles and the rate limit, and its verdict
    // always applies.
    async checkNow(hostId: string): Promise<SandboxHealthResult> {
        const host = await this.readHost(hostId)
        if (!host || host.kind !== 'hosted') return { outcome: 'not_applicable' }
        return this.run(host, 'manual')
    }

    // Returns the host back in ready, or null when it was not in maintenance.
    // Clearing the lease drops any check still in flight: its verdict cannot
    // put the host straight back.
    async endMaintenance(hostId: string): Promise<RuntimeHostRow | null> {
        const before = await this.readHost(hostId)
        if (!before || before.status !== 'maintenance') return null
        const now = new Date()
        const [row] = await this.db
            .update(runtimeHosts)
            .set({
                status: 'ready',
                failureReason: null,
                maintenanceSince: null,
                healthCheckNextAt: null,
                healthCheckLeaseUntil: null,
                healthFailureCount: 0,
                updatedAt: now
            })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.status, 'maintenance')
                )
            )
            .returning()
        if (!row) return null
        this.telemetry.event(SANDBOX_MAINTENANCE_EXITED_EVENT, {
            ...this.hostAttrs(row),
            trigger: 'admin',
            durationMs: before.maintenanceSince
                ? now.getTime() - before.maintenanceSince.getTime()
                : undefined
        })
        await this.announce(row.id)
        return row
    }

    // A machine failed to come up for real work. Never throws, never waits:
    // the caller is a bring-up that has a turn to end.
    noteFailure(hostId: string, cause: string): void {
        const now = Date.now()
        const last = this.recentFailures.get(hostId)
        if (last !== undefined && now - last < FAILURE_DEBOUNCE_MS) return
        this.recentFailures.set(hostId, now)
        if (this.recentFailures.size > 1_000)
            for (const [id, at] of this.recentFailures)
                if (now - at >= FAILURE_DEBOUNCE_MS) this.recentFailures.delete(id)
        void this.checkAfterFailure(hostId, cause).catch((err) =>
            this.log.warn(
                `health check after failure skipped hostId=${hostId}: ${(err as Error).message}`
            )
        )
    }

    async tick(): Promise<void> {
        if (this.inflight) return
        this.inflight = true
        try {
            if (!(await this.acquireLeadership())) return
            await this.recheckDue()
            if (
                await this.adminSettings.isFeatureEnabled(
                    FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_SWEEP
                )
            )
                await this.sweep()
        } catch (err) {
            this.log.warn(`sandbox health tick failed: ${(err as Error).message}`)
        } finally {
            this.inflight = false
        }
    }

    private async checkAfterFailure(hostId: string, cause: string): Promise<void> {
        if (
            !(await this.adminSettings.isFeatureEnabled(
                FEATURE_TOGGLE_KEYS.SANDBOX_HEALTH_CHECKS
            ))
        )
            return
        const host = await this.readHost(hostId)
        if (!host || host.kind !== 'hosted' || host.status !== 'ready') return
        if (await this.daemonConnected(hostId)) return
        await this.run(host, 'failure', cause)
    }

    private async recheckDue(): Promise<void> {
        const due = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'hosted'),
                    eq(runtimeHosts.status, 'maintenance'),
                    lte(runtimeHosts.healthCheckNextAt, sql`clock_timestamp()`)
                )
            )
            .orderBy(asc(runtimeHosts.healthCheckNextAt))
            .limit(RECHECK_BATCH)
        for (const host of due) await this.run(host, 'recheck')
    }

    // Machines nothing has proven alive for a day, oldest check first: one that
    // broke while idle is found before its owner's next message meets it.
    private async sweep(): Promise<void> {
        const config = sandboxHealthConfig()
        const candidates = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'hosted'),
                    eq(runtimeHosts.status, 'ready'),
                    isNotNull(runtimeHosts.providerRef),
                    hostedOnProviderKind('sprites'),
                    lte(
                        runtimeHosts.createdAt,
                        sql`clock_timestamp() - (${MIN_SWEEP_AGE_MS} * interval '1 millisecond')`
                    ),
                    or(
                        isNull(runtimeHosts.healthCheckAttemptedAt),
                        lte(
                            runtimeHosts.healthCheckAttemptedAt,
                            sql`clock_timestamp() - (${config.sweepIntervalMs} * interval '1 millisecond')`
                        )
                    ),
                    sql`not exists (select 1 from ${hostDaemons} d where d.host_id = ${runtimeHosts.id} and d.last_seen_at > clock_timestamp() - (${PROVEN_ALIVE_MS} * interval '1 millisecond'))`
                )
            )
            .orderBy(sql`${runtimeHosts.healthCheckAttemptedAt} asc nulls first`)
            .limit(config.sweepBatch)
        for (const host of candidates) await this.run(host, 'sweep')
    }

    private async run(
        host: RuntimeHostRow,
        source: SandboxHealthCheckSource,
        cause?: string
    ): Promise<SandboxHealthResult> {
        const { provider, adapter } = await this.hostProviders.resolve(host)
        if (!adapter.checkHealth) return { outcome: 'unsupported' }
        const lease = new Date(Date.now() + HEALTH_CHECK_LEASE_MS)
        const claimed = await this.claim(host.id, source, lease)
        if (!claimed) {
            if (source !== 'manual') return { outcome: 'in_progress' }
            const current = await this.readHost(host.id)
            return {
                outcome:
                    current?.status === 'ready' ||
                    current?.status === 'maintenance'
                        ? 'in_progress'
                        : 'not_applicable'
            }
        }
        const started = Date.now()
        let report: ProviderHealthReport | 'gone'
        try {
            report = await adapter.checkHealth({ host: claimed, provider })
        } catch (err) {
            await this.release(claimed, lease)
            const error = (err as Error).message ?? String(err)
            this.telemetry.event(SANDBOX_HEALTH_CHECK_FAILED_EVENT, {
                ...this.hostAttrs(claimed),
                trigger: source,
                cause,
                durationMs: Date.now() - started,
                errorClass: err instanceof Error ? err.name : typeof err
            })
            return { outcome: 'error', error }
        }
        if (report === 'gone') {
            // The power sync's gone detector owns a vanished machine.
            await this.release(claimed, lease)
            this.telemetry.event(SANDBOX_HEALTH_CHECKED_EVENT, {
                ...this.hostAttrs(claimed),
                trigger: source,
                cause,
                outcome: 'gone',
                durationMs: Date.now() - started
            })
            return { outcome: 'gone' }
        }
        const recorded = await this.record(claimed, lease, report, source)
        const reason = truncateReason(report.reason)
        this.telemetry.event(SANDBOX_HEALTH_CHECKED_EVENT, {
            ...this.hostAttrs(claimed),
            trigger: source,
            cause,
            state: report.verdict,
            previousState: recorded.previousStatus,
            outcome: recorded.outcome,
            reason: report.verdict === 'unknown'
                ? `status "${report.rawStatus}"${reason ? `: ${reason}` : ''}`
                : reason,
            durationMs: Date.now() - started,
            retryInMs: recorded.retryInMs,
            mode: recorded.suppressed
        })
        if (recorded.outcome === 'entered') {
            this.telemetry.event(SANDBOX_MAINTENANCE_ENTERED_EVENT, {
                ...this.hostAttrs(claimed),
                trigger: source,
                state: report.verdict,
                reason,
                retryInMs: recorded.retryInMs
            })
            await this.announce(claimed.id)
        }
        if (recorded.outcome === 'exited') {
            this.telemetry.event(SANDBOX_MAINTENANCE_EXITED_EVENT, {
                ...this.hostAttrs(claimed),
                trigger: source,
                durationMs: recorded.maintenanceSince
                    ? Date.now() - recorded.maintenanceSince.getTime()
                    : undefined
            })
            await this.announce(claimed.id)
        }
        return { outcome: recorded.outcome, verdict: report.verdict, reason }
    }

    private async claim(
        hostId: string,
        source: SandboxHealthCheckSource,
        lease: Date
    ): Promise<RuntimeHostRow | null> {
        const now = new Date()
        const [row] = await this.db
            .update(runtimeHosts)
            .set({
                healthCheckLeaseUntil: lease,
                healthCheckAttemptedAt: now,
                updatedAt: now
            })
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.kind, 'hosted'),
                    isNotNull(runtimeHosts.providerRef),
                    or(
                        isNull(runtimeHosts.healthCheckLeaseUntil),
                        lte(
                            runtimeHosts.healthCheckLeaseUntil,
                            sql`clock_timestamp()`
                        )
                    ),
                    claimableFor(source)
                )
            )
            .returning()
        return row ?? null
    }

    // The verdict lands only through the lease it was claimed under, and the
    // transition rides in the same transaction, after the verdict's row lock.
    private async record(
        host: RuntimeHostRow,
        lease: Date,
        report: ProviderHealthReport,
        source: SandboxHealthCheckSource
    ): Promise<Recorded> {
        const config = sandboxHealthConfig()
        const autoEnter =
            source === 'manual' ||
            (await this.adminSettings.isFeatureEnabled(
                FEATURE_TOGGLE_KEYS.SANDBOX_MAINTENANCE_AUTO
            ))
        const reason = truncateReason(report.reason)
        return this.db.transaction(async (tx): Promise<Recorded> => {
            const now = new Date()
            const [row] = await tx
                .update(runtimeHosts)
                .set({
                    healthStatus: report.verdict,
                    healthReason: reason,
                    healthCheckedAt: now,
                    healthCheckLeaseUntil: null,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(runtimeHosts.id, host.id),
                        eq(runtimeHosts.healthCheckLeaseUntil, lease)
                    )
                )
                .returning()
            if (!row) return { outcome: 'lost' }
            let budgetLeft = true
            if (
                report.verdict !== 'healthy' &&
                row.status === 'ready' &&
                source !== 'manual' &&
                autoEnter
            ) {
                // Serialized, so two instances cannot both take the last slot.
                await tx.execute(
                    sql`select pg_advisory_xact_lock(hashtextextended('sandbox-maintenance-entry', 0))`
                )
                const [entries] = await tx
                    .select({ value: count() })
                    .from(runtimeHosts)
                    .where(
                        and(
                            eq(runtimeHosts.status, 'maintenance'),
                            gte(
                                runtimeHosts.maintenanceSince,
                                sql`clock_timestamp() - interval '1 hour'`
                            )
                        )
                    )
                budgetLeft =
                    Number(entries?.value ?? 0) < config.maxAutoEntriesPerHour
            }
            const transition = decideTransition({
                verdict: report.verdict,
                status: row.status,
                source,
                autoEnter,
                budgetLeft
            })
            const failureReason = maintenanceReasonText(
                report.verdict,
                report.rawStatus,
                reason
            )
            const previousStatus = row.status
            switch (transition.action) {
                case 'exit': {
                    const [exited] = await tx
                        .update(runtimeHosts)
                        .set({
                            status: 'ready',
                            failureReason: null,
                            maintenanceSince: null,
                            healthCheckNextAt: null,
                            healthFailureCount: 0,
                            updatedAt: now
                        })
                        .where(
                            and(
                                eq(runtimeHosts.id, host.id),
                                eq(runtimeHosts.status, 'maintenance')
                            )
                        )
                        .returning({ id: runtimeHosts.id })
                    return exited
                        ? {
                              outcome: 'exited',
                              previousStatus,
                              maintenanceSince: row.maintenanceSince
                          }
                        : { outcome: 'recorded', previousStatus }
                }
                case 'enter': {
                    const retryInMs = recheckDelayMs(report.verdict, 1)
                    const [entered] = await tx
                        .update(runtimeHosts)
                        .set({
                            status: 'maintenance',
                            failureReason,
                            maintenanceSince: now,
                            healthFailureCount: 1,
                            healthCheckNextAt: new Date(now.getTime() + retryInMs),
                            updatedAt: now
                        })
                        .where(
                            and(
                                eq(runtimeHosts.id, host.id),
                                eq(runtimeHosts.status, 'ready')
                            )
                        )
                        .returning({ id: runtimeHosts.id })
                    return entered
                        ? { outcome: 'entered', previousStatus, retryInMs }
                        : { outcome: 'recorded', previousStatus }
                }
                case 'stay': {
                    const failures = row.healthFailureCount + 1
                    const retryInMs = recheckDelayMs(report.verdict, failures)
                    const [stayed] = await tx
                        .update(runtimeHosts)
                        .set({
                            failureReason,
                            healthFailureCount: failures,
                            healthCheckNextAt: new Date(now.getTime() + retryInMs),
                            updatedAt: now
                        })
                        .where(
                            and(
                                eq(runtimeHosts.id, host.id),
                                eq(runtimeHosts.status, 'maintenance')
                            )
                        )
                        .returning({ id: runtimeHosts.id })
                    return stayed
                        ? { outcome: 'stayed', previousStatus, retryInMs }
                        : { outcome: 'recorded', previousStatus }
                }
                case 'none':
                    return transition.suppressed
                        ? {
                              outcome: 'suppressed',
                              previousStatus,
                              suppressed: transition.suppressed
                          }
                        : { outcome: 'recorded', previousStatus }
            }
        })
    }

    // A call that told us nothing changes nothing; a host in maintenance is
    // simply asked again on its current step.
    private async release(host: RuntimeHostRow, lease: Date): Promise<void> {
        const now = new Date()
        await this.db
            .update(runtimeHosts)
            .set({
                healthCheckLeaseUntil: null,
                ...(host.status === 'maintenance'
                    ? {
                          healthCheckNextAt: new Date(
                              now.getTime() +
                                  recheckDelayMs(null, host.healthFailureCount)
                          )
                      }
                    : {}),
                updatedAt: now
            })
            .where(
                and(
                    eq(runtimeHosts.id, host.id),
                    eq(runtimeHosts.healthCheckLeaseUntil, lease)
                )
            )
    }

    // A daemon that just connected on a sandbox in maintenance is worth a look
    // now rather than at its next step; only a healthy verdict lets it out.
    private async expedite(hostId: string): Promise<void> {
        try {
            await this.db
                .update(runtimeHosts)
                .set({ healthCheckNextAt: sql`clock_timestamp()` })
                .where(
                    and(
                        eq(runtimeHosts.id, hostId),
                        eq(runtimeHosts.status, 'maintenance'),
                        gt(runtimeHosts.healthCheckNextAt, sql`clock_timestamp()`)
                    )
                )
        } catch (err) {
            this.log.warn(
                `health re-check expedite failed hostId=${hostId}: ${(err as Error).message}`
            )
        }
    }

    private async announce(hostId: string): Promise<void> {
        try {
            await this.powerSync.announceHostState(hostId)
        } catch (err) {
            this.log.warn(
                `maintenance broadcast failed hostId=${hostId}: ${(err as Error).message}`
            )
        }
    }

    private async readHost(hostId: string): Promise<RuntimeHostRow | null> {
        const [row] = await this.db
            .select()
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, hostId))
            .limit(1)
        return row ?? null
    }

    private async daemonConnected(hostId: string): Promise<boolean> {
        const [daemon] = await this.db
            .select({
                rpcConnectedAt: hostDaemons.rpcConnectedAt,
                lastSeenAt: hostDaemons.lastSeenAt
            })
            .from(hostDaemons)
            .where(eq(hostDaemons.hostId, hostId))
            .limit(1)
        return daemonOnline(daemon ?? null)
    }

    private async acquireLeadership(): Promise<boolean> {
        if (!this.serviceLeases) return true
        let acquired = false
        try {
            acquired = await this.serviceLeases.tryAcquireOrRenew(
                LEASE_NAME,
                this.leaseHolderId,
                LEASE_TTL_MS
            )
        } catch (err) {
            // Fail closed: a skipped tick only delays a re-check.
            this.log.warn(
                `sandbox health lease check failed: ${(err as Error).message}`
            )
            return false
        }
        if (acquired !== this.isLeader) {
            this.isLeader = acquired
            this.log.log(
                `sandbox health leadership ${acquired ? 'acquired' : 'lost'} holder=${this.leaseHolderId}`
            )
        }
        return acquired
    }

    private hostAttrs(host: RuntimeHostRow): Record<string, string | null> {
        return {
            hostId: host.id,
            userId: host.userId,
            spriteName: providerRefLabel(host)
        }
    }
}

// Which hosts each kind of check may claim. An automatic check never takes a
// host a check of its kind looked at within its interval: the attempt time
// counts a failed call too, so a provider that keeps erroring is not hammered.
const claimableFor = (source: SandboxHealthCheckSource): SQL | undefined => {
    const config = sandboxHealthConfig()
    const notAttemptedWithin = (ms: number) =>
        or(
            isNull(runtimeHosts.healthCheckAttemptedAt),
            lte(
                runtimeHosts.healthCheckAttemptedAt,
                sql`clock_timestamp() - (${ms} * interval '1 millisecond')`
            )
        )
    switch (source) {
        case 'failure':
            return and(
                eq(runtimeHosts.status, 'ready'),
                notAttemptedWithin(config.failureIntervalMs)
            )
        case 'sweep':
            return and(
                eq(runtimeHosts.status, 'ready'),
                notAttemptedWithin(config.sweepIntervalMs)
            )
        case 'recheck':
            return and(
                eq(runtimeHosts.status, 'maintenance'),
                lte(runtimeHosts.healthCheckNextAt, sql`clock_timestamp()`)
            )
        case 'manual':
            return inArray(runtimeHosts.status, ['ready', 'maintenance'])
    }
}
