import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    Optional
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, eq, exists, inArray, ne, notInArray, or, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    type AgentRuntimeRow,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { AgentReconcileService } from './agent-reconcile.service'

// Freshness backstop for agent state now that list endpoints are pure reads
// (#516). Lifecycle writers converge agents rows inline and reports/chat
// wakes touch individual runtimes; this sweep catches what slips through:
// stragglers of stop/wake transitions (set-based, two statements for the
// whole fleet) and service-framework runtimes whose agents drift when
// created/removed outside Manyfold and nothing else touches them.
const TICK_INTERVAL_MS = 15_000
const SWEEP_INTERVAL_MS = 60_000
// Single leader: without it every API replica would run the sweep and race
// the same per-runtime reconciles. Renewal rides the 15s tick; TTL covers
// two missed ticks before takeover.
const SWEEP_LEASE_NAME = 'agent-reconcile-sweep'
const SWEEP_LEASE_TTL_MS = 45_000
// Per-sweep cap on service-framework touches. Ordering by the stalest
// min(last_reconciled_at) makes the rotation fair when a deployment ever
// exceeds the cap; the clip is logged so it can't silently starve.
const SWEEP_TOUCH_LIMIT = 25

const CODING_FRAMEWORKS: AgentRuntimeRow['framework'][] = [
    'claude-code',
    'codex',
    'gemini-cli'
]

@Injectable()
export class AgentReconcileSweepService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly log = new Logger(AgentReconcileSweepService.name)
    private timer: NodeJS.Timeout | null = null
    private inflight = false
    private nextSweepAt = 0
    private isLeader = false
    private readonly leaseHolderId =
        process.env.FLY_MACHINE_ID || process.env.HOSTNAME || randomUUID()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly reconcile: AgentReconcileService,
        @Optional() private readonly serviceLeases?: ServiceLeaseService
    ) {}

    onModuleInit(): void {
        this.timer = setInterval(() => {
            void this.tick()
        }, TICK_INTERVAL_MS)
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
                ?.release(SWEEP_LEASE_NAME, this.leaseHolderId)
                .catch(() => undefined)
    }

    async tick(): Promise<void> {
        if (this.inflight) return
        this.inflight = true
        try {
            if (!(await this.acquireLeadership())) return
            const now = Date.now()
            if (now < this.nextSweepAt) return
            this.nextSweepAt = now + SWEEP_INTERVAL_MS
            await this.runOnce()
        } catch (err) {
            this.log.warn(`reconcile sweep failed: ${(err as Error).message}`)
        } finally {
            this.inflight = false
        }
    }

    private async acquireLeadership(): Promise<boolean> {
        if (!this.serviceLeases) return true
        let acquired = false
        try {
            acquired = await this.serviceLeases.tryAcquireOrRenew(
                SWEEP_LEASE_NAME,
                this.leaseHolderId,
                SWEEP_LEASE_TTL_MS
            )
        } catch (err) {
            // Fail closed: a paused sweep only delays convergence, while
            // every replica sweeping reintroduces the duplicate reconcile
            // work the lease exists to stop.
            this.log.warn(
                `reconcile sweep lease check failed: ${(err as Error).message}`
            )
            return false
        }
        if (acquired !== this.isLeader) {
            this.isLeader = acquired
            this.log.log(
                `reconcile sweep leadership ${acquired ? 'acquired' : 'lost'} holder=${this.leaseHolderId}`
            )
        }
        return acquired
    }

    async runOnce(): Promise<void> {
        await this.convergeStoppedRuntimeAgents()
        await this.resurrectCodingRuntimeAgents()
        await this.touchServiceRuntimes()
    }

    // Set-based mirror of reconcileRuntime's stopped branch: every stop
    // writer converges agents inline, so this writes zero rows in steady
    // state and exists to catch interrupted transitions.
    private async convergeStoppedRuntimeAgents(): Promise<void> {
        const now = new Date()
        await this.db
            .update(agents)
            .set({
                status: 'stopped',
                lastReconciledAt: now,
                updatedAt: now
            })
            .where(
                and(
                    ne(agents.status, 'stopped'),
                    inArray(
                        agents.runtimeId,
                        this.db
                            .select({ id: agentRuntimes.id })
                            .from(agentRuntimes)
                            .where(
                                and(
                                    eq(agentRuntimes.status, 'stopped'),
                                    ne(agentRuntimes.kind, 'external')
                                )
                            )
                    )
                )
            )
    }

    // Set-based mirror of the coding-framework fast path in reconcileRuntime:
    // healthy rows (internalId = id) on an active runtime must not stay
    // stopped; orphan-stopped corrupt rows keep their status.
    private async resurrectCodingRuntimeAgents(): Promise<void> {
        const now = new Date()
        await this.db
            .update(agents)
            .set({
                status: 'running',
                failureReason: null,
                lastReconciledAt: now,
                updatedAt: now
            })
            .where(
                and(
                    eq(agents.status, 'stopped'),
                    eq(agents.internalId, agents.id),
                    inArray(
                        agents.runtimeId,
                        this.db
                            .select({ id: agentRuntimes.id })
                            .from(agentRuntimes)
                            .where(
                                and(
                                    eq(agentRuntimes.status, 'ready'),
                                    inArray(
                                        agentRuntimes.framework,
                                        CODING_FRAMEWORKS
                                    )
                                )
                            )
                    )
                )
            )
    }

    // Service frameworks are the only runtimes whose reconcile learns
    // anything the DB doesn't already know (agents created/removed in the
    // framework's own UI). Sleeping sprites are excluded here for the same
    // reason reconcileRuntime skips them: listing wakes the VM (billing).
    private async touchServiceRuntimes(): Promise<void> {
        const candidates = await this.db
            .select()
            .from(agentRuntimes)
            .where(
                and(
                    ne(agentRuntimes.kind, 'external'),
                    ne(agentRuntimes.status, 'stopped'),
                    notInArray(agentRuntimes.framework, CODING_FRAMEWORKS),
                    or(
                        ne(agentRuntimes.kind, 'sprites'),
                        exists(
                            this.db
                                .select({ one: sql`1` })
                                .from(agents)
                                .where(
                                    and(
                                        eq(agents.runtimeId, agentRuntimes.id),
                                        eq(agents.spriteStatus, 'running')
                                    )
                                )
                        )
                    )
                )
            )
            .orderBy(
                sql`(select min(${agents.lastReconciledAt}) from ${agents} where ${agents.runtimeId} = ${agentRuntimes.id}) asc nulls first`
            )
            .limit(SWEEP_TOUCH_LIMIT)
        if (candidates.length === SWEEP_TOUCH_LIMIT)
            this.log.warn(
                `reconcile sweep clipped at ${SWEEP_TOUCH_LIMIT} service runtimes; remainder rotates in on later sweeps`
            )
        for (const runtime of candidates) this.reconcile.touchRuntime(runtime)
    }
}
