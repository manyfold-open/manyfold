import type {
    QuotaWarningCode,
    SpriteStatus
} from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    Optional
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, count, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    runtimeHosts,
    spriteQuotaSnapshots,
    users,
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow,
    type SpritesAccount
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    SpritesError,
    type ExecSessionInfo,
    type ListSpritesResponse,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'
import {
    derivePodPhase,
    fetchPodForRuntime
} from '@/modules/agents/sprite-status/k8s-pod-phase'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { SpriteStorageService } from '@/modules/agents/sprite-storage/sprite-storage.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'

const QUOTA_EVAL_INTERVAL_MS = 60_000
// The quota pass gets its own cadence: candidate discovery is a 4-table UNION
// and every eligible user costs the full runtime-access summary chain (~14
// queries), so riding the 1.5s wakeup multiplied idle DB load ~40x for a
// signal that only needs minute resolution (#615). Also covers the wholesale
// soft-cap COUNT at the tail of the same pass.
const QUOTA_TICK_INTERVAL_MS = 60_000
// Quota warnings are SSE-only and never persisted: emitting to a user with no
// live session delivers nothing AND burns the 24h lastQuotaWarningsAt stamp,
// suppressing the copy they would actually see after returning. Only users
// with a session used inside this window are evaluated; sliding session
// renewal touches last_used_at on every authenticated request, so returning
// users are picked up within a tick or two (#615).
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
// A sandbox with zero agents is deleted this long after it became empty
// (runtime_hosts.emptied_at). Empty-duration based — terminal activity does NOT
// reset it; only attaching an agent (which clears emptied_at) does.
const REAP_EMPTY_AGE_MS = 7 * 24 * 60 * 60_000
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
// While any sprite in the account is currently executing (running on
// sprites.dev), sample fast so we catch the running→warm transition
// (~30–45s idle on Fly's side) promptly after a turn finishes.
const SPRITE_FAST_INTERVAL_MS = 3_000
// `warm` is the long-tail idle state — Fly keeps the snapshot warm for hours
// or days; `warm→cold` is an unbounded host-eviction event with no public
// timeout. Polling fast while warm wastes API calls without changing the UX
// (warm and cold both wake in <1s, so they're functionally identical to the
// user). Slow cadence here both backs off load and is sufficient to
// eventually catch a real eviction.
const SPRITE_SLOW_INTERVAL_MS = 30_000
// K8s pod state changes are not bursty; a steady 10s cadence is fine.
const K8S_INTERVAL_MS = 10_000
const MAX_BACKOFF_MS = 5 * 60_000
// A sprite absent from one listing is indistinguishable from a transient
// control-plane inconsistency; require continuous absence for this window
// before paying the getSprite confirmation call.
const SPRITE_MISSING_CONFIRM_MS = 2 * 60_000
// Absence evidence older than this likely predates a sync blackout (process
// pause / account backoff) — re-arm instead of confirming against a single
// fresh listing. Mirrors ORPHAN_STALE_MS in agent-reconcile.
const SPRITE_MISSING_STALE_MS = 5 * SPRITE_MISSING_CONFIRM_MS
// createSprite → listing visibility may lag; freshly provisioned runtimes
// never enter the missing-sprite window.
const SPRITE_PROVISION_GRACE_MS = 10 * 60_000

const VALID_STATUSES = new Set<SpriteStatus>(['cold', 'warm', 'running'])

const normalizeStatus = (raw: unknown): SpriteStatus | null => {
    if (typeof raw !== 'string') return null
    return VALID_STATUSES.has(raw as SpriteStatus)
        ? (raw as SpriteStatus)
        : null
}

// Only `running` (actively executing on sprites.dev) is "hot" — `warm` is the
// idle steady state and using slow cadence there is correct. See the comment
// on SPRITE_SLOW_INTERVAL_MS above.
const isHotSpriteStatus = (s: SpriteStatus | null): boolean => s === 'running'

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

@Injectable()
export class SpriteStatusSyncService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(SpriteStatusSyncService.name)
    private timer: NodeJS.Timeout | null = null
    private inflight = false
    private readonly accountFailures = new Map<string, FailureState>()
    private readonly accountNextEligibleAt = new Map<string, number>()
    private readonly runtimeFailures = new Map<string, FailureState>()
    private readonly runtimeNextEligibleAt = new Map<string, number>()
    private readonly readyEmitted = new Set<string>()
    private readonly quotaNextEligibleAt = new Map<string, number>()
    // runtimeId → epoch ms of the first listing missing the runtime's sprite.
    // In-memory only: a restart just restarts the confirmation window.
    private readonly spriteMissingSince = new Map<string, number>()
    // hostId → epoch ms of first listing missing an agent-less sandbox host's
    // VM. In-memory; a restart re-arms the window.
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
        private readonly accounts: SpritesAccountsService,
        private readonly k8s: KubernetesService,
        private readonly broadcaster: SpriteStatusBroadcaster,
        private readonly telemetry: TelemetryService,
        private readonly spriteStorage: SpriteStorageService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly adminSettings: AdminSettingsService,
        private readonly keepAliveLease: SpriteKeepAliveLeaseService,
        private readonly activeDuration: SandboxActiveDurationService,
        @Optional() private readonly serviceLeases?: ServiceLeaseService
    ) {}

    onModuleInit(): void {
        this.timer = setInterval(() => {
            void this.tick()
        }, WAKEUP_INTERVAL_MS)
        if (typeof this.timer.unref === 'function') this.timer.unref()
        setImmediate(() => {
            void this.tick()
        })
    }

    onModuleDestroy(): void {
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
    // (the panel refresh button) and publishStatus (chat-originated wakes) —
    // must keep working from any instance. Manually constructed instances
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

    // Delete sandboxes that have been agent-less past the idle window. Each is
    // re-confirmed empty + still-expired under the per-user lock (serializes
    // against attach, which clears emptied_at) before its VM + row are removed.
    private async tickReaper(): Promise<void> {
        const now = Date.now()
        if (now < this.nextReaperAt) return
        this.nextReaperAt = now + REAPER_INTERVAL_MS
        const cutoff = new Date(now - REAP_EMPTY_AGE_MS)
        let candidates: Array<{
            id: string
            userId: string
            accountId: string | null
            spriteName: string | null
        }>
        try {
            // 'revoked' is included so a host whose earlier reap attempt died
            // between claim and delete (e.g. a failed settle) is retried
            // instead of leaking its row + VM forever.
            candidates = await this.db
                .select({
                    id: runtimeHosts.id,
                    userId: runtimeHosts.userId,
                    accountId: runtimeHosts.accountId,
                    spriteName: runtimeHosts.spriteName
                })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.kind, 'sandbox'),
                        inArray(runtimeHosts.status, ['active', 'revoked']),
                        isNotNull(runtimeHosts.emptiedAt),
                        lte(runtimeHosts.emptiedAt, cutoff)
                    )
                )
                .limit(REAPER_BATCH)
        } catch (err) {
            this.log.warn(`reaper scan failed: ${describeError(err)}`)
            return
        }
        for (const c of candidates) {
            try {
                const claimed = await this.db.transaction(async (tx) => {
                    await tx.execute(
                        sql`select pg_advisory_xact_lock(hashtextextended(${c.userId}, 0))`
                    )
                    const [r] = await tx
                        .select({ value: count() })
                        .from(agentRuntimes)
                        .where(eq(agentRuntimes.hostId, c.id))
                    if (Number(r?.value ?? 0) > 0) return false
                    const updated = await tx
                        .update(runtimeHosts)
                        .set({ status: 'revoked', updatedAt: new Date() })
                        .where(
                            and(
                                eq(runtimeHosts.id, c.id),
                                eq(runtimeHosts.kind, 'sandbox'),
                                inArray(runtimeHosts.status, [
                                    'active',
                                    'revoked'
                                ]),
                                isNotNull(runtimeHosts.emptiedAt),
                                lte(runtimeHosts.emptiedAt, cutoff)
                            )
                        )
                        .returning({ id: runtimeHosts.id })
                    return updated.length > 0
                })
                if (!claimed) continue
                // Settle any still-open running interval before the row vanishes
                // (the ledger row outlives the host). Normally a no-op since the
                // emptied host has long been idle, but a keep-alive bare sandbox
                // can be running at reap time.
                await this.activeDuration.settleHostNotRunning(
                    c.id,
                    c.userId,
                    new Date()
                )
                if (c.accountId && c.spriteName) {
                    const account = await this.accounts.getById(c.accountId)
                    if (account)
                        await this.clientFor(account)
                            .deleteSprite(c.spriteName)
                            .catch((err) => {
                                if (
                                    !(
                                        err instanceof SpritesError &&
                                        err.code === 'not_found'
                                    )
                                )
                                    throw err
                            })
                }
                await this.db
                    .delete(runtimeHosts)
                    .where(
                        and(
                            eq(runtimeHosts.id, c.id),
                            eq(runtimeHosts.kind, 'sandbox')
                        )
                    )
                this.log.warn(
                    `reaped empty sandbox host ${c.id} (${c.spriteName})`
                )
            } catch (err) {
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
    // cannot do this job — it only removes agents, runtimes, services and
    // tasks, so a host with none of those (the prod case) has nothing it can
    // pull, and there is no vendor API to suspend a sprite outright.
    private async tickExecSessionReaper(): Promise<void> {
        const now = Date.now()
        if (now < this.nextExecSessionReaperAt) return
        this.nextExecSessionReaperAt = now + EXEC_SESSION_REAPER_INTERVAL_MS
        let hosts: Array<{
            id: string
            userId: string
            accountId: string | null
            spriteName: string | null
        }>
        try {
            hosts = await this.db
                .select({
                    id: runtimeHosts.id,
                    userId: runtimeHosts.userId,
                    accountId: runtimeHosts.accountId,
                    spriteName: runtimeHosts.spriteName
                })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.spriteStatus, 'running')
                    )
                )
                .limit(REAPER_BATCH)
        } catch (err) {
            this.log.warn(
                `exec-session reaper scan failed: ${describeError(err)}`
            )
            return
        }
        for (const host of hosts) {
            if (!host.accountId || !host.spriteName) continue
            try {
                await this.reapExecSessionsOnHost({
                    id: host.id,
                    userId: host.userId,
                    accountId: host.accountId,
                    spriteName: host.spriteName
                })
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

    private async reapExecSessionsOnHost(host: {
        id: string
        userId: string
        accountId: string
        spriteName: string
    }): Promise<void> {
        const account = await this.accounts.getById(host.accountId)
        if (!account) return
        const client = this.clientFor(account)
        const abandoned = abandonedExecSessions(
            await client.listExecSessions(host.spriteName),
            Date.now(),
            EXEC_SESSION_MAX_IDLE_MS
        )
        for (const { session, idleMs } of abandoned) {
            await client.killExecSession(host.spriteName, session.id)
            const command = execCommandHead(session.command)
            // warn, not log: each one is a session that got past the
            // client-side kill in @manyfold/sprites, so it wants to be findable
            this.log.warn(
                `killed abandoned exec session ${session.id} on ${host.spriteName} (host=${host.id} cmd=${command} idle=${Math.round(idleMs / 60_000)}m)`
            )
            this.telemetry.event('sprite_exec_session.reaped', {
                hostId: host.id,
                userId: host.userId,
                spriteName: host.spriteName,
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
            // orgActive is per running sandbox VM (host-level sprite_status), the
            // same grain as the hard cap in RuntimeAccessService
            // (reserveActiveSlot / spritesWholesaleHeadroom): a bare running
            // sandbox counts; co-resident agents share one VM and count once.
            const [row] = await this.db
                .select({ value: count() })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.spriteStatus, 'running')
                    )
                )
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
        // Running/warm/cold are per sandbox VM (host-level sprite_status) so a
        // bare sandbox counts; provisioned is every active sandbox host (incl.
        // agent-less). Storage is a host-level sum too (one whole-VM rootfs
        // reading per host — sprites.dev bills per VM). This hourly snapshot
        // feeds the timeseries charted beside the live (also per-host)
        // AdminSandboxQuotasService.overview() — the grains must match or the
        // chart contradicts the cards.
        const statusRows = await this.db
            .select({
                spriteStatus: runtimeHosts.spriteStatus,
                value: count()
            })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.status, 'active')
                )
            )
            .groupBy(runtimeHosts.spriteStatus)
        let running = 0
        let warm = 0
        let cold = 0
        let provisioned = 0
        for (const r of statusRows) {
            const n = Number(r.value ?? 0)
            provisioned += n
            if (r.spriteStatus === 'running') running = n
            else if (r.spriteStatus === 'warm') warm = n
            else if (r.spriteStatus === 'cold') cold = n
        }
        const [storageRow] = await this.db
            .select({
                storage: sql<number>`coalesce(sum(${runtimeHosts.storageBytes}), 0)::bigint`
            })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.status, 'active')
                )
            )
        const storageBytes = Number(storageRow?.storage ?? 0)
        return { running, warm, cold, provisioned, storageBytes }
    }

    // Everyone with a quota worth evaluating, not just sprite owners. The
    // channel / automation / API-request warnings apply to users who may own no
    // sandbox at all, and gating on `agents.runtime = 'sprites'` would silently
    // never fire for them — a warning that cannot reach its audience is worse
    // than none, because it reads as covered.
    // The same logic bounds the other side: delivery is SSE-only with no
    // persistence, so a user without a recently-used live session cannot
    // receive anything — evaluating them only burns their 24h dedupe stamp
    // (see QUOTA_PRESENCE_WINDOW_MS).
    private async usersForQuotaEvaluation(): Promise<string[]> {
        const rows = (await this.db.execute(sql`
            select user_id from (
                select user_id from agents where runtime = 'sprites'
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
        const accountIds = await this.activeAccountIds()
        for (const accountId of accountIds) {
            const next = this.accountNextEligibleAt.get(accountId) ?? 0
            if (Date.now() < next) continue
            try {
                const hot = await this.syncAccount(accountId)
                this.accountFailures.delete(accountId)
                const interval = hot
                    ? SPRITE_FAST_INTERVAL_MS
                    : SPRITE_SLOW_INTERVAL_MS
                this.accountNextEligibleAt.set(accountId, Date.now() + interval)
            } catch (err) {
                this.recordFailure(
                    'account',
                    accountId,
                    err,
                    this.accountFailures,
                    this.accountNextEligibleAt
                )
            }
        }
    }

    private async tickK8s(): Promise<void> {
        const runtimes = await this.activeK8sRuntimes()
        for (const runtime of runtimes) {
            const next = this.runtimeNextEligibleAt.get(runtime.id) ?? 0
            if (Date.now() < next) continue
            try {
                await this.syncK8sRuntime(runtime)
                this.runtimeFailures.delete(runtime.id)
                this.runtimeNextEligibleAt.set(
                    runtime.id,
                    Date.now() + K8S_INTERVAL_MS
                )
            } catch (err) {
                this.recordFailure(
                    'runtime',
                    runtime.id,
                    err,
                    this.runtimeFailures,
                    this.runtimeNextEligibleAt
                )
            }
        }
    }

    private async activeAccountIds(): Promise<string[]> {
        // Union agent accounts with sandbox-host accounts: a bare sandbox (zero
        // agents) is invisible to the agents table but its VM still needs status
        // sync, so its account must be visited.
        const [agentRows, hostRows] = await Promise.all([
            this.db
                .selectDistinct({ accountId: agents.accountId })
                .from(agents)
                .where(
                    and(
                        eq(agents.runtime, 'sprites'),
                        isNotNull(agents.accountId)
                    )
                ),
            this.db
                .selectDistinct({ accountId: runtimeHosts.accountId })
                .from(runtimeHosts)
                .where(
                    and(
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.status, 'active'),
                        isNotNull(runtimeHosts.accountId)
                    )
                )
        ])
        const ids = new Set<string>()
        for (const r of [...agentRows, ...hostRows])
            if (r.accountId) ids.add(r.accountId)
        return [...ids]
    }

    private async activeK8sRuntimes(): Promise<AgentRuntimeRow[]> {
        return this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.kind, 'k8s'))
    }

    /**
     * Returns true if any sprite in this account is currently hot
     * (running/warm) — used to decide whether the next tick for this account
     * should run on the fast or slow cadence.
     */
    private async syncAccount(accountId: string): Promise<boolean> {
        const account = await this.accounts.getById(accountId)
        if (!account) return false

        const client = this.clientFor(account)
        const list = await client.listSprites()
        if (!list) return false
        const byName = new Map<string, SpriteStatus | null>()
        const counts = { running: 0, warm: 0, cold: 0 }
        let anyHot = false
        for (const sprite of list.sprites) {
            const name = (sprite as { name?: unknown }).name
            if (typeof name !== 'string') continue
            const status = normalizeStatus(sprite.status)
            byName.set(name, status)
            if (status === 'running') counts.running += 1
            else if (status === 'warm') counts.warm += 1
            else if (status === 'cold') counts.cold += 1
            if (isHotSpriteStatus(status)) anyHot = true
        }
        await this.recordVendorCapacity(account, list, counts)

        const rows = await this.db
            .select()
            .from(agents)
            .where(
                and(
                    eq(agents.accountId, accountId),
                    eq(agents.runtime, 'sprites'),
                    isNotNull(agents.spriteName)
                )
            )

        const now = new Date()
        for (const row of rows) {
            if (!row.spriteName) continue
            if (!byName.has(row.spriteName)) continue
            const next = byName.get(row.spriteName) ?? null
            if (next === row.spriteStatus) continue
            if (row.spriteStatus === 'running' && next === 'warm') {
                await this.spriteStorage.measureIfDue(row.id)
            }
            await this.db
                .update(agents)
                .set({ spriteStatus: next, updatedAt: now })
                .where(eq(agents.id, row.id))
            this.broadcaster.emit(row.userId, {
                agentId: row.id,
                spriteName: row.spriteName,
                spriteStatus: next,
                k8sPodPhase: row.k8sPodPhase,
                at: now.toISOString()
            })
            this.maybeEmitReady(row, next, now)
        }

        await this.detectDeletedSprites(client, rows, byName, now)
        await this.syncSandboxHosts(client, accountId, byName, now)

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
        account: SpritesAccount,
        list: ListSpritesResponse,
        counts: { running: number; warm: number; cold: number }
    ): Promise<void> {
        const runningLimit = vendorLimit(list.running_limit)
        const warmLimit = vendorLimit(list.warm_limit)
        try {
            const wrote = await this.adminSettings.recordSpritesVendorCapacity(
                account.id,
                {
                    slug: account.slug,
                    runningLimit,
                    warmLimit,
                    running: counts.running,
                    warm: counts.warm,
                    cold: counts.cold
                }
            )
            if (wrote)
                await this.emitWarmCapacityTelemetry(
                    account,
                    warmLimit,
                    counts.warm
                )
        } catch (err) {
            this.log.warn(
                `vendor capacity record failed for account=${account.slug}: ${(err as Error).message}`
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
        account: SpritesAccount,
        warmLimit: number | null,
        warm: number
    ): Promise<void> {
        if (warmLimit === null || warmLimit <= 0) return
        const { softThresholdPct } =
            await this.adminSettings.getCachedSpritesWholesaleCap()
        const softCap = Math.floor((warmLimit * softThresholdPct) / 100)
        const attrs = {
            accountSlug: account.slug,
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

    // Host-level sprite_status writer. Bare sandboxes (zero agents) are invisible
    // to the agent loop in syncAccount, so the running-concurrency counters that
    // read runtime_hosts.sprite_status depend on this pass; it also confirms +
    // reaps an empty sandbox host whose VM vanished from the listing.
    private async syncSandboxHosts(
        client: SpritesClient,
        accountId: string,
        byName: Map<string, SpriteStatus | null>,
        now: Date
    ): Promise<void> {
        const hosts = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.accountId, accountId),
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.status, 'active'),
                    isNotNull(runtimeHosts.spriteName)
                )
            )
        const missing: RuntimeHostRow[] = []
        for (const host of hosts) {
            if (!host.spriteName) continue
            if (!byName.has(host.spriteName)) {
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
            const next = byName.get(host.spriteName) ?? null
            // Accrue before the unchanged-status short-circuit: a host that stays
            // 'running' across samples writes no status change but must still
            // advance the watermark + credit the elapsed seconds. Metering
            // failure is contained per host: letting it throw would abort the
            // whole account pass and freeze sprite_status for every other host
            // (phantom `running` rows then inflate the concurrency caps).
            try {
                await this.activeDuration.accrue(host, next === 'running', now)
            } catch (err) {
                this.log.warn(
                    `active-duration accrue failed for host ${host.id}: ${describeError(err)}`
                )
            }
            if (next === host.spriteStatus) continue
            // Host-level so a bare sandbox (zero agents, still billed for its
            // rootfs) gets measured too; agent-bearing hosts dedupe against the
            // agent-loop trigger via storage_measured_at.
            if (host.spriteStatus === 'running' && next === 'warm')
                await this.spriteStorage.measureHostIfDue(host.id)
            await this.db
                .update(runtimeHosts)
                .set({ spriteStatus: next, updatedAt: now })
                .where(eq(runtimeHosts.id, host.id))
            this.broadcaster.emitHostUpdate(host.userId, {
                hostId: host.id,
                spriteStatus: next,
                at: now.toISOString()
            })
        }
        if (missing.length > 0)
            await this.detectDeletedSandboxHosts(client, missing, now)
    }

    // Empty sandbox hosts whose VM is gone from the listing. Agent-bearing hosts
    // are left to detectDeletedSprites (which stops the runtime + keeps the row
    // for revive); only zero-runtime hosts are removed here, after the same
    // confirmation window used for agent sprites.
    private async detectDeletedSandboxHosts(
        client: SpritesClient,
        hosts: RuntimeHostRow[],
        now: Date
    ): Promise<void> {
        for (const host of hosts) {
            if (!host.spriteName) continue
            if (
                now.getTime() - host.createdAt.getTime() <
                SPRITE_PROVISION_GRACE_MS
            ) {
                this.hostSpriteMissingSince.delete(host.id)
                continue
            }
            const [runtimeRow] = await this.db
                .select({ value: count() })
                .from(agentRuntimes)
                .where(eq(agentRuntimes.hostId, host.id))
            if (Number(runtimeRow?.value ?? 0) > 0) {
                this.hostSpriteMissingSince.delete(host.id)
                continue
            }
            const firstMissedAt = this.hostSpriteMissingSince.get(host.id)
            if (firstMissedAt === undefined) {
                this.hostSpriteMissingSince.set(host.id, now.getTime())
                continue
            }
            if (now.getTime() - firstMissedAt >= SPRITE_MISSING_STALE_MS) {
                this.hostSpriteMissingSince.set(host.id, now.getTime())
                continue
            }
            if (now.getTime() - firstMissedAt < SPRITE_MISSING_CONFIRM_MS)
                continue
            try {
                await client.getSprite(host.spriteName)
                this.hostSpriteMissingSince.delete(host.id)
            } catch (err) {
                if (err instanceof SpritesError && err.code === 'not_found') {
                    // Atomic empty-guard: a racing attach that added a runtime
                    // (and cleared emptied_at) keeps the host.
                    await this.db.execute(sql`
                        delete from runtime_hosts h
                        where h.id = ${host.id}
                          and h.kind = 'sandbox'
                          and not exists (
                              select 1 from agent_runtimes r
                              where r.host_id = h.id
                          )
                    `)
                    this.hostSpriteMissingSince.delete(host.id)
                    this.log.warn(
                        `sandbox host ${host.id} VM ${host.spriteName} gone; removed empty host`
                    )
                } else {
                    this.log.warn(
                        `getSprite confirm failed for sandbox host ${host.id} (${host.spriteName}): ${describeError(err)}`
                    )
                }
            }
        }
    }

    // A DB row whose sprite is absent from the account listing is otherwise
    // skipped forever by the loop above, freezing a stale 'running' that
    // defeats reconcile's sleep gate and leaks an occupancy slot (#107).
    // deleteSprite only happens in teardown flows that also delete the DB
    // rows, so "sprite absent while runtime ready" is always an anomaly.
    private async detectDeletedSprites(
        client: SpritesClient,
        rows: Agent[],
        byName: Map<string, SpriteStatus | null>,
        now: Date
    ): Promise<void> {
        const missingByRuntime = new Map<string, Agent[]>()
        const reviveRuntimeIds = new Set<string>()
        for (const row of rows) {
            if (!row.spriteName) continue
            if (byName.has(row.spriteName)) {
                this.spriteMissingSince.delete(row.runtimeId)
                if (row.failureReason === spriteGoneReason(row.spriteName))
                    reviveRuntimeIds.add(row.runtimeId)
                continue
            }
            const missing = missingByRuntime.get(row.runtimeId) ?? []
            missing.push(row)
            missingByRuntime.set(row.runtimeId, missing)
        }
        if (missingByRuntime.size === 0 && reviveRuntimeIds.size === 0) return

        const runtimes = await this.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    inArray(agentRuntimes.id, [
                        ...new Set([
                            ...missingByRuntime.keys(),
                            ...reviveRuntimeIds
                        ])
                    ]),
                    eq(agentRuntimes.kind, 'sprites')
                )
            )
        const byId = new Map(runtimes.map((r) => [r.id, r]))
        for (const runtimeId of missingByRuntime.keys())
            if (!byId.has(runtimeId)) this.spriteMissingSince.delete(runtimeId)

        for (const runtime of runtimes) {
            if (reviveRuntimeIds.has(runtime.id)) {
                await this.reviveSpriteRuntime(runtime, now)
                continue
            }
            if (
                runtime.status !== 'ready' ||
                !runtime.spriteName ||
                now.getTime() - runtime.createdAt.getTime() <
                    SPRITE_PROVISION_GRACE_MS
            ) {
                this.spriteMissingSince.delete(runtime.id)
                continue
            }
            const firstMissedAt = this.spriteMissingSince.get(runtime.id)
            if (firstMissedAt === undefined) {
                this.spriteMissingSince.set(runtime.id, now.getTime())
                this.log.warn(
                    `sprite ${runtime.spriteName} missing from account listing (runtime=${runtime.id}); awaiting confirmation`
                )
                continue
            }
            if (now.getTime() - firstMissedAt >= SPRITE_MISSING_STALE_MS) {
                this.spriteMissingSince.set(runtime.id, now.getTime())
                continue
            }
            if (now.getTime() - firstMissedAt < SPRITE_MISSING_CONFIRM_MS)
                continue
            try {
                // control-plane read; never wakes the VM
                await client.getSprite(runtime.spriteName)
                this.spriteMissingSince.delete(runtime.id)
            } catch (err) {
                if (err instanceof SpritesError && err.code === 'not_found') {
                    await this.markSpriteDeleted(
                        runtime,
                        missingByRuntime.get(runtime.id) ?? [],
                        now
                    )
                    this.spriteMissingSince.delete(runtime.id)
                } else {
                    // transient/auth: keep the window armed, retry next tick
                    this.log.warn(
                        `getSprite confirm failed for ${runtime.spriteName} (runtime=${runtime.id}): ${describeError(err)}`
                    )
                }
            }
        }
    }

    private async markSpriteDeleted(
        runtime: AgentRuntimeRow,
        rows: Agent[],
        now: Date
    ): Promise<void> {
        const reason = spriteGoneReason(runtime.spriteName ?? '')
        // status guard + returning: with several API instances only the
        // winner emits events; the agents update below stays unconditional
        // because already-stopped rows can still carry a frozen spriteStatus.
        const won = await this.db
            .update(agentRuntimes)
            .set({ status: 'stopped', failureReason: reason, updatedAt: now })
            .where(
                and(
                    eq(agentRuntimes.id, runtime.id),
                    eq(agentRuntimes.status, 'ready')
                )
            )
            .returning({ id: agentRuntimes.id })
        await this.db
            .update(agents)
            .set({
                status: 'stopped',
                spriteStatus: null,
                failureReason: reason,
                updatedAt: now
            })
            .where(eq(agents.runtimeId, runtime.id))
        if (won.length === 0) return
        this.log.warn(
            `${reason}; marking runtime ${runtime.id} and ${rows.length} agent(s) stopped`
        )
        for (const row of rows) {
            this.broadcaster.emit(row.userId, {
                agentId: row.id,
                spriteName: row.spriteName,
                spriteStatus: null,
                k8sPodPhase: row.k8sPodPhase,
                at: now.toISOString()
            })
        }
        this.telemetry.event('agent.runtime.sprite_deleted', {
            runtimeId: runtime.id,
            userId: runtime.userId,
            accountId: runtime.accountId,
            spriteName: runtime.spriteName,
            framework: runtime.framework,
            agentCount: rows.length
        })
    }

    // Symmetric recovery (mirrors daemon-runtime-sync): if the sprite shows
    // up in the listing again — false positive or control-plane incident —
    // un-stop exactly what markSpriteDeleted stopped, nothing else.
    private async reviveSpriteRuntime(
        runtime: AgentRuntimeRow,
        now: Date
    ): Promise<void> {
        if (!runtime.spriteName) return
        const reason = spriteGoneReason(runtime.spriteName)
        if (runtime.status !== 'stopped' || runtime.failureReason !== reason)
            return
        const won = await this.db
            .update(agentRuntimes)
            .set({ status: 'ready', failureReason: null, updatedAt: now })
            .where(
                and(
                    eq(agentRuntimes.id, runtime.id),
                    eq(agentRuntimes.status, 'stopped'),
                    eq(agentRuntimes.failureReason, reason)
                )
            )
            .returning({ id: agentRuntimes.id })
        if (won.length === 0) return
        await this.db
            .update(agents)
            .set({ status: 'running', failureReason: null, updatedAt: now })
            .where(
                and(
                    eq(agents.runtimeId, runtime.id),
                    eq(agents.failureReason, reason)
                )
            )
        this.log.warn(
            `sprite ${runtime.spriteName} reappeared; reviving runtime ${runtime.id}`
        )
        this.telemetry.event('agent.runtime.sprite_restored', {
            runtimeId: runtime.id,
            userId: runtime.userId,
            accountId: runtime.accountId,
            spriteName: runtime.spriteName,
            framework: runtime.framework
        })
    }

    private maybeEmitReady(
        row: Pick<
            Agent,
            'id' | 'userId' | 'runtimeId' | 'runtime' | 'createdAt'
        >,
        next: SpriteStatus | string | null,
        now: Date
    ): void {
        if (next !== 'running' && next !== 'Running') return
        if (this.readyEmitted.has(row.id)) return
        this.readyEmitted.add(row.id)
        // NOT a provisioning latency: readyEmitted is per-process, so after an
        // api restart every pre-existing agent re-emits and this reads as the
        // agent record's age (days). Named for what it measures — see
        // ops/axiom/monitors.md "agent.runtime.ready has no readiness metric".
        this.telemetry.event('agent.runtime.ready', {
            agentId: row.id,
            userId: row.userId,
            runtimeId: row.runtimeId,
            runtime: row.runtime,
            agentAgeMs: now.getTime() - new Date(row.createdAt).getTime()
        })
    }

    private async syncK8sRuntime(runtime: AgentRuntimeRow): Promise<void> {
        if (!runtime.namespace) return
        const rows = await this.db
            .select()
            .from(agents)
            .where(
                and(eq(agents.runtimeId, runtime.id), eq(agents.runtime, 'k8s'))
            )
        if (rows.length === 0) return

        const client = await this.k8s.getClient(runtime.clusterId)
        const labelAgentId = runtime.primaryAgentId ?? rows[0].id
        const pod = await fetchPodForRuntime(
            client,
            runtime.namespace,
            labelAgentId
        )
        const phase = derivePodPhase(pod)

        const now = new Date()
        for (const row of rows) {
            if (phase === row.k8sPodPhase) continue
            await this.db
                .update(agents)
                .set({ k8sPodPhase: phase, updatedAt: now })
                .where(eq(agents.id, row.id))
            this.broadcaster.emit(row.userId, {
                agentId: row.id,
                spriteName: row.spriteName,
                spriteStatus: row.spriteStatus,
                k8sPodPhase: phase,
                at: now.toISOString()
            })
            this.maybeEmitReady(row, phase, now)
        }
    }

    private clientFor(account: SpritesAccount): SpritesClient {
        return createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug,
            logger: silentLogger
        })
    }

    private recordFailure(
        kind: 'account' | 'runtime',
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
     * Helper used by orchestrator/reconcile paths to publish a status change
     * outside the periodic tick (e.g. set 'cold' immediately after sprite
     * creation, or 'Running' for k8s pod after bootstrap completes). When the
     * patch hints the sprite is now hot, also kicks the account's next tick
     * to fire immediately so we re-poll on the fast cadence.
     */
    async publishStatus(
        agent: Pick<
            Agent,
            | 'id'
            | 'userId'
            | 'spriteName'
            | 'spriteStatus'
            | 'k8sPodPhase'
            | 'accountId'
            | 'hostId'
        >,
        patch: {
            spriteStatus?: SpriteStatus | null
            k8sPodPhase?: string | null
        }
    ): Promise<void> {
        this.log.log(
            `publishStatus agentId=${agent.id} userId=${agent.userId} patch=${JSON.stringify(patch)}`
        )
        const now = new Date()
        const update: Partial<Agent> = { updatedAt: now }
        if ('spriteStatus' in patch) update.spriteStatus = patch.spriteStatus
        if ('k8sPodPhase' in patch) update.k8sPodPhase = patch.k8sPodPhase
        await this.db.update(agents).set(update).where(eq(agents.id, agent.id))
        // Mirror sprite_status onto the host so host-level concurrency counters
        // stay current between periodic syncs. Co-resident agents share the VM,
        // so the host takes this agent's status.
        if ('spriteStatus' in patch && agent.hostId) {
            const nextStatus = patch.spriteStatus ?? null
            await this.db
                .update(runtimeHosts)
                .set({
                    spriteStatus: nextStatus,
                    // Open the accrual watermark the instant we publish 'running'
                    // (chat/terminal wake) so a short turn that's back to warm
                    // before the next status sample still credits from its start.
                    // coalesce keeps an already-open interval intact; the periodic
                    // syncSandboxHosts pass settles it when the VM goes idle.
                    // ms-precision ISO string, NOT a raw Date: postgres-js crashes
                    // binding a JS Date interpolated into a sql`` fragment.
                    ...(nextStatus === 'running'
                        ? {
                              activeAccrualSince: sql`coalesce(${runtimeHosts.activeAccrualSince}, ${now.toISOString()}::timestamptz)`
                          }
                        : {}),
                    updatedAt: now
                })
                .where(
                    and(
                        eq(runtimeHosts.id, agent.hostId),
                        eq(runtimeHosts.kind, 'sandbox')
                    )
                )
            this.broadcaster.emitHostUpdate(agent.userId, {
                hostId: agent.hostId,
                spriteStatus: nextStatus,
                at: now.toISOString()
            })
        }
        this.broadcaster.emit(agent.userId, {
            agentId: agent.id,
            spriteName: agent.spriteName,
            spriteStatus:
                'spriteStatus' in patch
                    ? (patch.spriteStatus ?? null)
                    : agent.spriteStatus,
            k8sPodPhase:
                'k8sPodPhase' in patch
                    ? (patch.k8sPodPhase ?? null)
                    : agent.k8sPodPhase,
            at: now.toISOString()
        })
        if (agent.accountId && isHotSpriteStatus(patch.spriteStatus ?? null)) {
            this.accountNextEligibleAt.set(agent.accountId, 0)
        }
    }

    // Force the account's next sprite sync to fire on the upcoming wakeup,
    // overriding the slow/backoff cadence. Used by non-chat activity (terminal
    // open) so the running→warm release is reconciled on the fast cadence
    // instead of up to 30s later. listSprites stays the source of truth.
    pokeAccount(accountId: string): void {
        this.accountNextEligibleAt.set(accountId, 0)
    }

    // On-demand single-host status refresh for the host detail "Refresh" button.
    // The periodic pass lags (up to 30s on the warm/cold slow cadence), so we
    // read this one sprite directly. getSprite is a control-plane read that never
    // wakes the VM; we persist the status on the host row so the caller's HTTP
    // response carries it, then poke the account so the periodic pass reconciles
    // co-resident agents + SSE on the very next tick. Returns the fresh status.
    async refreshSandboxHost(
        host: RuntimeHostRow
    ): Promise<SpriteStatus | null> {
        if (host.kind !== 'sandbox' || !host.accountId || !host.spriteName)
            return host.spriteStatus
        const account = await this.accounts.getById(host.accountId)
        if (!account) return host.spriteStatus
        let status: SpriteStatus | null
        try {
            const sprite = await this.clientFor(account).getSprite(
                host.spriteName
            )
            status = normalizeStatus(sprite.status)
        } catch (err) {
            // A vanished sprite is a teardown anomaly the periodic detector
            // owns; don't clobber the row here, just surface the last status.
            if (err instanceof SpritesError && err.code === 'not_found')
                return host.spriteStatus
            throw err
        }
        const now = new Date()
        // Manual refresh is another direct host-status writer; accrue here too so
        // an interval that opened or closed between periodic samples isn't lost.
        await this.activeDuration.accrue(host, status === 'running', now)
        if (status !== host.spriteStatus) {
            await this.db
                .update(runtimeHosts)
                .set({ spriteStatus: status, updatedAt: now })
                .where(
                    and(
                        eq(runtimeHosts.id, host.id),
                        eq(runtimeHosts.kind, 'sandbox')
                    )
                )
            // Persisting here makes the poked periodic pass see the status as
            // unchanged and skip its emit — broadcast now or other open clients
            // never hear about this transition.
            this.broadcaster.emitHostUpdate(host.userId, {
                hostId: host.id,
                spriteStatus: status,
                at: now.toISOString()
            })
        }
        this.pokeAccount(host.accountId)
        return status
    }

    // Generalizes chat's markRuntimeActive sprite-status path to non-chat
    // callers: on a sprites agent becoming active, kick the account onto the
    // fast cadence and publish `running` if the row hasn't caught up yet. Always
    // pokes (even when already `running`) so a stale slow cadence still flips
    // fast. Never rejects — callers fire-and-forget.
    async markSpriteRunning(agentId: string): Promise<void> {
        try {
            const rows = await this.db
                .select({
                    id: agents.id,
                    userId: agents.userId,
                    runtime: agents.runtime,
                    spriteName: agents.spriteName,
                    spriteStatus: agents.spriteStatus,
                    k8sPodPhase: agents.k8sPodPhase,
                    accountId: agents.accountId,
                    hostId: agents.hostId
                })
                .from(agents)
                .where(eq(agents.id, agentId))
                .limit(1)
            const row = rows[0]
            if (!row || row.runtime !== 'sprites') return
            if (row.accountId) this.pokeAccount(row.accountId)
            if (row.spriteStatus !== 'running') {
                await this.publishStatus(row, { spriteStatus: 'running' })
            }
        } catch (err) {
            this.log.warn(
                `markSpriteRunning failed agentId=${agentId}: ${(err as Error).message}`
            )
        }
    }
}

// Shared by markSpriteDeleted (write) and reviveSpriteRuntime / the revive
// scan (match) — the exact string is what scopes revival to our own stops.
const spriteGoneReason = (spriteName: string): string =>
    `sprite ${spriteName} not found on sprites.dev`

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
