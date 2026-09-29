import { createObjectId, frameworkKind } from '@manyfold/shared'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray, ne } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    jsonbMerge,
    type Agent,
    type AgentRuntimeRow,
    type Database,
    type NewAgent
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    K8S_CREATE_CLEANUP_PENDING,
    K8S_CREATE_INITIAL_AGENT
} from '@/modules/agent-runtimes/provisioning/k8s-create-cleanup.service'
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { AppEventsService } from '@/common/events/app-events.service'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import type { RuntimeTarget } from '@/modules/agents/adapters/agent-adapter'
import { buildFileRoots } from '@/modules/agents/bootstrap/file-roots'
import {
    isAgentWorkspaceManaged,
    workspaceExtras
} from '@/modules/agents/workspace/workspace-preflight'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'

const STALE_AFTER_MS = 15_000
const MAX_BACKOFF_MS = 5 * 60_000
const ORPHAN_CONFIRM_MS = 60_000
const ORPHAN_STALE_MS = 5 * ORPHAN_CONFIRM_MS
// Per-runtime distributed claim (#516): the throttle/in-flight maps above are
// process-local, so every API replica used to reconcile the same runtime
// independently. Generous TTL because reconcile can chain 30s adapter execs;
// a clean finish releases immediately, a crashed holder is taken over after
// the TTL.
const RECONCILE_CLAIM_TTL_MS = 2 * 60_000
const reconcileClaimName = (runtimeId: string): string =>
    `agent-reconcile:${runtimeId}`

// An agent the framework itself no longer lists: a lifecycle verdict, not a
// presence one, so it is the one reason reconcile writes agents.status.
export const NOT_PRESENT_IN_RUNTIME = 'not present in runtime'

const isCodingFramework = (runtime: AgentRuntimeRow): boolean =>
    frameworkKind(runtime.framework) === 'coding'

const isPerAgentCodingRuntime = (target: RuntimeTarget): boolean =>
    target.placement === 'sprites' || isCodingFramework(target.runtime)

// The profile a service framework's gateway runs by default. On a sandbox
// or a cloud computer the runtime's primary agent is that profile, its row
// keeping the Manyfold agent id as internalId (ADR-0035).
export const serviceBuiltInProfile = (
    target: Pick<RuntimeTarget, 'placement'> & {
        runtime: Pick<AgentRuntimeRow, 'framework'>
    }
): string | null => {
    if (target.placement !== 'sprites' && target.placement !== 'k8s')
        return null
    if (target.runtime.framework === 'hermes') return 'default'
    if (target.runtime.framework === 'openclaw') return 'main'
    return null
}

// An agent row for the built-in profile is a second row for the profile the
// primary runs as, or keeps for the first agent to join. Removing that agent
// leaves the profile in the framework, which refuses to delete it anyway.
// Seen on staging [2026-09-29]: a Hermes `default` row adopted before
// reconcile mapped the profile to the primary failed every delete with
// "Cannot delete the default profile", and held its runtime and sandbox
// undeletable.
export const isBuiltInProfileAgent = (
    target: Parameters<typeof serviceBuiltInProfile>[0],
    agent: Pick<Agent, 'internalId'>
): boolean => agent.internalId === serviceBuiltInProfile(target)

interface FailureState {
    count: number
    lastMessage: string
}

const failureBackoffMs = (count: number): number =>
    Math.min(STALE_AFTER_MS * 2 ** Math.min(count, 5), MAX_BACKOFF_MS)

@Injectable()
export class AgentReconcileService {
    private readonly log = new Logger(AgentReconcileService.name)
    private readonly inflight = new Map<string, Promise<void>>()
    private readonly lastRun = new Map<string, number>()
    private readonly lastServiceReadyRun = new Map<string, number>()
    private readonly pendingServiceReady = new Map<string, AgentRuntimeRow>()
    private readonly failures = new Map<string, FailureState>()
    private readonly pendingOrphans = new Map<string, Map<string, number>>()
    private readonly claimHolderId =
        process.env.FLY_MACHINE_ID || process.env.HOSTNAME || randomUUID()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly registry: AgentAdapterRegistry,
        private readonly runtimeContext: RuntimeContextService,
        @Optional() private readonly serviceLeases?: ServiceLeaseService,
        @Optional() events?: AppEventsService
    ) {
        events?.on('runtime.service.ready', ({ runtimeId }) => {
            void this.touchReadyRuntime(runtimeId)
        })
    }

    // A service Manyfold just started answers: its agents are listed now,
    // before the host's power reads running.
    private async touchReadyRuntime(runtimeId: string): Promise<void> {
        const [runtime] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        if (runtime) this.touchRuntime(runtime, { serviceReady: true })
    }

    touchRuntime(
        runtime: AgentRuntimeRow,
        opts?: { serviceReady?: boolean }
    ): void {
        // Only a service framework on a machine has anything to learn from a
        // listing; coding frameworks' agents are Manyfold's own rows and an
        // external runtime has no listing at all.
        if (!runtime.hostId || isCodingFramework(runtime)) return
        if (runtime.status !== 'ready') return
        if (this.inflight.has(runtime.id)) {
            if (opts?.serviceReady)
                this.pendingServiceReady.set(runtime.id, runtime)
            return
        }
        const failure = this.failures.get(runtime.id)
        const last = failure
            ? (this.lastRun.get(runtime.id) ?? 0)
            : opts?.serviceReady
              ? (this.lastServiceReadyRun.get(runtime.id) ?? 0)
              : (this.lastRun.get(runtime.id) ?? 0)
        const minWait = failure
            ? failureBackoffMs(failure.count)
            : STALE_AFTER_MS
        if (Date.now() - last < minWait) return
        const p = this.reconcileWithClaim(runtime, opts)
            .then(() => {
                this.failures.delete(runtime.id)
            })
            .catch((err) => this.recordFailure(runtime.id, err))
            .finally(() => {
                this.inflight.delete(runtime.id)
                const finishedAt = Date.now()
                this.lastRun.set(runtime.id, finishedAt)
                if (opts?.serviceReady)
                    this.lastServiceReadyRun.set(runtime.id, finishedAt)
                const pending = this.pendingServiceReady.get(runtime.id)
                if (pending) {
                    this.pendingServiceReady.delete(runtime.id)
                    this.touchRuntime(pending, { serviceReady: true })
                }
            })
        this.inflight.set(runtime.id, p)
    }

    touchAfterWrite(runtimeId: string): void {
        this.lastRun.set(runtimeId, Date.now())
    }

    // Losing the claim is success, not failure: another replica is
    // reconciling this runtime right now, and the local 15s throttle
    // (lastRun is stamped in touchRuntime's finally) keeps this replica
    // from spinning on retries.
    private async reconcileWithClaim(
        runtime: AgentRuntimeRow,
        opts?: { serviceReady?: boolean }
    ): Promise<void> {
        if (!this.serviceLeases) {
            await this.reconcileRuntime(runtime, opts)
            return
        }
        const claim = reconcileClaimName(runtime.id)
        const acquired = await this.serviceLeases.tryAcquireOrRenew(
            claim,
            this.claimHolderId,
            RECONCILE_CLAIM_TTL_MS
        )
        if (!acquired) return
        try {
            await this.reconcileRuntime(runtime, opts)
        } finally {
            await this.serviceLeases
                .release(claim, this.claimHolderId)
                .catch(() => undefined)
        }
    }

    private recordFailure(runtimeId: string, err: unknown): void {
        const message = describeError(err)
        const prev = this.failures.get(runtimeId)
        const next: FailureState = {
            count: (prev?.count ?? 0) + 1,
            lastMessage: message
        }
        this.failures.set(runtimeId, next)
        const repeated = prev && prev.lastMessage === message
        const line = `reconcile failed runtime=${runtimeId} (attempt ${next.count}, next retry in ${failureBackoffMs(next.count)}ms): ${message}`
        if (repeated) this.log.debug(line)
        else this.log.warn(line)
    }

    async reconcileRuntime(
        runtime: AgentRuntimeRow,
        opts?: { serviceReady?: boolean }
    ): Promise<void> {
        const ctx = await this.runtimeContext.forRuntime(runtime.id)
        if (!ctx || ctx.placement === 'external') return
        runtime = ctx.runtime
        if (runtime.status !== 'ready' || isCodingFramework(runtime)) {
            this.pendingOrphans.delete(runtime.id)
            return
        }
        if (
            ctx.placement === 'k8s' &&
            (runtime.currentPhase === K8S_CREATE_INITIAL_AGENT ||
                runtime.currentPhase === K8S_CREATE_CLEANUP_PENDING)
        )
            return

        const existing = await this.db
            .select()
            .from(agents)
            .where(eq(agents.runtimeId, runtime.id))
        // Listing goes through the host's daemon, so a machine that is not
        // running (or whose daemon is away) is not listed: waking a sandbox
        // bills it, and pre-sleep miss evidence is stale once the service
        // restarts. A service that just answered its health check is up
        // post-boot — serviceReady bypasses ONLY the power check; the 15s
        // min-wait/failure backoff in touchRuntime still bounds repeats.
        if (
            !ctx.daemonOnline ||
            (!opts?.serviceReady &&
                ctx.host?.kind === 'hosted' &&
                ctx.host.powerState !== 'running')
        ) {
            this.pendingOrphans.delete(runtime.id)
            return
        }

        const adapter = this.registry.get(runtime.framework)
        const live = await adapter.listAgents({
            ...ctx,
            primaryAgentId: runtime.primaryAgentId ?? null
        })
        const existingByInternal = new Map(
            existing.map((a) => [a.internalId, a])
        )
        const liveIds = new Set(live.map((l) => l.id))
        const primary = runtime.primaryAgentId
            ? existing.find((a) => a.id === runtime.primaryAgentId)
            : undefined
        const primaryAlias = serviceBuiltInProfile(ctx)
        const primaryHasExactLiveProfile =
            primary !== undefined &&
            live.some((fa) => fa.id === primary.internalId)
        const now = new Date()

        for (const fa of live) {
            let match = existingByInternal.get(fa.id)
            let matchedPrimaryAlias = false
            if (!match && primary && fa.id === primaryAlias) {
                // Service provisioning keeps the primary row's internalId equal
                // to its Manyfold agent id, while Hermes/OpenClaw expose that
                // same built-in profile as default/main. If a promoted
                // secondary's exact profile is live, the built-in profile is
                // the deleted primary's residue and must not become a phantom.
                if (primaryHasExactLiveProfile) continue
                match = primary
                matchedPrimaryAlias = true
                liveIds.add(primary.internalId)
            }
            if (match) {
                const workspacePath = fa.workspace ?? match.workspacePath
                const workspaceManaged = isAgentWorkspaceManaged(match)
                const extrasPatch = workspaceExtras(
                    workspaceManaged,
                    safeExtras(fa.extras)
                )
                // default/main are framework implementation names, not the
                // user-facing name chosen for the Manyfold primary.
                const renamed = matchedPrimaryAlias
                    ? null
                    : await this.resolveNameSync(match, fa.name)
                const wasOrphaned =
                    match.status === 'failed' &&
                    match.failureReason === NOT_PRESENT_IN_RUNTIME
                await this.db
                    .update(agents)
                    .set({
                        ...(renamed !== null ? { name: renamed } : {}),
                        model: fa.model,
                        extras: jsonbMerge(agents.extras, extrasPatch),
                        workspacePath,
                        ...(wasOrphaned
                            ? { status: 'ready', failureReason: null }
                            : {}),
                        mountPath:
                            isPerAgentCodingRuntime(ctx) || !workspaceManaged
                                ? (workspacePath ?? runtime.mountPath)
                                : runtime.mountPath,
                        lastReconciledAt: now,
                        updatedAt: now
                    })
                    .where(eq(agents.id, match.id))
            } else {
                // A runtime prepared with no agent (a sandbox's or a cloud
                // computer's) keeps its built-in profile for the first agent
                // that joins. Seen on local [2026-09-29]: adopted, OpenClaw's
                // `main` became an agent that could not be deleted ("the only
                // configured agent") and held its runtime undeletable.
                if (!runtime.primaryAgentId && fa.id === primaryAlias) continue
                // Only service frameworks reach this listing, and they list
                // their own state: an agent created outside Manyfold (in the
                // framework's own UI) is real and must be adopted —
                // everything keyed off its internalId (managed automations,
                // managed channels) can only mirror once a row exists (#462).
                const newAgent: NewAgent = {
                    id: createObjectId('agent'),
                    userId: runtime.userId,
                    runtimeId: runtime.id,
                    framework: runtime.framework,
                    name: fa.name || fa.id,
                    internalId: fa.id,
                    status: 'ready',
                    model: fa.model,
                    extras: fa.extras,
                    workspacePath: fa.workspace ?? runtime.mountPath,
                    mountPath: runtime.mountPath,
                    fileRoots: buildFileRoots({
                        framework: runtime.framework,
                        runtime: ctx.placement,
                        mountPath: runtime.mountPath,
                        homeDir: ctx.host?.homeDir
                    }),
                    startedAt: now,
                    lastBootstrappedAt: now,
                    lastReconciledAt: now
                }
                await this.db.insert(agents).values(newAgent)
            }
        }

        // a single empty listing is indistinguishable from a fresh-boot race,
        // so require a second confirmed-empty observation >= 60s later
        const missing = existing.filter(
            (a) =>
                !liveIds.has(a.internalId) &&
                !(
                    a.status === 'failed' &&
                    a.failureReason === NOT_PRESENT_IN_RUNTIME
                )
        )
        const pending =
            this.pendingOrphans.get(runtime.id) ?? new Map<string, number>()
        const missingIds = new Set(missing.map((a) => a.id))
        for (const id of [...pending.keys()])
            if (!missingIds.has(id)) pending.delete(id)
        const orphanIds: string[] = []
        for (const a of missing) {
            const firstMissedAt = pending.get(a.id)
            if (firstMissedAt === undefined) {
                pending.set(a.id, now.getTime())
                this.log.warn(
                    `reconcile: agent ${a.id} missing from runtime ${runtime.id}; awaiting confirmation`
                )
            } else if (now.getTime() - firstMissedAt >= ORPHAN_STALE_MS) {
                // reconcile is touch-driven, so miss evidence this old likely
                // predates an unobserved sleep/wake (the sleep-skip clear only
                // runs if a touch lands while the machine sleeps) — re-arm
                // instead of confirming against a post-wake fresh-boot listing
                pending.set(a.id, now.getTime())
                this.log.warn(
                    `reconcile: agent ${a.id} miss evidence on runtime ${runtime.id} is stale; restarting confirmation window`
                )
            } else if (now.getTime() - firstMissedAt >= ORPHAN_CONFIRM_MS) {
                pending.delete(a.id)
                orphanIds.push(a.id)
            }
        }
        if (pending.size > 0) this.pendingOrphans.set(runtime.id, pending)
        else this.pendingOrphans.delete(runtime.id)
        if (orphanIds.length > 0)
            await this.db
                .update(agents)
                .set({
                    status: 'failed',
                    failureReason: NOT_PRESENT_IN_RUNTIME,
                    lastReconciledAt: now,
                    updatedAt: now
                })
                .where(
                    and(
                        inArray(agents.id, orphanIds),
                        eq(agents.runtimeId, runtime.id)
                    )
                )
    }

    async contextFor(runtimeId: string): Promise<RuntimeContext | null> {
        return this.runtimeContext.forRuntime(runtimeId)
    }

    async loadRuntime(runtimeId: string): Promise<AgentRuntimeRow | null> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        return row ?? null
    }

    private async resolveNameSync(
        match: Agent,
        incoming: string
    ): Promise<string | null> {
        if (!incoming || incoming === match.name) return null
        const [duplicate] = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(
                and(
                    eq(agents.userId, match.userId),
                    eq(agents.name, incoming),
                    ne(agents.id, match.id)
                )
            )
            .limit(1)
        if (duplicate) {
            this.log.warn(
                `reconcile: agent ${match.id} rename to "${incoming}" collides with sibling ${duplicate.id} — skipping name sync`
            )
            return null
        }
        return incoming
    }
}

const describeError = (err: unknown): string => {
    if (err instanceof Error) return err.message || err.name || 'Error'
    if (err && typeof err === 'object') {
        const obj = err as Record<string, unknown>
        const reason = typeof obj.message === 'string' ? obj.message : null
        const code = obj.statusCode ?? obj.code
        const body =
            typeof obj.body === 'string'
                ? obj.body
                : obj.body
                  ? JSON.stringify(obj.body)
                  : null
        const parts = [
            reason,
            code !== undefined ? `(code ${String(code)})` : null,
            body ? `body=${body}` : null
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

const safeExtras = (
    value: Agent['extras'] | Record<string, unknown> | null | undefined
): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
