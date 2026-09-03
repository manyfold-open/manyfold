import { FEATURE_TOGGLE_KEYS } from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import {
    agentRuntimes,
    plans,
    runtimeHosts,
    users,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'
import { SpritesSessionRegistry } from '@/modules/agents/sprite-sessions/sprite-sessions.registry'
import { SandboxesService } from './sandboxes.service'

const TICK_MS = 60_000
const LEASE_NAME = 'active-hours-enforcement'
const LEASE_TTL_MS = 90_000
// Bound per-tick blast radius; remaining over-quota users converge next tick.
const MAX_USERS_PER_TICK = 5
// Retry force-sleep per user at most this often — wake causes the leader
// can't remove itself (cross-instance WS sessions) resolve on their own.
const USER_COOLDOWN_MS = 5 * 60_000

// Admission checks (reserveActiveSlot, the markRuntimeActive wake guard) stop
// NEW activity for over-quota users; this sweep removes the wake causes they
// already hold — running sandboxes and keep-alive flags — so accrual actually
// stops instead of running until natural idle.
@Injectable()
export class ActiveHoursEnforcementService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly log = new Logger(ActiveHoursEnforcementService.name)
    private timer: NodeJS.Timeout | null = null
    private inflight = false
    private isLeader = false
    private readonly leaseHolderId =
        process.env.FLY_MACHINE_ID || process.env.HOSTNAME || randomUUID()
    private readonly nextEligibleAt = new Map<string, number>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly sandboxes: SandboxesService,
        private readonly activeDuration: SandboxActiveDurationService,
        private readonly runtimes: AgentRuntimesService,
        private readonly sessionRegistry: SpritesSessionRegistry,
        private readonly broadcaster: SpriteStatusBroadcaster,
        private readonly adminSettings: AdminSettingsService,
        private readonly telemetry: TelemetryService,
        @Optional() private readonly serviceLeases?: ServiceLeaseService
    ) {}

    onModuleInit(): void {
        this.timer = setInterval(() => {
            void this.tick()
        }, TICK_MS)
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
                ?.release(LEASE_NAME, this.leaseHolderId)
                .catch(() => undefined)
    }

    async tick(): Promise<void> {
        if (this.inflight) return
        this.inflight = true
        try {
            if (
                !(await this.adminSettings.isFeatureEnabled(
                    FEATURE_TOGGLE_KEYS.ACTIVE_HOURS_ENFORCEMENT
                ))
            )
                return
            if (!(await this.acquireLeadership())) return
            await this.enforce()
        } catch (err) {
            this.log.warn(
                `active-hours sweep failed: ${(err as Error).message}`
            )
        } finally {
            this.inflight = false
        }
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
            // Fail closed: a paused sweep only delays enforcement, while every
            // instance sweeping would stop the same hosts N times over.
            this.log.warn(
                `active-hours lease check failed: ${(err as Error).message}`
            )
            return false
        }
        if (acquired !== this.isLeader) {
            this.isLeader = acquired
            this.log.log(
                `active-hours enforcement leadership ${acquired ? 'acquired' : 'lost'} holder=${this.leaseHolderId}`
            )
        }
        return acquired
    }

    private async enforce(): Promise<void> {
        const running = await this.db
            .select({ id: runtimeHosts.id, userId: runtimeHosts.userId })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.kind, 'sandbox'),
                    eq(runtimeHosts.spriteStatus, 'running')
                )
            )
        const keepAlive = await this.db
            .select({
                id: agentRuntimes.id,
                userId: agentRuntimes.userId,
                hostId: agentRuntimes.hostId
            })
            .from(agentRuntimes)
            .where(
                and(
                    eq(agentRuntimes.kind, 'sprites'),
                    eq(agentRuntimes.keepAliveEnabled, true)
                )
            )
        const candidateIds = [
            ...new Set([
                ...running.map((r) => r.userId),
                ...keepAlive.map((r) => r.userId)
            ])
        ]
        if (candidateIds.length === 0) return

        const [usage, limitRows] = await Promise.all([
            this.activeDuration.activeSecondsInPeriodByUser(candidateIds),
            this.db
                .select({
                    id: users.id,
                    activeHoursBonus: users.activeHoursBonus,
                    planName: plans.name,
                    monthlyActiveHoursIncluded:
                        plans.monthlyActiveHoursIncluded
                })
                .from(users)
                .innerJoin(plans, eq(plans.id, users.planId))
                .where(inArray(users.id, candidateIds))
        ])

        const now = Date.now()
        let enforced = 0
        for (const row of limitRows) {
            if (enforced >= MAX_USERS_PER_TICK) break
            // Live plan read each tick: an upgrade (or bonus bump) un-flags
            // the user on the next pass with no extra plumbing.
            if (row.monthlyActiveHoursIncluded === null) continue
            const limitHours =
                row.monthlyActiveHoursIncluded + row.activeHoursBonus
            const seconds = usage.get(row.id) ?? 0
            if (seconds < limitHours * 3600) continue
            if ((this.nextEligibleAt.get(row.id) ?? 0) > now) continue
            this.nextEligibleAt.set(row.id, now + USER_COOLDOWN_MS)
            enforced += 1
            await this.enforceUser({
                userId: row.id,
                planName: row.planName,
                usedHours: Math.round((seconds / 3600) * 10) / 10,
                limitHours,
                runningHostIds: running
                    .filter((h) => h.userId === row.id)
                    .map((h) => h.id),
                keepAliveRuntimes: keepAlive.filter(
                    (r) => r.userId === row.id
                )
            })
        }
    }

    private async enforceUser(input: {
        userId: string
        planName: string
        usedHours: number
        limitHours: number
        runningHostIds: string[]
        keepAliveRuntimes: Array<{ id: string; hostId: string | null }>
    }): Promise<void> {
        const stopped: string[] = []
        // A stop that threw is visibly broken; a stop that returned having
        // removed nothing is the dangerous one, because the retry loop reads
        // it as success and says so in its own log. Kept separate so a host
        // this sweep cannot actually put to sleep is legible from one line
        // instead of from correlating three days of audit rows.
        const unresolved: string[] = []
        for (const hostId of input.runningHostIds) {
            try {
                // Bare-host terminal sessions register under the host id and
                // are not closed by stop() itself.
                this.sessionRegistry.closeForAgent(
                    hostId,
                    'active-hours-quota'
                )
                const res = await this.sandboxes.stop(input.userId, hostId)
                if (res.status === 'noop' || res.warnings.length > 0)
                    unresolved.push(hostId)
                else stopped.push(hostId)
            } catch (err) {
                unresolved.push(hostId)
                this.log.warn(
                    `force-sleep failed for user=${input.userId} host=${hostId}: ${(err as Error).message}`
                )
            }
        }
        const runningSet = new Set(input.runningHostIds)
        for (const rt of input.keepAliveRuntimes) {
            // stop() already flips flags for runtimes on the hosts it stopped.
            // A sleeping sprite holds no lease task, so the flag flip alone
            // stops the keep-alive reconcile from re-waking it — releaseLease
            // would exec into (and wake) the VM, the one thing this must not do.
            if (rt.hostId && runningSet.has(rt.hostId)) continue
            try {
                await this.runtimes.setKeepAliveEnabled(rt.id, false)
            } catch (err) {
                this.log.warn(
                    `keep-alive disable failed for user=${input.userId} runtime=${rt.id}: ${(err as Error).message}`
                )
            }
        }
        this.broadcaster.emitQuotaWarning(input.userId, {
            type: 'quota-warning',
            code: 'active_hours',
            usage: input.usedHours,
            limit: input.limitHours,
            planName: input.planName,
            at: new Date().toISOString()
        })
        this.telemetry.event('active_hours.force_sleep', {
            userId: input.userId,
            stoppedHosts: stopped.length,
            unresolvedHosts: unresolved.length,
            keepAliveDisabled: input.keepAliveRuntimes.length,
            usedHours: input.usedHours,
            limitHours: input.limitHours
        })
        const line = `active-hours quota enforced user=${input.userId} used=${input.usedHours}h limit=${input.limitHours}h stopped=${stopped.join(',') || 'none'} unresolved=${unresolved.join(',') || 'none'}`
        // warn when the sweep could not put every running host to sleep: the
        // user keeps accruing past the limit, which is the opposite of what
        // this sweep exists to do, and it will keep quietly retrying forever.
        if (unresolved.length > 0) this.log.warn(line)
        else this.log.log(line)
    }
}
