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
import {
    SpritesError,
    type ExecSessionInfo,
    type ListSpritesResponse,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { HostsService } from '@/modules/hosts/hosts.service'
import { RuntimeProvidersService } from '@/modules/hosts/runtime-providers.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { patchProviderRef } from '@/modules/hosts/providers/generation'
import { spritePowerState } from '@/modules/hosts/providers/sprites.provider'
import { podPowerState } from '@/modules/hosts/providers/k8s.provider'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'
import {
    derivePodPhase,
    fetchPodForHost
} from '@/modules/agents/sprite-status/k8s-pod-phase'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { SpriteStorageService } from '@/modules/agents/sprite-storage/sprite-storage.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import {
    hostedOnProviderKind,
    liveHostedHosts
} from '@/modules/runtime-access/runtime-usage-counts'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { HostedHostLifecycleService } from '@/modules/agent-runtimes/hosted-host-lifecycle.service'
import { k8sRef, spritesRef } from '@/modules/agent-runtimes/host-ref'
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
const SYNC_LEASE_NAME = 'sprite-status-sync'
const SYNC_LEASE_TTL_MS = 45_000
// A daemon heartbeats every 15s and a frozen VM sends none, so one heard this
// recently is running on its machine whatever the listing says. Seen on a
// local stack [2026-09-28]: sprites.dev reported a sprite `cold`, with no
// last_running_at, for minutes while its daemon kept heartbeating; every turn
// published `running` and the next pass flipped it back.
const HEARTBEAT_PROVES_RUNNING_MS = 20_000
// A sandbox with zero agents is deleted this long after it became empty
// (runtime_hosts.emptied_at). Empty-duration based — terminal activity does NOT
// reset it; only attaching an agent (which clears emptied_at) does.
const REAP_EMPTY_AGE_MS = 7 * 24 * 60 * 60_000
// How long a `deleting` row is left alone before the reaper retries its
// destroy: long enough for the delete that marked it to finish or fail.
const DELETING_RETRY_AGE_MS = 5 * 60_000
const REAPER_BATCH = 50
// Backstop for exec sessions nobody is attached to any more. sprites.dev keeps
// a session's process alive after the client socket goes away, so an exec that
// died without killing its session leaves the process running — and a live exec
// session pins the VM `running`, which bills active hours forever. Seen on prod
// [2026-09-03]: a free-plan sandbox burned 52h against a 5h quota over three
// days on two `cat` sessions left by one cancelled upload, and no other sweep
// could touch it (no agents, no runtimes, no services, no tasks).
const EXEC_SESSION_REAPER_INTERVAL_MS = 10 * 60_000
// Must stay clear of the longest legitimate exec. The turn watchdog's default
// ceiling is 2h (DEFAULT_TURN_MAX_DURATION_MS), so this leaves 3x headroom;
// widen it alongside MF_TURN_MAX_DURATION_MS if that is ever raised past 2h.
const EXEC_SESSION_MAX_IDLE_MS = 6 * 60 * 60_000
// sprites.dev reports "no activity recorded" as the zero time rather than
// omitting the field, and it is genuinely absent on some sprites — a session
// with no usable last_activity is aged from `created` instead.
const EXEC_SESSION_EPOCH_FLOOR_MS = Date.UTC(1971, 0, 1)

const hourFloor = (epochMs: number): number =>
    Math.floor(epochMs / 3_600_000) * 3_600_000

// Wake-up cadence — short so adaptive intervals can resolve quickly.
const WAKEUP_INTERVAL_MS = 1_500
// While any sprite in the provider is currently executing (running on
// sprites.dev), sample fast so we catch the running→suspended transition
// (~30–45s idle on Fly's side) promptly after a turn finishes.
const SPRITE_FAST_INTERVAL_MS = 3_000
// `suspended` (warm) is the long-tail idle state — Fly keeps the snapshot warm
// for hours or days; warm→cold is an unbounded host-eviction event with no
// public timeout. Polling fast there wastes API calls without changing the UX
// (both wake in <1s). Slow cadence backs off load and still catches a real
// eviction eventually.
const SPRITE_SLOW_INTERVAL_MS = 30_000
// K8s pod state changes are not bursty; a steady 10s cadence is fine.
const K8S_INTERVAL_MS = 10_000
// A pod host's bring-up runs in the API process that started it; one that
// restarted mid-way leaves the host provisioning forever. Far past the
// readiness timeout, it is failed so the user can delete it.
const POD_HOST_PROVISION_DEADLINE_MS = 30 * 60_000
const MAX_BACKOFF_MS = 5 * 60_000
// A sprite absent from one listing is indistinguishable from a transient
// control-plane inconsistency; require continuous absence for this window
// before paying the getSprite confirmation call.
const SPRITE_MISSING_CONFIRM_MS = 2 * 60_000
// Absence evidence older than this likely predates a sync blackout (process
// pause / provider backoff) — re-arm instead of confirming against a single
// fresh listing.
const SPRITE_MISSING_STALE_MS = 5 * SPRITE_MISSING_CONFIRM_MS
// createSprite → listing visibility may lag; freshly provisioned hosts never
// enter the missing-sprite window.
const SPRITE_PROVISION_GRACE_MS = 10 * 60_000

// running_limit / warm_limit are optional in the envelope; an older or partial
// vendor response must record "unknown" (null) rather than a bogus 0, which
// would clamp the org cap to zero and block every wake.
const vendorLimit = (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null

interface FailureState {
    count: number
    lastMessage: string
}

export interface AbandonedExecSession {
    session: ExecSessionInfo
    idleMs: number
}

// Last sign of life for an exec session. sprites.dev reports "no activity
// recorded" as the zero time and omits the field entirely on some sprites, so
// an unusable last_activity falls back to `created`; read literally, year 1
// would make every session look infinitely idle and reap live turns.
const execSessionLastSeenMs = (session: ExecSessionInfo): number | null => {
    const stamps = [session.last_activity, session.created]
        .map((raw) => (raw ? Date.parse(raw) : Number.NaN))
        .filter(
            (ms) => Number.isFinite(ms) && ms >= EXEC_SESSION_EPOCH_FLOOR_MS
        )
    return stamps.length > 0 ? Math.max(...stamps) : null
}

// Sessions sprites.dev still counts as active but that nothing has touched for
// longer than any legitimate exec. A session with no usable timestamp at all is
// deliberately left alone: with no age there is no evidence of abandonment, and
// killing a live turn is far worse than waiting for the next tick.
export const abandonedExecSessions = (
    sessions: readonly ExecSessionInfo[],
    now: number,
    maxIdleMs: number
): AbandonedExecSession[] => {
    const out: AbandonedExecSession[] = []
    for (const session of sessions) {
        if (session.is_active !== true) continue
        const lastSeen = execSessionLastSeenMs(session)
        if (lastSeen === null) continue
        const idleMs = now - lastSeen
        if (idleMs > maxIdleMs) out.push({ session, idleMs })
    }
    return out
}

// Only the argv head. The arguments carry user file paths — the leak that
// motivated this reaper was `cat > …/all_files 02.zip.mf-part` — while the
// binary name alone is what identifies which exec path leaked.
const execCommandHead = (command: string | undefined): string =>
    (command ?? '').trim().split(/\s+/)[0] || 'unknown'

const backoffMs = (count: number): number =>
    Math.min(SPRITE_SLOW_INTERVAL_MS * 2 ** Math.min(count, 5), MAX_BACKOFF_MS)

// Shared by the gone marker (write) and the revive scan (match) — the exact
// string is what scopes revival to our own failures.
export const spriteGoneReason = (spriteName: string): string =>
    `sprite ${spriteName} not found on sprites.dev`

const runningSpritesHosts = () =>
    and(liveHostedHosts('sprites'), eq(runtimeHosts.powerState, 'running'))

@Injectable()
export class SpriteStatusSyncService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(SpriteStatusSyncService.name)
    private timer: NodeJS.Timeout | null = null
    private stopWatchingConnects: (() => void) | null = null
    private inflight = false
    private readonly providerFailures = new Map<string, FailureState>()
    private readonly providerNextEligibleAt = new Map<string, number>()
    private readonly podHostFailures = new Map<string, FailureState>()
    private readonly podHostNextEligibleAt = new Map<string, number>()
    private readonly quotaNextEligibleAt = new Map<string, number>()
    // hostId → epoch ms of the first listing missing the host's VM. In-memory
    // only: a restart just restarts the confirmation window.
    private readonly hostSpriteMissingSince = new Map<string, number>()
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
        private readonly hostClients: HostProviderClients,
        private readonly broadcaster: SpriteStatusBroadcaster,
        private readonly telemetry: TelemetryService,
        private readonly spriteStorage: SpriteStorageService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly adminSettings: AdminSettingsService,
        private readonly keepAliveLease: SpriteKeepAliveLeaseService,
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
            await this.tickSprites()
            await this.tickKeepAliveReconcile()
            await this.tickReaper()
            await this.tickExecSessionReaper()
            await this.tickK8s()
            await this.tickQuotaWarnings()
            await this.tickSnapshot()
        } finally {
            this.inflight = false
        }
    }

    // Only the tick loop is leader-gated. On-demand paths — refreshSandboxHost
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
            await this.keepAliveLease.reconcileLeases()
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

    // Kill exec sessions nothing is attached to any more. Scoped to sandbox
    // hosts sprites.dev currently reports `running`: that is both the
    // population that bills active hours and the only one where a live session
    // can still be the thing holding the VM up. Note that SandboxesService.stop
    // cannot do this job — it only removes runtimes, services and tasks, so a
    // host with none of those (the prod case) has nothing it can pull, and
    // there is no vendor API to suspend a sprite outright.
    private async tickExecSessionReaper(): Promise<void> {
        const now = Date.now()
        if (now < this.nextExecSessionReaperAt) return
        this.nextExecSessionReaperAt = now + EXEC_SESSION_REAPER_INTERVAL_MS
        let hosts: RuntimeHostRow[]
        try {
            hosts = await this.db
                .select()
                .from(runtimeHosts)
                .where(runningSpritesHosts())
                .limit(REAPER_BATCH)
        } catch (err) {
            this.log.warn(
                `exec-session reaper scan failed: ${describeError(err)}`
            )
            return
        }
        for (const host of hosts) {
            const ref = spritesRef(host)
            if (!ref) continue
            try {
                await this.reapExecSessionsOnHost(host, ref.spriteName)
            } catch (err) {
                // A sprite the row still points at may already be gone; every
                // other failure is worth a line so a persistently unreapable
                // host is visible instead of silently billing.
                if (err instanceof SpritesError && err.code === 'not_found')
                    continue
                this.log.warn(
                    `exec-session reap failed for host ${host.id}: ${describeError(err)}`
                )
            }
        }
    }

    private async reapExecSessionsOnHost(
        host: RuntimeHostRow,
        spriteName: string
    ): Promise<void> {
        const provider = await this.hostClients.providerForHost(host)
        const client = this.clientFor(provider)
        const abandoned = abandonedExecSessions(
            await client.listExecSessions(spriteName),
            Date.now(),
            EXEC_SESSION_MAX_IDLE_MS
        )
        for (const { session, idleMs } of abandoned) {
            await client.killExecSession(spriteName, session.id)
            const command = execCommandHead(session.command)
            // warn, not log: each one is a session that got past the
            // client-side kill in @manyfold/sprites, so it wants to be findable
            this.log.warn(
                `killed abandoned exec session ${session.id} on ${spriteName} (host=${host.id} cmd=${command} idle=${Math.round(idleMs / 60_000)}m)`
            )
            this.telemetry.event('sprite_exec_session.reaped', {
                hostId: host.id,
                userId: host.userId,
                spriteName,
                sessionId: session.id,
                command,
                tty: session.tty === true,
                idleMs
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
                .where(runningSpritesHosts())
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

    private async tickSprites(): Promise<void> {
        const providerIds = await this.activeSpritesProviderIds()
        for (const providerId of providerIds) {
            const next = this.providerNextEligibleAt.get(providerId) ?? 0
            if (Date.now() < next) continue
            try {
                const hot = await this.syncProvider(providerId)
                this.providerFailures.delete(providerId)
                const interval = hot
                    ? SPRITE_FAST_INTERVAL_MS
                    : SPRITE_SLOW_INTERVAL_MS
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

    private async tickK8s(): Promise<void> {
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
                    hostedOnProviderKind('k8s'),
                    eq(runtimeHosts.status, 'provisioning'),
                    lte(
                        runtimeHosts.createdAt,
                        new Date(Date.now() - POD_HOST_PROVISION_DEADLINE_MS)
                    )
                )
            )
        const hosts = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'hosted'),
                    hostedOnProviderKind('k8s'),
                    eq(runtimeHosts.status, 'ready')
                )
            )
        for (const host of hosts) {
            const next = this.podHostNextEligibleAt.get(host.id) ?? 0
            if (Date.now() < next) continue
            try {
                await this.syncPodHost(host)
                this.podHostFailures.delete(host.id)
                this.podHostNextEligibleAt.set(
                    host.id,
                    Date.now() + K8S_INTERVAL_MS
                )
            } catch (err) {
                this.recordFailure(
                    'pod host',
                    host.id,
                    err,
                    this.podHostFailures,
                    this.podHostNextEligibleAt
                )
            }
        }
    }

    // Every sprites provider with a live host on it: a bare sandbox (zero
    // agents) still has a VM that needs status sync.
    private async activeSpritesProviderIds(): Promise<string[]> {
        const rows = await this.db
            .selectDistinct({ providerId: runtimeHosts.providerId })
            .from(runtimeHosts)
            .where(
                and(
                    liveHostedHosts('sprites'),
                    isNotNull(runtimeHosts.providerId)
                )
            )
        return rows
            .map((r) => r.providerId)
            .filter((id): id is string => typeof id === 'string')
    }

    /**
     * Returns true if any sprite on this provider is currently hot (running)
     * — used to decide whether the next tick for this provider should run on
     * the fast or slow cadence.
     */
    private async syncProvider(providerId: string): Promise<boolean> {
        const provider = await this.providers.findById(providerId)
        if (!provider || provider.kind !== 'sprites') return false

        const client = this.clientFor(provider)
        const list = await client.listSprites()
        if (!list) return false
        const byName = new Map<string, RuntimeHostPowerState>()
        const counts = { running: 0, warm: 0, cold: 0 }
        let anyHot = false
        for (const sprite of list.sprites) {
            const name = (sprite as { name?: unknown }).name
            if (typeof name !== 'string') continue
            const status = sprite.status
            byName.set(name, spritePowerState(status))
            if (status === 'running') counts.running += 1
            else if (status === 'warm') counts.warm += 1
            else if (status === 'cold') counts.cold += 1
            if (status === 'running') anyHot = true
        }
        await this.recordVendorCapacity(provider, list, counts)
        await this.syncHosts(client, provider.id, byName, new Date())
        return anyHot
    }

    /**
     * Mirror sprites.dev's own reported ceilings into app_settings so the org
     * cap admission enforces tracks the vendor instead of an admin hand-copying
     * the plan's numbers. Best-effort: this is observability plus a clamp input,
     * never a reason to fail a status sync.
     *
     * Usage is counted from the fully-paginated `list.sprites` rather than the
     * envelope's own running/warm/cold, which are PAGE-scoped (they describe the
     * ~50 rows in that response, not the account). Only running_limit/warm_limit
     * are account-level.
     */
    private async recordVendorCapacity(
        provider: RuntimeProvider,
        list: ListSpritesResponse,
        counts: { running: number; warm: number; cold: number }
    ): Promise<void> {
        const runningLimit = vendorLimit(list.running_limit)
        const warmLimit = vendorLimit(list.warm_limit)
        try {
            const wrote = await this.adminSettings.recordSpritesVendorCapacity(
                provider.id,
                {
                    slug: provider.name,
                    runningLimit,
                    warmLimit,
                    running: counts.running,
                    warm: counts.warm,
                    cold: counts.cold
                }
            )
            if (wrote)
                await this.emitWarmCapacityTelemetry(
                    provider,
                    warmLimit,
                    counts.warm
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

    // Host-level power writer (R4): the listing is mapped onto power_state,
    // the running interval is accrued, and every agent on the host hears
    // about the change. Nothing here touches runtime or agent rows. A host
    // failed by the gone marker is revived when its VM shows up again.
    private async syncHosts(
        client: SpritesClient,
        providerId: string,
        byName: Map<string, RuntimeHostPowerState>,
        now: Date
    ): Promise<void> {
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
        const heartbeating = await this.recentlyHeartbeating(hosts, now)
        const missing: RuntimeHostRow[] = []
        for (const host of hosts) {
            const ref = spritesRef(host)
            if (!ref) continue
            if (host.status === 'failed') {
                if (
                    host.failureReason === spriteGoneReason(ref.spriteName) &&
                    byName.has(ref.spriteName)
                )
                    await this.reviveHost(host, now)
                continue
            }
            if (!byName.has(ref.spriteName)) {
                // Sprite vanished from the listing: settle any open running
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
            this.hostSpriteMissingSince.delete(host.id)
            const listed = byName.get(ref.spriteName) ?? 'unknown'
            // Accrue before the unchanged-status short-circuit: a host that stays
            // `running` across samples writes no status change but must still
            // advance the watermark + credit the elapsed seconds. Metering
            // failure is contained per host: letting it throw would abort the
            // whole provider pass and freeze power_state for every other host
            // (phantom `running` rows then inflate the concurrency caps).
            try {
                await this.activeDuration.accrue(host, listed === 'running', now)
            } catch (err) {
                this.log.warn(
                    `active-duration accrue failed for host ${host.id}: ${describeError(err)}`
                )
            }
            // Metering follows the listing; the power state the product shows
            // and counts also takes the daemon's word for a machine it is on.
            const next =
                listed !== 'running' && heartbeating.has(host.id)
                    ? 'running'
                    : listed
            if (next === host.powerState) continue
            // Host-level so a bare sandbox (zero agents, still billed for its
            // rootfs) gets measured too.
            if (host.powerState === 'running' && next === 'suspended')
                await this.spriteStorage.measureHostIfDue(host.id, 'status_sync')
            await this.hosts.setPower(host.id, next)
            await this.broadcastPower(host, next, now)
        }
        if (missing.length > 0)
            await this.detectDeletedHosts(client, missing, now)
    }

    // Hosts whose VM is gone from the listing, after the same confirmation
    // window for agent-bearing and bare hosts alike. An empty host is deleted
    // through the host delete path; one with agents is `failed` with the gone
    // reason so its agents read as unavailable, and revives if the VM
    // reappears (a control-plane incident, a false positive).
    private async detectDeletedHosts(
        client: SpritesClient,
        hosts: RuntimeHostRow[],
        now: Date
    ): Promise<void> {
        for (const host of hosts) {
            const ref = spritesRef(host)
            if (!ref) continue
            if (
                now.getTime() - host.createdAt.getTime() <
                SPRITE_PROVISION_GRACE_MS
            ) {
                this.hostSpriteMissingSince.delete(host.id)
                continue
            }
            const firstMissedAt = this.hostSpriteMissingSince.get(host.id)
            if (firstMissedAt === undefined) {
                this.hostSpriteMissingSince.set(host.id, now.getTime())
                this.log.warn(
                    `sprite ${ref.spriteName} missing from provider listing (host=${host.id}); awaiting confirmation`
                )
                continue
            }
            if (now.getTime() - firstMissedAt >= SPRITE_MISSING_STALE_MS) {
                this.hostSpriteMissingSince.set(host.id, now.getTime())
                continue
            }
            if (now.getTime() - firstMissedAt < SPRITE_MISSING_CONFIRM_MS)
                continue
            try {
                // control-plane read; never wakes the VM
                await client.getSprite(ref.spriteName)
                this.hostSpriteMissingSince.delete(host.id)
            } catch (err) {
                if (err instanceof SpritesError && err.code === 'not_found') {
                    await this.markHostGone(host, ref.spriteName, now)
                    this.hostSpriteMissingSince.delete(host.id)
                } else {
                    // transient/auth: keep the window armed, retry next tick
                    this.log.warn(
                        `getSprite confirm failed for host ${host.id} (${ref.spriteName}): ${describeError(err)}`
                    )
                }
            }
        }
    }

    private async markHostGone(
        host: RuntimeHostRow,
        spriteName: string,
        now: Date
    ): Promise<void> {
        const reason = spriteGoneReason(spriteName)
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
                    `sandbox host ${host.id} VM ${spriteName} gone; removed empty host`
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
            `${reason}; marking host ${host.id} failed (${agentCount} agent(s))`
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
            spriteName,
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
            `sprite for host ${host.id} reappeared; reviving the host`
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

    // One pod per host (ADR-0035): its phase is the host's power, whichever
    // framework runtime an agent on it belongs to.
    private async syncPodHost(host: RuntimeHostRow): Promise<void> {
        const ref = k8sRef(host)
        if (!ref) return
        const client = await this.hostClients.k8sClientForHost(host)
        const pod = await fetchPodForHost(client, ref.namespace, host.id)
        const phase = derivePodPhase(pod)
        const now = new Date()
        if (phase !== ref.podPhase)
            await patchProviderRef(this.hosts, host.id, { podPhase: phase })
        const power = podPowerState(phase)
        if (power === host.powerState) return
        await this.hosts.setPower(host.id, power)
        await this.broadcastPower(host, power, now)
    }

    // The hosts whose daemon has heartbeated within HEARTBEAT_PROVES_RUNNING_MS.
    private async recentlyHeartbeating(
        hosts: Array<Pick<RuntimeHostRow, 'id'>>,
        now: Date
    ): Promise<Set<string>> {
        if (hosts.length === 0) return new Set()
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
        return new Set(
            rows
                .filter(
                    (row) =>
                        row.lastSeenAt !== null &&
                        now.getTime() - row.lastSeenAt.getTime() <
                            HEARTBEAT_PROVES_RUNNING_MS
                )
                .map((row) => row.hostId)
        )
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

    // Seam so tests can fake the sprites.dev control-plane client.
    protected clientFor(provider: RuntimeProvider): SpritesClient {
        return this.hostClients.spritesClientForProvider(provider, silentLogger)
    }

    private recordFailure(
        kind: 'provider' | 'pod host',
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

    // Force the provider's next sprite sync to fire on the upcoming wakeup,
    // overriding the slow/backoff cadence. Used by non-chat activity (terminal
    // open) so the running→suspended release is reconciled on the fast cadence
    // instead of up to 30s later. listSprites stays the source of truth.
    pokeProvider(providerId: string): void {
        this.providerNextEligibleAt.set(providerId, 0)
    }

    // On-demand single-host status refresh for the host detail "Refresh" button.
    // The periodic pass lags (up to 30s on the slow cadence), so we read this
    // one sprite directly. getSprite is a control-plane read that never wakes
    // the VM; the power is persisted on the host row so the caller's HTTP
    // response carries it, then the provider is poked so the periodic pass
    // reconciles co-resident agents + SSE on the very next tick.
    async refreshSandboxHost(
        host: RuntimeHostRow
    ): Promise<RuntimeHostPowerState | null> {
        const ref = spritesRef(host)
        if (host.kind !== 'hosted' || !ref || !host.providerId)
            return host.powerState
        const provider = await this.providers.findById(host.providerId)
        if (!provider) return host.powerState
        let state: RuntimeHostPowerState
        try {
            const sprite = await this.clientFor(provider).getSprite(
                ref.spriteName
            )
            state = spritePowerState(sprite.status)
        } catch (err) {
            // A vanished sprite is a teardown anomaly the periodic detector
            // owns; don't clobber the row here, just surface the last state.
            if (err instanceof SpritesError && err.code === 'not_found')
                return host.powerState
            throw err
        }
        const now = new Date()
        // Manual refresh is another direct host-power writer; accrue here too
        // so an interval that opened or closed between samples isn't lost.
        await this.activeDuration.accrue(host, state === 'running', now)
        // The periodic pass takes a fresh heartbeat over the listing; this
        // read has to agree with it, or the two would overwrite each other.
        if (
            state !== 'running' &&
            (await this.recentlyHeartbeating([host], now)).has(host.id)
        )
            state = 'running'
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

    // A turn or terminal on a sprites host is running: kick the provider onto
    // the fast cadence and publish `running` if the row hasn't caught up yet.
    // Always pokes (even when already `running`) so a stale slow cadence still
    // flips fast. Never rejects — callers fire-and-forget.
    async markHostRunning(hostId: string): Promise<void> {
        try {
            const host = await this.hosts.findById(hostId)
            if (!host || host.kind !== 'hosted' || !spritesRef(host)) return
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

const silentLogger: SpritesLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
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
