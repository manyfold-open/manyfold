import { createObjectId } from '@manyfold/shared'
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
import { ServiceLeaseService } from '@/common/leases/service-lease.service'
import { AgentAdapterRegistry } from '@/modules/agents/adapters/adapter-registry'
import { buildFileRoots } from '@/modules/agents/bootstrap/file-roots'
import {
    isAgentWorkspaceManaged,
    workspaceExtras
} from '@/modules/agents/workspace/workspace-preflight'

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

const isCodingFramework = (runtime: AgentRuntimeRow): boolean =>
    runtime.framework === 'claude-code' ||
    runtime.framework === 'codex' ||
    runtime.framework === 'gemini-cli'

const isPerAgentCodingRuntime = (runtime: AgentRuntimeRow): boolean =>
    runtime.kind === 'sprites' ||
    ((runtime.kind === 'k8s' || runtime.kind === 'daemon') &&
        isCodingFramework(runtime))

const serviceSpritePrimaryAlias = (runtime: AgentRuntimeRow): string | null => {
    if (runtime.kind !== 'sprites') return null
    if (runtime.framework === 'hermes') return 'default'
    if (runtime.framework === 'openclaw') return 'main'
    return null
}

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
    private readonly lastVerifiedReportRun = new Map<string, number>()
    private readonly pendingVerifiedReports = new Map<string, AgentRuntimeRow>()
    private readonly failures = new Map<string, FailureState>()
    private readonly pendingOrphans = new Map<string, Map<string, number>>()
    private readonly claimHolderId =
        process.env.FLY_MACHINE_ID || process.env.HOSTNAME || randomUUID()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly registry: AgentAdapterRegistry,
        @Optional() private readonly serviceLeases?: ServiceLeaseService
    ) {}

    touchRuntime(
        runtime: AgentRuntimeRow,
        opts?: { verifiedByReport?: boolean }
    ): void {
        if (runtime.kind === 'external') return
        // A stopped runtime cannot change state on its own: every writer that
        // stops a runtime already converges its agents rows inline, and the
        // reconcile sweep backstops stragglers set-based. Reconciling here
        // would only re-issue the same stopped UPDATE forever (#516).
        if (runtime.status === 'stopped') return
        if (this.inflight.has(runtime.id)) {
            if (opts?.verifiedByReport)
                this.pendingVerifiedReports.set(runtime.id, runtime)
            return
        }
        const failure = this.failures.get(runtime.id)
        const last = failure
            ? (this.lastRun.get(runtime.id) ?? 0)
            : opts?.verifiedByReport
              ? (this.lastVerifiedReportRun.get(runtime.id) ?? 0)
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
                if (opts?.verifiedByReport)
                    this.lastVerifiedReportRun.set(runtime.id, finishedAt)
                const pending = this.pendingVerifiedReports.get(runtime.id)
                if (pending) {
                    this.pendingVerifiedReports.delete(runtime.id)
                    this.touchRuntime(pending, { verifiedByReport: true })
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
        opts?: { verifiedByReport?: boolean }
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
        opts?: { verifiedByReport?: boolean }
    ): Promise<void> {
        if (runtime.status === 'stopped') {
            this.pendingOrphans.delete(runtime.id)
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
                        eq(agents.runtimeId, runtime.id),
                        ne(agents.status, 'stopped')
                    )
                )
            return
        }

        // Coding-framework listAgents reads the agents table itself (the
        // adapters return the runtime's own rows), so the generic reconcile
        // below is a circular DB copy: it SELECTs the rows, "lists" the same
        // rows again through the adapter, and rewrites every one of them with
        // fresh timestamps (#516). The only state it owns that no lifecycle
        // writer covers is healing false-stopped rows on an active runtime;
        // corrupt legacy rows (internalId != id, stopped by the old orphan
        // flow) must stay stopped, exactly like the matched-loop's internalId
        // keying kept them out of the resurrect.
        if (isCodingFramework(runtime)) {
            this.pendingOrphans.delete(runtime.id)
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
                        eq(agents.runtimeId, runtime.id),
                        eq(agents.status, 'stopped'),
                        eq(agents.internalId, agents.id)
                    )
                )
            return
        }

        const existing = await this.db
            .select()
            .from(agents)
            .where(eq(agents.runtimeId, runtime.id))
        // listing a service-framework sprite wakes the VM (billing + the #108
        // wake race), and pre-sleep miss evidence is stale once the service restarts.
        // A fence-valid ready report proves the service is up post-boot, voiding
        // both reasons — verifiedByReport bypasses ONLY this skip; the 15s
        // min-wait/failure backoff in touchRuntime still bound report floods.
        if (
            !opts?.verifiedByReport &&
            runtime.kind === 'sprites' &&
            !existing.some((a) => a.spriteStatus === 'running')
        ) {
            this.pendingOrphans.delete(runtime.id)
            return
        }

        const adapter = this.registry.get(runtime.framework)
        const live = await adapter.listAgents({
            runtime,
            primaryAgentId: runtime.primaryAgentId ?? null
        })
        const existingByInternal = new Map(
            existing.map((a) => [a.internalId, a])
        )
        const liveIds = new Set(live.map((l) => l.id))
        const primary = runtime.primaryAgentId
            ? existing.find((a) => a.id === runtime.primaryAgentId)
            : undefined
        const primaryAlias = serviceSpritePrimaryAlias(runtime)
        const primaryHasExactLiveProfile =
            primary !== undefined &&
            live.some((fa) => fa.id === primary.internalId)
        const now = new Date()

        for (const fa of live) {
            let match = existingByInternal.get(fa.id)
            let matchedPrimaryAlias = false
            if (!match && primary && fa.id === primaryAlias) {
                // Sprite provisioning keeps the primary row's internalId equal
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
                await this.db
                    .update(agents)
                    .set({
                        ...(renamed !== null ? { name: renamed } : {}),
                        model: fa.model,
                        extras: jsonbMerge(agents.extras, extrasPatch),
                        workspacePath,
                        status:
                            match.status === 'stopped'
                                ? 'running'
                                : match.status,
                        failureReason:
                            match.status === 'stopped'
                                ? null
                                : match.failureReason,
                        spriteName: runtime.spriteName,
                        spriteId: runtime.spriteId,
                        namespace: runtime.namespace,
                        ingressHost: runtime.ingressHost,
                        mountPath:
                            isPerAgentCodingRuntime(runtime) ||
                            !workspaceManaged
                                ? (workspacePath ?? runtime.mountPath)
                                : runtime.mountPath,
                        accountId: runtime.accountId,
                        clusterId: runtime.clusterId,
                        lastReconciledAt: now,
                        updatedAt: now
                    })
                    .where(eq(agents.id, match.id))
            } else {
                // Only service frameworks reach this listing (coding
                // frameworks take the fast path above), and they list their
                // own state: an agent created outside Manyfold (NarraNexus /
                // hermes / openclaw own UI) is real and must be adopted —
                // everything keyed off its internalId (managed automations,
                // managed channels) can only mirror once a row exists (#462).
                const newAgent: NewAgent = {
                    id: createObjectId('agent'),
                    userId: runtime.userId,
                    runtimeId: runtime.id,
                    framework: runtime.framework,
                    runtime: runtime.kind,
                    name: fa.name || fa.id,
                    internalId: fa.id,
                    status: 'running',
                    model: fa.model,
                    extras: fa.extras,
                    workspacePath: fa.workspace ?? runtime.mountPath,
                    mountPath: runtime.mountPath,
                    fileRoots: buildFileRoots({
                        framework: runtime.framework,
                        runtime: runtime.kind,
                        mountPath: runtime.mountPath
                    }),
                    namespace: runtime.namespace,
                    ingressHost: runtime.ingressHost,
                    spriteName: runtime.spriteName,
                    spriteId: runtime.spriteId,
                    clusterId: runtime.clusterId,
                    accountId: runtime.accountId,
                    daemonId: runtime.daemonId,
                    hostId: runtime.hostId,
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
            (a) => !liveIds.has(a.internalId) && a.status !== 'stopped'
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
                // runs if a touch lands while the sprite sleeps) — re-arm
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
                    status: 'stopped',
                    failureReason: 'not present in runtime',
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
