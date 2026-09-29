import { agentAvailability, daemonOnline } from '@manyfold/shared'
import type { QuotaWarningCode, RuntimeHostPowerState } from '@manyfold/shared'
import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    Optional
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, count, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    hostDaemons,
    runtimeHosts,
    spriteQuotaSnapshots,
    users,
    type Database,
    type RuntimeHostRow,
    type RuntimeProvider
} from '@manyfold/db'
import type { RuntimeProviderKind } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import { HostsService } from '@/modules/hosts/hosts.service'
import { RuntimeProvidersService } from '@/modules/hosts/runtime-providers.service'
import { HostProviderResolver } from '@/modules/hosts/providers/host-provider-resolver.service'
import type {
    ProviderCapacity,
    SandboxProvider
} from '@/modules/hosts/providers/sandbox-provider'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'
import { correctedPower } from '@/modules/agents/sprite-status/corrected-power'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    HostStorageService,
    storageMeasurementDue
} from '@/modules/agents/host-storage/host-storage.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import {
    hostedOnProviderKind,
    liveHostedHosts,
    runningHostedHosts
} from '@/modules/runtime-access/runtime-usage-counts'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { HostKeepAwakeService } from '@/modules/hosts/host-keep-awake.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { HostedHostLifecycleService } from '@/modules/agent-runtimes/hosted-host-lifecycle.service'
import { providerRefLabel } from '@/modules/agent-runtimes/host-ref'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { inBackgroundContext } from '@/common/telemetry/background-context'

const QUOTA_EVAL_INTERVAL_MS = 60_000
// The quota pass gets its own cadence: candidate discovery is a 4-table UNION
// and every eligible user needs metering reads, so riding the 1.5s wakeup
// multiplied idle DB load ~40x for a
// signal that only needs minute resolution (#615). Also covers the wholesale
// soft-cap COUNT at the tail of the same pass.
const QUOTA_TICK_INTERVAL_MS = 60_000
// Keep candidate discovery bounded to recent authenticated activity. This is
// only an evaluation filter: receipt ACKs, not session presence or local SSE
// subscriber counts, determine the 24h delivered-warning stamp.
const QUOTA_PRESENCE_WINDOW_MS = 15 * 60_000
const SNAPSHOT_INTERVAL_MS = 3_600_000
const KEEPALIVE_RECONCILE_INTERVAL_MS = 60_000
const REAPER_INTERVAL_MS = 5 * 60_000
// Single-leader gate for the whole sync loop: every machine used to run it,
// multiplying sprites.dev control-plane polling and racing the billing accrue
// watermark N ways. Renewal rides the 1.5s wakeup tick; a crashed or
// auto-stopped leader is taken over after the TTL (well inside the 30s slow
// cadence tolerance), and a clean shutdown releases immediately.
// Persisted: an instance on the previous release holds it by this name.
const SYNC_LEASE_NAME = 'sprite-status-sync'
const SYNC_LEASE_TTL_MS = 45_000
// A sandbox with zero agents is deleted this long after it became empty
// (runtime_hosts.emptied_at). Empty-duration based — terminal activity does NOT
// reset it; only attaching an agent (which clears emptied_at) does.
const REAP_EMPTY_AGE_MS = 7 * 24 * 60 * 60_000
// How long a `deleting` row is left alone before the reaper retries its
// destroy: long enough for the delete that marked it to finish or fail.
const DELETING_RETRY_AGE_MS = 5 * 60_000
const REAPER_BATCH = 50
// Backstop for provider-native exec sessions nobody is attached to any more:
// a live one pins the VM `running`, which bills active hours forever. Seen on
// prod [2026-09-03]: a free-plan sandbox burned 52h against a 5h quota over
// three days on two `cat` sessions left by one cancelled upload, and no other
// sweep could touch it (no agents, no runtimes, no services, no tasks).
const EXEC_SESSION_REAPER_INTERVAL_MS = 10 * 60_000
// Must stay clear of the longest legitimate exec. The turn watchdog's default
// ceiling is 2h (DEFAULT_TURN_MAX_DURATION_MS), so this leaves 3x headroom;
// widen it alongside MF_TURN_MAX_DURATION_MS if that is ever raised past 2h.
const EXEC_SESSION_MAX_IDLE_MS = 6 * 60 * 60_000

const hourFloor = (epochMs: number): number =>
    Math.floor(epochMs / 3_600_000) * 3_600_000

// Wake-up cadence — short so adaptive intervals can resolve quickly.
const WAKEUP_INTERVAL_MS = 1_500
// While any machine on an observed provider is running, sample fast so the
// running→suspended transition (~30–45s idle on Fly's side) is caught
// promptly after a turn finishes.
const OBSERVE_FAST_INTERVAL_MS = 3_000
// `suspended` (warm) is the long-tail idle state — Fly keeps the snapshot warm
// for hours or days; warm→cold is an unbounded host-eviction event with no
// public timeout. Polling fast there wastes API calls without changing the UX
// (both wake in <1s). Slow cadence backs off load and still catches a real
// eviction eventually.
const OBSERVE_SLOW_INTERVAL_MS = 30_000
// A provider without an account listing is asked per host; pod state changes
// are not bursty, so a steady 10s cadence is fine.
const POLL_INTERVAL_MS = 10_000
// A hosted host's bring-up runs in the API process that started it; one that
// restarted mid-way leaves the host provisioning forever. Far past the
// readiness timeout, it is failed so the user can delete it.
const HOST_PROVISION_DEADLINE_MS = 30 * 60_000
const MAX_BACKOFF_MS = 5 * 60_000
// A machine absent from one listing is indistinguishable from a transient
// control-plane inconsistency; require continuous absence for this window
// before paying the confirmation read.
const MACHINE_MISSING_CONFIRM_MS = 2 * 60_000
// Absence evidence older than this likely predates a sync blackout (process
// pause / provider backoff) — re-arm instead of confirming against a single
// fresh listing.
const MACHINE_MISSING_STALE_MS = 5 * MACHINE_MISSING_CONFIRM_MS
// Create → listing visibility may lag; freshly provisioned hosts never enter
// the missing-machine window.
const MACHINE_PROVISION_GRACE_MS = 10 * 60_000

interface FailureState {
    count: number
    lastMessage: string
}

const backoffMs = (count: number): number =>
    Math.min(OBSERVE_SLOW_INTERVAL_MS * 2 ** Math.min(count, 5), MAX_BACKOFF_MS)

// Shared by the gone marker (write) and the revive scan (match) — the exact
// string is what scopes revival to our own failures.
export const HOST_GONE_REASON = 'the machine is gone from its provider'

@Injectable()
export class HostPowerSyncService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(HostPowerSyncService.name)
    private timer: NodeJS.Timeout | null = null
    private stopWatchingConnects: (() => void) | null = null
    private inflight = false
    private readonly providerFailures = new Map<string, FailureState>()
    private readonly providerNextEligibleAt = new Map<string, number>()
    private readonly polledHostFailures = new Map<string, FailureState>()
    private readonly polledHostNextEligibleAt = new Map<string, number>()
    private readonly quotaNextEligibleAt = new Map<string, number>()
    // hostId → epoch ms of the first listing missing the host's machine.
    // In-memory only: a restart just restarts the confirmation window.
    private readonly hostMissingSince = new Map<string, number>()
    private nextSnapshotAt = 0
    private nextKeepAliveReconcileAt = 0
    private nextReaperAt = 0
    private nextExecSessionReaperAt = 0
    private nextQuotaWarningsAt = 0
    private readonly leaseHolderId =
        process.env.FLY_MACHINE_ID || process.env.HOSTNAME || randomUUID()
    private isLeader = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly providers: RuntimeProvidersService,
        private readonly hostProviders: HostProviderResolver,
        private readonly broadcaster: SpriteStatusBroadcaster,
        private readonly telemetry: TelemetryService,
        private readonly spriteStorage: HostStorageService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly adminSettings: AdminSettingsService,
        private readonly keepAwake: HostKeepAwakeService,
        private readonly activeDuration: SandboxActiveDurationService,
        private readonly lifecycle: HostedHostLifecycleService,
        @Optional() private readonly serviceLeases?: ServiceLeaseService,
        @Optional() private readonly daemonRegistry?: DaemonRegistryService
    ) {}

    onModuleInit(): void {
        this.watchDaemonConnects()
        this.timer = setInterval(inBackgroundContext(() => {
            void this.tick()
        }), WAKEUP_INTERVAL_MS)
        if (typeof this.timer.unref === 'function') this.timer.unref()
        setImmediate(inBackgroundContext(() => {
            void this.tick()
        }))
    }

    // A daemon that just connected proves its machine runs, and it lands
    // before the next provider poll does. Publishing `running` now keeps the
    // agent's availability and the concurrent-sandbox count, both keyed on the
    // power state, from lagging the wake.
    private watchDaemonConnects(): void {
        this.stopWatchingConnects =
            this.daemonRegistry?.onConnected((hostId) => {
                void this.markHostRunning(hostId)
            }) ?? null
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
                ?.release(SYNC_LEASE_NAME, this.leaseHolderId)
                .catch(() => undefined)
    }

    async tick(): Promise<void> {
        if (this.inflight) return
        this.inflight = true
        try {
            if (!(await this.acquireLeadership())) return
            await this.tickObserved()
            await this.tickKeepAliveReconcile()
            await this.tickReaper()
            await this.tickExecSessionReaper()
            await this.tickPolled()
            await this.tickQuotaWarnings()
            await this.tickSnapshot()
        } finally {
            this.inflight = false
        }
    }

    // Only the tick loop is leader-gated. On-demand paths — refreshHost
    // (the panel refresh button) and publishHostPower (chat-originated wakes)
    // — must keep working from any instance. Manually constructed instances
    // (tests) have no lease service and behave as the sole leader.
    private async acquireLeadership(): Promise<boolean> {
        if (!this.serviceLeases) return true
        let acquired = false
        try {
            acquired = await this.serviceLeases.tryAcquireOrRenew(
                SYNC_LEASE_NAME,
                this.leaseHolderId,
                SYNC_LEASE_TTL_MS
            )
        } catch (err) {
            // Fail closed: without a readable lease every instance pausing is
            // recoverable (status lags), while every instance polling would
            // reintroduce the N-way accrue race this lease exists to stop.
            this.log.warn(
                `sprite-status lease check failed: ${(err as Error).message}`
            )
            return false
        }
        if (acquired !== this.isLeader) {
            this.isLeader = acquired
            this.log.log(
                `sprite-status sync leadership ${acquired ? 'acquired' : 'lost'} holder=${this.leaseHolderId}`
            )
            this.telemetry.event('sprite_status.leader', {
                holderId: this.leaseHolderId,
                acquired
            })
        }
        return acquired
    }

    private async tickKeepAliveReconcile(): Promise<void> {
        const now = Date.now()
        if (now < this.nextKeepAliveReconcileAt) return
        this.nextKeepAliveReconcileAt = now + KEEPALIVE_RECONCILE_INTERVAL_MS
        try {
            await this.keepAwake.reconcile({
                headroom: () => this.runtimeAccess.spritesWholesaleHeadroom()
            })
        } catch (err) {
            this.log.warn(
                `keep-alive reconcile failed: ${(err as Error).message}`
            )
        }
    }

    // Delete sandboxes that have been agent-less past the idle window, and
    // retry hosts whose destroy never confirmed. Both go through the one host
    // delete path (R8), which re-confirms emptiness under the per-user lock.
    private async tickReaper(): Promise<void> {
        const now = Date.now()
        if (now < this.nextReaperAt) return
        this.nextReaperAt = now + REAPER_INTERVAL_MS
        const cutoff = new Date(now - REAP_EMPTY_AGE_MS)
        const deletingCutoff = new Date(now - DELETING_RETRY_AGE_MS)
        let candidates: Array<{ id: string; status: string }>
        try {
            candidates = await this.db
                .select({ id: runtimeHosts.id, status: runtimeHosts.status })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.kind, 'hosted'),
                        hostedOnProviderKind('sprites'),
                        or(
                            and(
                                eq(runtimeHosts.status, 'ready'),
                                isNotNull(runtimeHosts.emptiedAt),
                                lte(runtimeHosts.emptiedAt, cutoff)
                            ),
                            and(
                                eq(runtimeHosts.status, 'deleting'),
                                lte(runtimeHosts.updatedAt, deletingCutoff)
                            )
                        )
                    )
                )
                .limit(REAPER_BATCH)
        } catch (err) {
            this.log.warn(`reaper scan failed: ${describeError(err)}`)
            return
        }
        for (const c of candidates) {
            try {
                await this.lifecycle.deleteHost(c.id)
                this.log.warn(
                    `reaped ${c.status === 'deleting' ? 'stuck deleting' : 'empty'} sandbox host ${c.id}`
                )
            } catch (err) {
                // An agent attached since the scan: the host stays.
                if (err instanceof ConflictException) continue
                this.log.warn(
                    `reap failed for sandbox host ${c.id}: ${describeError(err)}`
                )
            }
        }
    }

    // End provider-native exec sessions nothing is attached to any more, on
    // hosts that are running: that is both the population that bills active
    // hours and the only one where a live session can still be the thing
    // holding the VM up. SandboxesService.stop cannot do this job — it only
    // removes runtimes, services and tasks, so a host with none of those (the
    // prod case) has nothing it can pull, and there is no vendor API to
    // suspend a sprite outright.
    private async tickExecSessionReaper(): Promise<void> {
        const now = Date.now()
        if (now < this.nextExecSessionReaperAt) return
        this.nextExecSessionReaperAt = now + EXEC_SESSION_REAPER_INTERVAL_MS
        for (const kind of this.kindsWith((a) => !!a.reapIdleSessions)) {
            let hosts: RuntimeHostRow[]
            try {
                hosts = await this.db
                    .select()
                    .from(runtimeHosts)
                    .where(runningHostedHosts(kind))
                    .limit(REAPER_BATCH)
            } catch (err) {
                this.log.warn(
                    `exec-session reaper scan failed: ${describeError(err)}`
                )
                return
            }
            for (const host of hosts) {
                try {
                    await this.reapExecSessionsOnHost(host)
                } catch (err) {
                    // Worth a line every time: a persistently unreapable host
                    // is visible instead of silently billing.
                    this.log.warn(
                        `exec-session reap failed for host ${host.id}: ${describeError(err)}`
                    )
                }
            }
        }
    }

    private async reapExecSessionsOnHost(host: RuntimeHostRow): Promise<void> {
        const { provider, adapter } = await this.hostProviders.resolve(host)
        const reaped =
            (await adapter.reapIdleSessions?.(
                { host, provider },
                { maxIdleMs: EXEC_SESSION_MAX_IDLE_MS }
            )) ?? []
        const machine = providerRefLabel(host)
        for (const session of reaped) {
            // warn, not log: each one is a session that got past the
            // client-side kill in the provider's own client, so it wants to be
            // findable
            this.log.warn(
                `killed abandoned exec session ${session.sessionId} on ${machine} (host=${host.id} cmd=${session.command}${session.tty ? ' tty' : ''} idle=${Math.round(session.idleMs / 60_000)}m)`
            )
            this.telemetry.event('sprite_exec_session.reaped', {
                hostId: host.id,
                userId: host.userId,
                spriteName: machine,
                sessionId: session.sessionId,
                command: session.command,
                tty: session.tty,
                idleMs: session.idleMs
            })
        }
    }

    private async tickQuotaWarnings(): Promise<void> {
        if (Date.now() < this.nextQuotaWarningsAt) return
        this.nextQuotaWarningsAt = Date.now() + QUOTA_TICK_INTERVAL_MS
        const userIds = await this.usersForQuotaEvaluation()
        const now = Date.now()
        for (const userId of userIds) {
            const next = this.quotaNextEligibleAt.get(userId) ?? 0
            if (now < next) continue
            this.quotaNextEligibleAt.set(userId, now + QUOTA_EVAL_INTERVAL_MS)
            try {
                const due =
                    await this.runtimeAccess.evaluateQuotaThresholds(userId)
                for (const ev of due) {
                    this.broadcaster.emitQuotaWarning(userId, {
                        type: 'quota-warning',
                        code: ev.code,
                        usage: ev.usage,
                        limit: ev.limit,
                        planName: ev.planName,
                        receiptId: ev.receiptId,
                        at: new Date().toISOString()
                    })
                }
            } catch (err) {
                this.log.warn(
                    `evaluateQuotaThresholds failed for user=${userId}: ${(err as Error).message}`
                )
            }
        }
        await this.tickWholesaleSoftWarning()
    }

    private async tickWholesaleSoftWarning(): Promise<void> {
        try {
            const cap =
                await this.adminSettings.getCachedSpritesEffectiveCap()
            // orgActive is per running sandbox VM (host-level power state), the
            // same grain as the hard cap in RuntimeAccessService
            // (reserveActiveSlot / spritesWholesaleHeadroom): a bare running
            // sandbox counts; co-resident agents share one VM and count once.
            const [row] = await this.db
                .select({ value: count() })
                .from(runtimeHosts)
                .where(runningHostedHosts('sprites'))
            const orgActive = Number(row?.value ?? 0)
            const softCap = Math.floor(
                (cap.activeCap * cap.softThresholdPct) / 100
            )
            if (orgActive < softCap) return
            const admins = await this.adminUserIds()
            const at = new Date().toISOString()
            for (const userId of admins) {
                this.broadcaster.emitQuotaWarning(
                    userId,
                    {
                        type: 'quota-warning',
                        code: 'wholesale_soft' satisfies QuotaWarningCode,
                        usage: orgActive,
                        limit: cap.activeCap,
                        planName: 'wholesale',
                        at
                    },
                    { adminOnly: true }
                )
            }
        } catch (err) {
            this.log.warn(
                `wholesale soft-cap evaluation failed: ${(err as Error).message}`
            )
        }
    }

    private async tickSnapshot(): Promise<void> {
        const now = Date.now()
        if (now < this.nextSnapshotAt) return
        this.nextSnapshotAt = hourFloor(now + SNAPSHOT_INTERVAL_MS)
        try {
            const counts = await this.spriteAggregateCounts()
            const at = new Date(hourFloor(now))
            await this.db
                .insert(spriteQuotaSnapshots)
                .values({
                    at,
                    orgActive: counts.running,
                    orgWarm: counts.warm,
                    orgCold: counts.cold,
                    orgProvisioned: counts.provisioned,
                    orgStorageBytes: counts.storageBytes
                })
                .onConflictDoNothing()
            await this.db
                .delete(spriteQuotaSnapshots)
                .where(
                    sql`${spriteQuotaSnapshots.at} < now() - interval '30 days'`
                )
            await this.activeDuration.pruneOlderThan(6)
        } catch (err) {
            this.log.warn(
                `sprite_quota_snapshots write failed: ${(err as Error).message}`
            )
        }
    }

    private async spriteAggregateCounts(): Promise<{
        running: number
        warm: number
        cold: number
        provisioned: number
        storageBytes: number
    }> {
        // Running/warm/cold are per sandbox VM (host-level power state) so a
        // bare sandbox counts; provisioned is every live sandbox host (incl.
        // agent-less). Storage is a host-level sum too (one whole-VM rootfs
        // reading per host — sprites.dev bills per VM). This hourly snapshot
        // feeds the timeseries charted beside the live (also per-host)
        // AdminSandboxQuotasService.overview() — the grains must match or the
        // chart contradicts the cards.
        const statusRows = await this.db
            .select({
                powerState: runtimeHosts.powerState,
                value: count()
            })
            .from(runtimeHosts)
            .where(liveHostedHosts('sprites'))
            .groupBy(runtimeHosts.powerState)
        let running = 0
        let warm = 0
        let cold = 0
        let provisioned = 0
        for (const r of statusRows) {
            const n = Number(r.value ?? 0)
            provisioned += n
            if (r.powerState === 'running') running = n
            else if (r.powerState === 'suspended') warm = n
            else if (r.powerState === 'stopped') cold = n
        }
        const [storageRow] = await this.db
            .select({
                storage: sql<number>`coalesce(sum(${runtimeHosts.storageBytes}), 0)::bigint`
            })
            .from(runtimeHosts)
            .where(liveHostedHosts('sprites'))
        const storageBytes = Number(storageRow?.storage ?? 0)
        return { running, warm, cold, provisioned, storageBytes }
    }

    // Everyone with a quota worth evaluating, not just sandbox owners. The
    // channel / automation / API-request warnings apply to users who may own no
    // sandbox at all, and gating on hosted hosts would silently never fire for
    // them — a warning that cannot reach its audience is worse than none,
    // because it reads as covered.
    // Recent authenticated activity bounds evaluation work; it is not proof
    // of an SSE subscriber. Pending receipts are stamped only by a client ACK.
    private async usersForQuotaEvaluation(): Promise<string[]> {
        const rows = (await this.db.execute(sql`
            select user_id from (
                select user_id from runtime_hosts where kind = 'hosted'
                union
                select user_id from channels
                union
                select user_id from automations where deleted_at is null
                union
                -- 62 days is a guaranteed superset of any monthly billing
                -- period, which can start mid-month; the real window is
                -- resolved per user inside evaluateQuotaThresholds.
                select user_id from user_api_usage_days
                where day >= to_char(now() - interval '62 days', 'YYYY-MM-DD')
            ) candidates
            where user_id is not null
              and exists (
                select 1 from user_sessions s
                where s.user_id = candidates.user_id
                  and s.revoked_at is null
                  and s.expires_at > now()
                  and s.last_used_at >= now() -
                      (${QUOTA_PRESENCE_WINDOW_MS} * interval '1 millisecond')
              )
        `)) as unknown as Array<{ user_id: string | null }>
        return rows
            .map((r) => r.user_id)
            .filter((v): v is string => Boolean(v))
    }

    private async adminUserIds(): Promise<string[]> {
        const rows = await this.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.role, 'admin'))
        return rows.map((r) => r.id)
    }

    // The adapter kinds with a capability, for the passes that only apply to
    // providers offering it.
    private kindsWith(
        has: (adapter: SandboxProvider) => boolean
    ): RuntimeProviderKind[] {
        return this.hostProviders
            .adapters()
            .filter(has)
            .map((adapter) => adapter.kind)
    }

    private async tickObserved(): Promise<void> {
        const providerIds = await this.observedProviderIds()
        for (const providerId of providerIds) {
            const next = this.providerNextEligibleAt.get(providerId) ?? 0
            if (Date.now() < next) continue
            try {
                const hot = await this.syncProvider(providerId)
                this.providerFailures.delete(providerId)
                const interval = hot
                    ? OBSERVE_FAST_INTERVAL_MS
                    : OBSERVE_SLOW_INTERVAL_MS
                this.providerNextEligibleAt.set(
                    providerId,
                    Date.now() + interval
                )
            } catch (err) {
                this.recordFailure(
                    'provider',
                    providerId,
                    err,
                    this.providerFailures,
                    this.providerNextEligibleAt
                )
            }
        }
    }

    // Providers without an account listing: one power read per ready host.
    private async tickPolled(): Promise<void> {
        await this.db
            .update(runtimeHosts)
            .set({
                status: 'failed',
                failureReason: 'provisioning did not finish',
                updatedAt: new Date()
            })
            .where(
                and(
                    eq(runtimeHosts.kind, 'hosted'),
                    eq(runtimeHosts.status, 'provisioning'),
                    lte(
                        runtimeHosts.createdAt,
                        new Date(Date.now() - HOST_PROVISION_DEADLINE_MS)
                    )
                )
            )
        for (const kind of this.kindsWith((a) => !a.observe)) {
            const hosts = await this.db
                .select()
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.kind, 'hosted'),
                        hostedOnProviderKind(kind),
                        eq(runtimeHosts.status, 'ready')
                    )
                )
            for (const host of hosts) {
                const next = this.polledHostNextEligibleAt.get(host.id) ?? 0
                if (Date.now() < next) continue
                try {
                    await this.syncPolledHost(host)
                    this.polledHostFailures.delete(host.id)
                    this.polledHostNextEligibleAt.set(
                        host.id,
                        Date.now() + POLL_INTERVAL_MS
                    )
                } catch (err) {
                    this.recordFailure(
                        'host',
                        host.id,
                        err,
                        this.polledHostFailures,
                        this.polledHostNextEligibleAt
                    )
                }
            }
        }
    }

    // Every provider with an account listing and a live host on it: a bare
    // sandbox (zero agents) still has a VM that needs status sync.
    private async observedProviderIds(): Promise<string[]> {
        const ids: string[] = []
        for (const kind of this.kindsWith((a) => !!a.observe)) {
            const rows = await this.db
                .selectDistinct({ providerId: runtimeHosts.providerId })
                .from(runtimeHosts)
                .where(
                    and(
                        liveHostedHosts(kind),
                        isNotNull(runtimeHosts.providerId)
                    )
                )
            for (const row of rows)
                if (typeof row.providerId === 'string') ids.push(row.providerId)
        }
        return ids
    }

    /**
     * Returns true if any machine on this provider is currently hot — listed
     * running, or held running by its daemon — used to decide whether the
     * next tick for this provider should run on the fast or slow cadence. A
     * host the daemon holds running is sampled fast too, so the hold ends
     * within a tick of its daemon going quiet rather than a slow tick later.
     */
    private async syncProvider(providerId: string): Promise<boolean> {
        const provider = await this.providers.findById(providerId)
        if (!provider) return false
        const adapter = this.hostProviders.adapterFor(provider)
        if (!adapter.observe) return false
        const hosts = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.providerId, providerId),
                    eq(runtimeHosts.kind, 'hosted'),
                    inArray(runtimeHosts.status, ['ready', 'failed'])
                )
            )
        const seen = await adapter.observe({ provider, hosts })
        if (seen.capacity)
            await this.recordVendorCapacity(provider, seen.capacity)
        const anyHostRunning = await this.syncHosts(
            provider,
            adapter,
            hosts,
            seen.power,
            new Date()
        )
        return (seen.capacity?.running ?? 0) > 0 || anyHostRunning
    }

    /**
     * Mirror the provider's own reported ceilings into app_settings so the org
     * cap admission enforces tracks the vendor instead of an admin hand-copying
     * the plan's numbers. Best-effort: this is observability plus a clamp input,
     * never a reason to fail a status sync.
     */
    private async recordVendorCapacity(
        provider: RuntimeProvider,
        capacity: ProviderCapacity
    ): Promise<void> {
        try {
            const wrote = await this.adminSettings.recordSpritesVendorCapacity(
                provider.id,
                {
                    slug: provider.name,
                    runningLimit: capacity.runningLimit,
                    warmLimit: capacity.suspendedLimit,
                    running: capacity.running,
                    warm: capacity.suspended,
                    cold: capacity.stopped
                }
            )
            if (wrote)
                await this.emitWarmCapacityTelemetry(
                    provider,
                    capacity.suspendedLimit,
                    capacity.suspended
                )
        } catch (err) {
            this.log.warn(
                `vendor capacity record failed for provider=${provider.name}: ${(err as Error).message}`
            )
        }
    }

    // Warm is a SECOND vendor ceiling (warm_limit) that nothing in admission
    // counts against — a warm sprite holds a slot without being `running`.
    // Observation only for now: breaching it surfaces here and in the admin
    // capacity panel, it does not reject anything. Rate is bounded by the
    // caller, which only reaches this when an observation actually changed (or
    // every VENDOR_CAPS_REFRESH_MS while it sits pinned).
    private async emitWarmCapacityTelemetry(
        provider: RuntimeProvider,
        warmLimit: number | null,
        warm: number
    ): Promise<void> {
        if (warmLimit === null || warmLimit <= 0) return
        const { softThresholdPct } =
            await this.adminSettings.getCachedSpritesWholesaleCap()
        const softCap = Math.floor((warmLimit * softThresholdPct) / 100)
        const attrs = {
            accountSlug: provider.name,
            warm,
            warmLimit,
            softCap,
            blocking: false
        }
        if (warm >= warmLimit)
            this.telemetry.event('wholesale_warm_at_limit', attrs)
        else if (warm >= softCap)
            this.telemetry.event('wholesale_warm_soft_cap', attrs)
    }

    // Host-level power writer (R4): the listing, corrected by the daemon's
    // heartbeat, becomes power_state, the running interval is accrued from
    // that same value, and every agent on the host hears about the change.
    // Nothing here touches runtime or agent rows. A host failed by the gone
    // marker is revived when its VM shows up again. True when any host is now
    // running.
    private async syncHosts(
        provider: RuntimeProvider,
        adapter: SandboxProvider,
        hosts: RuntimeHostRow[],
        listedPower: Map<string, RuntimeHostPowerState>,
        now: Date
    ): Promise<boolean> {
        const heartbeats = await this.lastHeartbeats(hosts)
        const missing: RuntimeHostRow[] = []
        let anyRunning = false
        for (const host of hosts) {
            // Not made yet: nothing to list.
            if (!host.providerRef) continue
            if (host.status === 'failed') {
                if (
                    host.failureReason === HOST_GONE_REASON &&
                    listedPower.has(host.id)
                )
                    await this.reviveHost(host, now)
                continue
            }
            const listed = listedPower.get(host.id)
            if (!listed) {
                // Machine vanished from the listing: settle any open running
                // interval now so the dangling watermark can't mis-accrue if the
                // VM reappears, then hand off to the deleted-host detector.
                if (host.activeAccrualSince)
                    await this.activeDuration.settleHostNotRunning(
                        host.id,
                        host.userId,
                        now
                    )
                missing.push(host)
                continue
            }
            this.hostMissingSince.delete(host.id)
            const next = correctedPower({
                listed,
                heartbeatAt: heartbeats.get(host.id) ?? null,
                now
            })
            if (next === 'running') anyRunning = true
            // Accrue before the unchanged-status short-circuit: a host that stays
            // `running` across samples writes no status change but must still
            // advance the watermark + credit the elapsed seconds. Metering
            // failure is contained per host: letting it throw would abort the
            // whole provider pass and freeze power_state for every other host
            // (phantom `running` rows then inflate the concurrency caps).
            try {
                await this.activeDuration.accrue(host, next === 'running', now)
            } catch (err) {
                this.log.warn(
                    `active-duration accrue failed for host ${host.id}: ${describeError(err)}`
                )
            }
            // Host-level so a bare sandbox (zero agents, still billed for its
            // rootfs) gets measured too — while it is up, on its own interval:
            // measuring it as it went to sleep woke it straight back up.
            // Seen on local [2026-09-28]: the measurement after a sandbox
            // suspended ran an exec that resumed it.
            if (next === 'running' && storageMeasurementDue(host, now.getTime()))
                void this.spriteStorage.measureHostIfDue(host.id, 'status_sync')
            if (next === host.powerState) continue
            await this.hosts.setPower(host.id, next)
            await this.broadcastPower(host, next, now)
        }
        if (missing.length > 0)
            await this.detectDeletedHosts(provider, adapter, missing, now)
        return anyRunning
    }

    // Hosts whose machine is gone from the listing, after the same
    // confirmation window for agent-bearing and bare hosts alike. An empty host
    // is deleted through the host delete path; one with agents is `failed`
    // with the gone reason so its agents read as unavailable, and revives if
    // the machine reappears (a control-plane incident, a false positive).
    private async detectDeletedHosts(
        provider: RuntimeProvider,
        adapter: SandboxProvider,
        hosts: RuntimeHostRow[],
        now: Date
    ): Promise<void> {
        for (const host of hosts) {
            const machine = providerRefLabel(host)
            if (
                now.getTime() - host.createdAt.getTime() <
                MACHINE_PROVISION_GRACE_MS
            ) {
                this.hostMissingSince.delete(host.id)
                continue
            }
            const firstMissedAt = this.hostMissingSince.get(host.id)
            if (firstMissedAt === undefined) {
                this.hostMissingSince.set(host.id, now.getTime())
                this.log.warn(
                    `machine ${machine} missing from provider listing (host=${host.id}); awaiting confirmation`
                )
                continue
            }
            if (now.getTime() - firstMissedAt >= MACHINE_MISSING_STALE_MS) {
                this.hostMissingSince.set(host.id, now.getTime())
                continue
            }
            if (now.getTime() - firstMissedAt < MACHINE_MISSING_CONFIRM_MS)
                continue
            try {
                // control-plane read; never wakes the machine
                const power = await adapter.power({ host, provider })
                if (power === 'gone') await this.markHostGone(host, now)
                this.hostMissingSince.delete(host.id)
            } catch (err) {
                // transient/auth: keep the window armed, retry next tick
                this.log.warn(
                    `gone confirmation failed for host ${host.id} (${machine}): ${describeError(err)}`
                )
            }
        }
    }

    private async markHostGone(
        host: RuntimeHostRow,
        now: Date
    ): Promise<void> {
        const reason = HOST_GONE_REASON
        const machine = providerRefLabel(host)
        const [agentRow] = await this.db
            .select({ value: count() })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .where(eq(agentRuntimes.hostId, host.id))
        const agentCount = Number(agentRow?.value ?? 0)
        if (agentCount === 0) {
            try {
                await this.lifecycle.deleteHost(host.id)
                this.log.warn(
                    `sandbox host ${host.id} machine ${machine} gone; removed empty host`
                )
            } catch (err) {
                this.log.warn(
                    `delete of gone sandbox host ${host.id} failed: ${describeError(err)}`
                )
            }
            return
        }
        // status guard + returning: with several API instances only the
        // winner emits events.
        const won = await this.db
            .update(runtimeHosts)
            .set({
                status: 'failed',
                failureReason: reason,
                powerState: 'unknown',
                updatedAt: now
            })
            .where(
                and(eq(runtimeHosts.id, host.id), eq(runtimeHosts.status, 'ready'))
            )
            .returning({ id: runtimeHosts.id })
        if (won.length === 0) return
        this.log.warn(
            `machine ${machine} gone from its provider; marking host ${host.id} failed (${agentCount} agent(s))`
        )
        await this.broadcastPower(
            { ...host, status: 'failed', failureReason: reason },
            'unknown',
            now
        )
        this.telemetry.event('host.sprite_deleted', {
            hostId: host.id,
            userId: host.userId,
            providerId: host.providerId,
            spriteName: machine,
            agentCount
        })
    }

    // Symmetric recovery: the VM showed up in the listing again, so the host
    // is usable and exactly what the gone marker took away comes back.
    private async reviveHost(host: RuntimeHostRow, now: Date): Promise<void> {
        const won = await this.db
            .update(runtimeHosts)
            .set({ status: 'ready', failureReason: null, updatedAt: now })
            .where(
                and(
                    eq(runtimeHosts.id, host.id),
                    eq(runtimeHosts.status, 'failed'),
                    eq(runtimeHosts.failureReason, host.failureReason ?? '')
                )
            )
            .returning({ id: runtimeHosts.id })
        if (won.length === 0) return
        this.log.warn(
            `machine for host ${host.id} reappeared; reviving the host`
        )
        this.telemetry.event('host.sprite_restored', {
            hostId: host.id,
            userId: host.userId,
            providerId: host.providerId
        })
        await this.broadcastPower(
            { ...host, status: 'ready', failureReason: null },
            host.powerState ?? 'unknown',
            now
        )
    }

    private async syncPolledHost(host: RuntimeHostRow): Promise<void> {
        if (!host.providerRef) return
        const { provider, adapter } = await this.hostProviders.resolve(host)
        const power = await adapter.power({ host, provider })
        if (power === 'gone' || power === host.powerState) return
        await this.hosts.setPower(host.id, power)
        await this.broadcastPower(host, power, new Date())
    }

    // Each host's last daemon heartbeat, for correctedPower; a host whose
    // daemon never heartbeated is absent.
    private async lastHeartbeats(
        hosts: Array<Pick<RuntimeHostRow, 'id'>>
    ): Promise<Map<string, Date>> {
        if (hosts.length === 0) return new Map()
        const rows = await this.db
            .select({
                hostId: hostDaemons.hostId,
                lastSeenAt: hostDaemons.lastSeenAt
            })
            .from(hostDaemons)
            .where(
                inArray(
                    hostDaemons.hostId,
                    hosts.map((host) => host.id)
                )
            )
        const heartbeats = new Map<string, Date>()
        for (const row of rows)
            if (row.lastSeenAt) heartbeats.set(row.hostId, row.lastSeenAt)
        return heartbeats
    }

    // The host's own event plus one per agent on it, with the availability
    // each client would otherwise re-derive.
    private async broadcastPower(
        host: RuntimeHostRow,
        powerState: RuntimeHostPowerState,
        now: Date
    ): Promise<void> {
        const rows = await this.db
            .select({
                agent: agents,
                runtime: agentRuntimes,
                daemon: hostDaemons
            })
            .from(agentRuntimes)
            .innerJoin(agents, eq(agents.runtimeId, agentRuntimes.id))
            .leftJoin(hostDaemons, eq(hostDaemons.hostId, agentRuntimes.hostId))
            .where(eq(agentRuntimes.hostId, host.id))
        const online = daemonOnline(rows[0]?.daemon ?? null, now.getTime())
        this.broadcaster.emitHostUpdate(host.userId, {
            hostId: host.id,
            powerState,
            daemonOnline: online,
            at: now.toISOString()
        })
        for (const row of rows) {
            this.broadcaster.emit(row.agent.userId, {
                agentId: row.agent.id,
                hostId: host.id,
                powerState,
                availability: agentAvailability({
                    agent: row.agent,
                    runtime: row.runtime,
                    // The row predates the write this broadcast announces.
                    host: { ...host, powerState },
                    daemonOnline: online
                }),
                at: now.toISOString()
            })
        }
    }

    private recordFailure(
        kind: 'provider' | 'host',
        key: string,
        err: unknown,
        failures: Map<string, FailureState>,
        nextEligibleAt: Map<string, number>
    ): void {
        const message = describeError(err)
        const prev = failures.get(key)
        const next: FailureState = {
            count: (prev?.count ?? 0) + 1,
            lastMessage: message
        }
        failures.set(key, next)
        const wait = backoffMs(next.count)
        nextEligibleAt.set(key, Date.now() + wait)
        const line = `runtime-status sync failed ${kind}=${key} (attempt ${next.count}, next try in ${wait}ms): ${message}`
        if (prev && prev.lastMessage === message) this.log.debug(line)
        else this.log.warn(line)
    }

    /**
     * Publish a host power change outside the periodic tick (a chat or
     * terminal wake). Opens the accrual watermark the instant `running` is
     * published so a short turn that is back to suspended before the next
     * sample still credits from its start; the periodic pass settles it when
     * the VM goes idle. When the host is now hot, its provider's next tick
     * fires immediately so the release is seen on the fast cadence.
     */
    async publishHostPower(
        host: Pick<RuntimeHostRow, 'id' | 'userId' | 'providerId'>,
        state: RuntimeHostPowerState
    ): Promise<void> {
        this.log.log(
            `publishHostPower hostId=${host.id} userId=${host.userId} state=${state}`
        )
        const now = new Date()
        const [updated] = await this.db
            .update(runtimeHosts)
            .set({
                powerState: state,
                powerChangedAt: sql`case when ${runtimeHosts.powerState} is distinct from ${state} then ${now.toISOString()}::timestamptz else ${runtimeHosts.powerChangedAt} end`,
                // ms-precision ISO string, NOT a raw Date: postgres-js crashes
                // binding a JS Date interpolated into a sql`` fragment.
                ...(state === 'running'
                    ? {
                          activeAccrualSince: sql`coalesce(${runtimeHosts.activeAccrualSince}, ${now.toISOString()}::timestamptz)`
                      }
                    : {}),
                updatedAt: now
            })
            .where(
                and(eq(runtimeHosts.id, host.id), eq(runtimeHosts.kind, 'hosted'))
            )
            .returning()
        if (!updated) return
        await this.broadcastPower(updated, state, now)
        if (state === 'running' && host.providerId)
            this.pokeProvider(host.providerId)
    }

    // Force the provider's next observation to fire on the upcoming wakeup,
    // overriding the slow/backoff cadence. Used by non-chat activity (terminal
    // open) so the running→suspended release is reconciled on the fast cadence
    // instead of up to 30s later. The listing stays the source of truth.
    pokeProvider(providerId: string): void {
        this.providerNextEligibleAt.set(providerId, 0)
    }

    // On-demand single-host status refresh for the host detail "Refresh"
    // button. The periodic pass lags (up to 30s on the slow cadence), so this
    // one machine is read directly — a control-plane read that never wakes
    // it; the power is persisted on the host row so the caller's HTTP response
    // carries it, then the provider is poked so the periodic pass reconciles
    // co-resident agents + SSE on the very next tick.
    async refreshHost(
        host: RuntimeHostRow
    ): Promise<RuntimeHostPowerState | null> {
        if (host.kind !== 'hosted' || !host.providerRef || !host.providerId)
            return host.powerState
        const { provider, adapter } = await this.hostProviders.resolve(host)
        const listed = await adapter.power({ host, provider })
        // A vanished machine is a teardown anomaly the periodic detector owns;
        // don't clobber the row here, just surface the last state.
        if (listed === 'gone') return host.powerState
        const now = new Date()
        // A machine that suspends is metered by its running time: corrected
        // the same way the periodic pass corrects it, or the two writers would
        // overwrite each other, and accrued here too, so an interval that
        // opened or closed between samples isn't lost.
        const metered = adapter.capabilities.suspend
        const state = metered
            ? correctedPower({
                  listed,
                  heartbeatAt:
                      (await this.lastHeartbeats([host])).get(host.id) ?? null,
                  now
              })
            : listed
        if (metered)
            await this.activeDuration.accrue(host, state === 'running', now)
        if (state !== host.powerState) {
            await this.hosts.setPower(host.id, state)
            // Persisting here makes the poked periodic pass see the state as
            // unchanged and skip its emit — broadcast now or other open clients
            // never hear about this transition.
            await this.broadcastPower(host, state, now)
        }
        this.pokeProvider(host.providerId)
        return state
    }

    // A turn or terminal on a machine that suspends is running: kick the
    // provider onto the fast cadence and publish `running` if the row hasn't
    // caught up yet. Always pokes (even when already `running`) so a stale slow
    // cadence still flips fast. Never rejects — callers fire-and-forget.
    async markHostRunning(hostId: string): Promise<void> {
        try {
            const host = await this.hosts.findById(hostId)
            if (!host || host.kind !== 'hosted' || !host.providerRef) return
            const { adapter } = await this.hostProviders.resolve(host)
            if (!adapter.capabilities.suspend) return
            if (host.providerId) this.pokeProvider(host.providerId)
            if (host.powerState !== 'running')
                await this.publishHostPower(host, 'running')
        } catch (err) {
            this.log.warn(
                `markHostRunning failed hostId=${hostId}: ${(err as Error).message}`
            )
        }
    }
}

const describeError = (err: unknown): string => {
    if (err instanceof Error) return err.message || err.name || 'Error'
    if (err && typeof err === 'object') {
        const obj = err as Record<string, unknown>
        const reason = typeof obj.message === 'string' ? obj.message : null
        const code = obj.statusCode ?? obj.code
        const parts = [
            reason,
            code !== undefined ? `(code ${String(code)})` : null
        ].filter(Boolean)
        if (parts.length) return parts.join(' ')
        try {
            return JSON.stringify(err)
        } catch {
            return String(err)
        }
    }
    return String(err)
}
