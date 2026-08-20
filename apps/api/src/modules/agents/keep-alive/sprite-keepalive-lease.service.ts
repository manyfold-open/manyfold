import {
    HERMES_DASHBOARD_SERVICE,
    HERMES_PROXY_SERVICE,
    PLATFORM_TASK_PREFIX,
    isExternal
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentKeepAliveRelease
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    type AgentRuntimeRow,
    type Database,
    type SpritesAccount
} from '@manyfold/db'
import {
    buildKeepAliveCleanupScript,
    buildKeepAliveLeaseScript,
    buildRuntimeReportEnvFile,
    buildRuntimeReportScript,
    buildServiceStartScript,
    createClient,
    execSprite,
    spriteWriteFile,
    SpritesError,
    type ExecOptions,
    type ExecResult,
    type SpriteWriteFileArgs,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { ensureRuntimeReportToken } from '@/modules/agents/keep-alive/runtime-report-token'
import { HERMES_PORT } from '@/modules/agents/bootstrap/hermes-shared'
import { OPENCLAW_PORT } from '@/modules/agents/bootstrap/openclaw-shared'
import { NARRANEXUS_PORT } from '@/modules/agents/bootstrap/narranexus-k8s'

const KEEPALIVE_TTL = '5m'
const KEEPALIVE_TTL_SEC = 300
const KEEPALIVE_REFRESH_SEC = 60
const RELEASE_READY_SEC = 90
// Per-pass action caps: bound the deploy-moment exec storm (Pass A over a
// large un-converged legacy fleet) and background wakes (Pass B).
const RECONCILE_MAX_ACTIONS_PER_TICK = 5
// +120s after ANY ensure attempt — covers the ≤30s slow-cadence status-sync
// visibility lag plus spin-up, preventing double-wakes before the running
// flip lands.
const ENSURE_RETRY_AFTER_MS = 120_000
const ENSURE_MAX_BACKOFF_MS = 5 * 60_000
const REPORT_PROBE_BUDGET_SEC = 120

const ensureBackoffMs = (failures: number): number =>
    Math.min(60_000 * 2 ** Math.min(failures, 5), ENSURE_MAX_BACKOFF_MS)

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

type ServiceFramework = 'hermes' | 'openclaw' | 'narranexus'
type DesiredState = 'running' | 'stopped'

export interface SpriteKeepAliveMetadata {
    // Set only for service-kind frameworks; exec-kind (coding) sprites run a
    // lease-only keep-alive with no framework service to name.
    serviceName?: ServiceFramework
    taskPrefix: string
    taskName: string
    generation: string
    ttlSec: number
    refreshSec: number
    desiredState: DesiredState
    stateDir: string
    startScriptPath: string
    exec: string[]
    legacyTaskNames: string[]
    desiredStateAt?: string
    lastVerifiedAt?: string
    lastError?: string
}

interface CleanupSummary {
    deletedTasks: string[]
    remainingTasks: string[]
    killedPids: number[]
    errors: unknown[]
}

interface MatchingTasksResult {
    tasks: string[]
    error?: string
}

interface InstallInput {
    runtimeId: string
    framework: ServiceFramework
    serviceName: ServiceFramework
    client: SpritesClient
    spriteName: string
    homeDir: string
    exec: string[]
    legacyTaskNames: string[]
    // The credentials row does not exist yet at install time — the bootstrap
    // mints the report token and the orchestrator persists it afterwards.
    reportToken: string
    logger?: SpritesLogger
}

@Injectable()
export class SpriteKeepAliveLeaseService {
    private readonly log = new Logger(SpriteKeepAliveLeaseService.name)
    private readonly ensureNextEligibleAt = new Map<string, number>()
    private readonly ensureFailures = new Map<string, number>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly runtimes: AgentRuntimesService,
        private readonly telemetry: TelemetryService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly crypto: CryptoService,
        private readonly config: ConfigService
    ) {}

    async install(input: InstallInput): Promise<SpriteKeepAliveMetadata> {
        const metadata = this.nextMetadata({
            runtimeId: input.runtimeId,
            framework: input.framework,
            serviceName: input.serviceName,
            homeDir: input.homeDir,
            exec: input.exec,
            legacyTaskNames: input.legacyTaskNames,
            desiredState: 'stopped'
        })
        await this.writeStartScript(
            input.client,
            input.spriteName,
            input.runtimeId,
            metadata,
            { reportToken: input.reportToken, logger: input.logger }
        )
        // A fresh sprite is verified-leaseless by construction; the shared
        // clock reading in patchMetadata stamps lastVerifiedAt at-or-after
        // desiredStateAt, which keeps reconcile Pass A from ever exec'ing
        // fresh runtimes.
        await this.patchMetadata(input.runtimeId, metadata, { verified: true })
        return metadata
    }

    /**
     * Wake the framework service if it is not running. Never touches the
     * lease and never writes desiredState — traffic wake must not resurrect
     * a lease the user turned off. The pre-start FULL cleanup preserves
     * today's straggler/port clearing (and deletes tasks — which is why
     * `wakeSpriteRuntime` re-leases on started:true for enabled runtimes).
     */
    async ensureServiceRunning(
        runtime: AgentRuntimeRow
    ): Promise<{ started: boolean }> {
        if (
            runtime.kind !== 'sprites' ||
            !this.isServiceFramework(runtime.framework)
        ) {
            return { started: false }
        }
        const ctx = await this.clientFor(runtime)
        if (!ctx) return { started: false }

        // With the hermes dashboard enabled the public route lives on the
        // proxy service — waking only the gateway would leave chat dead, so
        // the whole topology is checked and started in dependency order.
        const serviceNames = this.serviceNamesFor(runtime)
        const notRunning: string[] = []
        for (const name of serviceNames) {
            try {
                const service = await ctx.client.getService(
                    ctx.spriteName,
                    name
                )
                if (service.state.status !== 'running') notRunning.push(name)
            } catch (err) {
                if (isSpritesNotFound(err)) {
                    notRunning.push(name)
                } else {
                    this.log.warn(
                        `getService ${name} on ${ctx.spriteName} failed before start: ${(err as Error).message}`
                    )
                    notRunning.push(name)
                }
            }
        }
        if (notRunning.length === 0) return { started: false }

        const base = this.metadataFor(runtime) ?? this.fallbackMetadata(runtime)
        // Rewrite start.sh before starting — a fused legacy script can never
        // run again via the wake path.
        await this.writeStartScript(ctx.client, ctx.spriteName, runtime.id, base)
        await this.runCleanup(ctx.client, ctx.spriteName, base, {
            killAppProcesses: true,
            killStartScriptProcesses: true
        })
        for (const name of serviceNames) {
            if (!notRunning.includes(name)) continue
            try {
                await ctx.client.startService(ctx.spriteName, name)
            } catch (err) {
                if (!isSpritesNotFound(err)) {
                    this.log.warn(
                        `startService ${name} on ${ctx.spriteName} failed: ${(err as Error).message}`
                    )
                }
            }
        }
        try {
            await this.runtimes.applyServiceReportPatch(runtime.id, {
                serviceStatus: 'starting',
                serviceStatusAt: new Date()
            })
        } catch (err) {
            this.log.warn(
                `service status patch failed for ${runtime.id}: ${(err as Error).message}`
            )
        }
        return { started: true }
    }

    /**
     * Establish (or re-establish) the keep-alive lease loop. Never starts or
     * stops the framework service — toggling on must not restart a mid-turn
     * agent. The pre-spawn lease-only cleanup kills any existing renewer
     * (legacy fused subshell via the shared renew.pid, or a stale loop) so
     * exactly one canonical renewer survives.
     */
    async ensureLease(runtime: AgentRuntimeRow): Promise<void> {
        if (!this.isLeaseEligible(runtime)) return
        const isService = this.isServiceFramework(runtime.framework)
        const ctx = await this.clientFor(runtime)
        if (!ctx) return

        const base = this.metadataFor(runtime) ?? this.fallbackMetadata(runtime)
        const next = this.nextMetadata({
            runtimeId: runtime.id,
            framework: runtime.framework,
            serviceName: this.isServiceFramework(runtime.framework)
                ? runtime.framework
                : undefined,
            homeDir: this.homeDirFor(runtime, base),
            exec: base.exec,
            legacyTaskNames: base.legacyTaskNames,
            desiredState: 'running'
        })
        // Cleanup runs against the STORED metadata: the old renewer's
        // renew.pid/taskName live wherever the previous generation put them,
        // and `next` would diverge if the stateDir derivation ever changes.
        await this.runCleanup(ctx.client, ctx.spriteName, base, {
            killAppProcesses: false,
            killStartScriptProcesses: false
        })
        // Closes the resurrection hole where a platform service-restart of an
        // enabled un-converged legacy sprite re-runs the fused on-disk script.
        // Exec-kind sprites have no managed start.sh, so there is nothing to
        // converge — the lease loop below is the whole keep-alive.
        if (isService)
            await this.writeStartScript(
                ctx.client,
                ctx.spriteName,
                runtime.id,
                next
            )
        const leaseScript = buildKeepAliveLeaseScript({
            taskName: next.taskName,
            taskPrefix: next.taskPrefix,
            ttl: KEEPALIVE_TTL,
            refreshIntervalSeconds: next.refreshSec,
            stateDir: next.stateDir
        })
        await this.writeFile(ctx.client, ctx.spriteName, {
            absPath: `${next.stateDir}/keepalive.sh`,
            body: Buffer.from(leaseScript, 'utf8'),
            mode: '755',
            timeoutMs: 30_000
        })
        await this.exec(ctx.client, ctx.spriteName, {
            cmd: [
                'bash',
                '-lc',
                `setsid nohup bash '${next.stateDir}/keepalive.sh' </dev/null >/dev/null 2>&1 & echo ok`
            ],
            stdin: '',
            timeoutMs: 30_000,
            keepAliveMs: 5_000,
            livenessTimeoutMs: 15_000
        })
        // The spawn is detached; task_create lands ~100ms-1s later.
        let observed = await this.matchingTasks(
            ctx.client,
            ctx.spriteName,
            next
        )
        for (
            let attempt = 1;
            attempt < 3 && (observed.tasks.length === 0 || observed.error);
            attempt++
        ) {
            await sleep(1_000)
            observed = await this.matchingTasks(ctx.client, ctx.spriteName, next)
        }
        const verified = observed.tasks.length > 0 && !observed.error
        await this.patchMetadata(
            runtime.id,
            {
                ...next,
                lastError: verified
                    ? undefined
                    : observed.error
                      ? `keep-alive task verification failed: ${observed.error}`
                      : `keep-alive task ${next.taskName} not observed after spawn`
            },
            { verified }
        )
        // A disable racing this ensure may have run its lease-only cleanup
        // BEFORE the spawn above, leaving a renewing loop on a runtime whose
        // column already reads false. Re-check and release deterministically.
        const fresh = await this.runtimes.findById(runtime.id)
        if (fresh && fresh.keepAliveEnabled === false) {
            await this.releaseLease(fresh, 'ensure-raced-disable')
        }
    }

    /**
     * Lease-only release: kills the renewer pid, deletes tasks, rewrites
     * start.sh (legacy convergence) and patches desiredState 'stopped'.
     * NEVER calls stopService — this is the no-restart toggle-off and the
     * reconcile loop's only action.
     */
    async releaseLease(
        runtime: AgentRuntimeRow,
        reason: string
    ): Promise<{ verified: boolean }> {
        if (!this.isLeaseEligible(runtime)) {
            return { verified: false }
        }
        const base = this.metadataFor(runtime) ?? this.fallbackMetadata(runtime)
        const ctx = await this.clientFor(runtime)
        if (!ctx) {
            await this.patchMetadata(runtime.id, {
                ...base,
                desiredState: 'stopped',
                lastError: 'sprites account or sprite name missing'
            })
            return { verified: false }
        }

        const cleanup = await this.runCleanup(ctx.client, ctx.spriteName, base, {
            killAppProcesses: false,
            killStartScriptProcesses: false
        })
        // Legacy start.sh convergence is a service-kind concern; exec-kind
        // sprites have no managed start.sh to rewrite.
        if (this.isServiceFramework(runtime.framework))
            await this.writeStartScript(
                ctx.client,
                ctx.spriteName,
                runtime.id,
                base
            )
        const remaining = await this.matchingTasks(
            ctx.client,
            ctx.spriteName,
            base
        )
        const verified = remaining.tasks.length === 0 && !remaining.error
        const message = verified
            ? undefined
            : remaining.error
              ? `keep-alive task verification failed: ${remaining.error}`
              : `keep-alive tasks still present: ${remaining.tasks.join(', ')}`
        await this.patchMetadata(
            runtime.id,
            {
                ...base,
                desiredState: 'stopped',
                lastError:
                    message ??
                    (cleanup.errors.length > 0
                        ? `cleanup errors: ${JSON.stringify(cleanup.errors).slice(0, 512)}`
                        : undefined)
            },
            { verified }
        )
        if (!verified) {
            this.telemetry.event('sprite_keepalive_release_degraded', {
                runtimeId: runtime.id,
                framework: runtime.framework,
                spriteName: runtime.spriteName,
                reason,
                remainingTasks: remaining.tasks.length
            })
        }
        return { verified }
    }

    async stopAndRelease(
        runtime: AgentRuntimeRow,
        reason: string
    ): Promise<AgentKeepAliveRelease> {
        if (!this.isLeaseEligible(runtime)) {
            return { state: 'not_applicable', maxStaleSec: 0 }
        }
        // Exec-kind (coding) sprites have no framework service to stop —
        // releasing the lease deletes the renewing task, after which the
        // sprite suspends on its own once idle. No stopService, so an
        // in-flight chat exec is never interrupted.
        if (!this.isServiceFramework(runtime.framework)) {
            // Nothing to release if this sprite never held a lease: skip the
            // sprite exec round-trips (and the false 'degraded' telemetry a
            // transient task-list read could otherwise emit) for the common
            // case of stopping a coding agent that never enabled keep-alive.
            if (!runtime.keepAliveEnabled && !this.metadataFor(runtime)) {
                return { state: 'not_applicable', maxStaleSec: 0 }
            }
            const { verified } = await this.releaseLease(runtime, reason)
            return {
                state: verified ? 'verified' : 'degraded',
                maxStaleSec: verified
                    ? RELEASE_READY_SEC
                    : KEEPALIVE_TTL_SEC + RELEASE_READY_SEC
            }
        }
        const base = this.metadataFor(runtime) ?? this.fallbackMetadata(runtime)
        try {
            return await this.runStopAndRelease(runtime, reason, base)
        } catch (err) {
            const message = `stopAndRelease error: ${(err as Error).message}`
            this.log.warn(
                `stopAndRelease ${runtime.framework} on ${runtime.spriteName} threw: ${(err as Error).message}`
            )
            await this.patchMetadata(runtime.id, {
                ...base,
                desiredState: 'stopped',
                lastError: message
            })
            this.telemetry.event('sprite_keepalive_release_degraded', {
                runtimeId: runtime.id,
                framework: runtime.framework,
                spriteName: runtime.spriteName,
                reason,
                error: (err as Error).message
            })
            return {
                state: 'degraded',
                maxStaleSec: base.ttlSec + RELEASE_READY_SEC,
                message
            }
        }
    }

    private async runStopAndRelease(
        runtime: AgentRuntimeRow,
        reason: string,
        base: SpriteKeepAliveMetadata
    ): Promise<AgentKeepAliveRelease> {
        const ctx = await this.clientFor(runtime)
        if (!ctx) {
            const degraded = {
                ...base,
                desiredState: 'stopped' as const,
                lastError: 'sprites account or sprite name missing'
            }
            await this.patchMetadata(runtime.id, degraded)
            return {
                state: 'degraded',
                maxStaleSec: base.ttlSec + RELEASE_READY_SEC,
                message: degraded.lastError
            }
        }

        // Clear the report fence BEFORE stopService so in-flight reports
        // from the dying boot 409 even before the stopped guards land.
        await this.patchServiceReportFence(runtime.id, null)

        // Kill the renewer while renew.pid is still valid: a legacy fused
        // start.sh's EXIT trap rm's renew.pid when stopService TERMs the
        // parent shell, which would orphan a v2 lease loop past the FULL
        // cleanup below (the loop re-creates its task forever, the sprite
        // never sleeps).
        await this.runCleanup(ctx.client, ctx.spriteName, base, {
            killAppProcesses: false,
            killStartScriptProcesses: false
        })

        let serviceMessage: string | undefined
        // Reverse order: drop the public route (proxy) before its upstreams.
        for (const name of [...this.serviceNamesFor(runtime)].reverse()) {
            try {
                const service = await ctx.client.stopService(
                    ctx.spriteName,
                    name
                )
                if (service.state.status !== 'stopped') {
                    serviceMessage = `service ${name} status=${service.state.status}`
                    this.log.warn(
                        `stopService ${name} on ${ctx.spriteName} returned ${serviceMessage}`
                    )
                }
            } catch (err) {
                if (!isSpritesNotFound(err)) {
                    serviceMessage = `stopService ${name} failed: ${(err as Error).message}`
                    this.log.warn(
                        `stopService ${name} on ${ctx.spriteName} failed: ${(err as Error).message}`
                    )
                }
            }
        }

        const cleanup = await this.runCleanup(
            ctx.client,
            ctx.spriteName,
            base,
            {
                killAppProcesses: true,
                killStartScriptProcesses: true
            }
        )
        // The only downward writer of service_status — platform-initiated
        // stop. Report-driven paths are structurally unable to produce
        // 'stopped' (see the daemon-divergence note in
        // runtime-reports.service.ts).
        try {
            await this.runtimes.applyServiceReportPatch(runtime.id, {
                serviceStatus: 'stopped',
                serviceStatusAt: new Date()
            })
        } catch (err) {
            this.log.warn(
                `service status patch failed for ${runtime.id}: ${(err as Error).message}`
            )
        }
        const remaining = await this.matchingTasks(
            ctx.client,
            ctx.spriteName,
            base
        )
        const verified = remaining.tasks.length === 0 && !remaining.error
        const message = verified
            ? undefined
            : remaining.error
              ? `keep-alive task verification failed: ${remaining.error}`
              : `keep-alive tasks still present: ${remaining.tasks.join(', ')}`
        const lastError =
            message ??
            (cleanup.errors.length > 0
                ? `cleanup errors: ${JSON.stringify(cleanup.errors).slice(0, 512)}`
                : serviceMessage)

        await this.patchMetadata(
            runtime.id,
            {
                ...base,
                desiredState: 'stopped',
                lastError
            },
            { verified }
        )

        if (verified) {
            return {
                state: 'verified',
                maxStaleSec: RELEASE_READY_SEC,
                message: serviceMessage
            }
        }
        this.telemetry.event('sprite_keepalive_release_degraded', {
            runtimeId: runtime.id,
            framework: runtime.framework,
            spriteName: runtime.spriteName,
            reason,
            remainingTasks: remaining.tasks.length
        })
        return {
            state: 'degraded',
            maxStaleSec: base.ttlSec + RELEASE_READY_SEC,
            message
        }
    }

    async reconcileLeases(): Promise<void> {
        await this.reconcileReleasePass()
        await this.reconcileEnsurePass()
    }

    /**
     * Pass A — converge disabled-but-leased runtimes to default-off: the
     * un-converged legacy fleet (desiredState 'running') and degraded-release
     * retries. Acts via releaseLease, never stopService — under default-off
     * every chat-woken disabled sprite is desiredState 'stopped' +
     * spriteStatus 'running', and stopping its service would kill the
     * framework mid-conversation every ~90s.
     */
    private async reconcileReleasePass(): Promise<void> {
        const rows = await this.db
            .select({
                runtime: agentRuntimes,
                spriteStatus: agents.spriteStatus
            })
            .from(agentRuntimes)
            .innerJoin(agents, eq(agents.runtimeId, agentRuntimes.id))
            .where(
                and(
                    // All sprite frameworks — kind='sprites' excludes external
                    // by construction, so coding-agent leases converge here too.
                    eq(agentRuntimes.kind, 'sprites'),
                    eq(agentRuntimes.keepAliveEnabled, false),
                    eq(agents.spriteStatus, 'running')
                )
            )

        const seen = new Set<string>()
        const now = Date.now()
        let released = 0
        for (const row of rows) {
            const runtime = row.runtime
            if (seen.has(runtime.id)) continue
            seen.add(runtime.id)
            const metadata = this.metadataFor(runtime)
            if (!metadata) continue
            if (metadata.desiredState === 'stopped') {
                const anchor = metadata.desiredStateAt ?? runtime.updatedAt
                // lastVerifiedAt >= desiredStateAt = the release landed; this
                // gate is what stops the loop from exec-spamming every
                // legitimately chat-active disabled sprite.
                if (
                    metadata.lastVerifiedAt &&
                    new Date(metadata.lastVerifiedAt).getTime() >=
                        new Date(anchor).getTime()
                ) {
                    continue
                }
                if (
                    metadata.lastVerifiedAt &&
                    now - new Date(metadata.lastVerifiedAt).getTime() <
                        RELEASE_READY_SEC * 1000
                ) {
                    continue
                }
                const ageSec = Math.floor(
                    (now - new Date(anchor).getTime()) / 1000
                )
                if (ageSec < RELEASE_READY_SEC) continue
                if (ageSec > metadata.ttlSec + RELEASE_READY_SEC) {
                    this.telemetry.event('sprite_keepalive_release_stale', {
                        runtimeId: runtime.id,
                        framework: runtime.framework,
                        spriteName: runtime.spriteName,
                        ageSec
                    })
                }
            }
            if (released >= RECONCILE_MAX_ACTIONS_PER_TICK) break
            released++
            try {
                await this.releaseLease(runtime, 'reconcile')
            } catch (err) {
                this.log.warn(
                    `reconcile releaseLease failed for ${runtime.id}: ${(err as Error).message}`
                )
            }
        }
    }

    /**
     * Pass B — re-wake enabled runtimes that slept anyway (SIGKILLed loop,
     * host eviction, TTL expiry). Admission control happened at enable time;
     * re-waking restores previously-admitted state, so there is no per-user
     * quota re-check here (a lowered cap must not leave the toggle ON with a
     * silently dead agent). The org wholesale hard cap IS observed. No
     * agents-table writes and no touchRuntime — the wake makes the sprite
     * listable again and Phase 1's two-miss confirmation handles the rest.
     *
     * Runtimes whose agents are ALL status 'stopped' are skipped: re-waking
     * restores admitted state, but a sprite with no startable agent serves
     * nobody and the wake loop bills forever (#107). A falsely-stopped row
     * still heals — chat traffic wakes the sprite and the post-boot listing
     * (or a fence-valid #108 ready report) flips it back to running, which
     * re-admits the runtime here on the next tick.
     */
    private async reconcileEnsurePass(): Promise<void> {
        const rows = await this.db
            .select({
                runtime: agentRuntimes,
                agentStatus: agents.status,
                spriteStatus: agents.spriteStatus
            })
            .from(agentRuntimes)
            .innerJoin(agents, eq(agents.runtimeId, agentRuntimes.id))
            .where(
                and(
                    eq(agentRuntimes.kind, 'sprites'),
                    eq(agentRuntimes.keepAliveEnabled, true),
                    eq(agentRuntimes.status, 'ready')
                )
            )
        const byRuntime = new Map<
            string,
            { runtime: AgentRuntimeRow; awake: boolean; serveable: boolean }
        >()
        for (const row of rows) {
            const entry = byRuntime.get(row.runtime.id) ?? {
                runtime: row.runtime,
                awake: false,
                serveable: false
            }
            if (row.spriteStatus === 'running') entry.awake = true
            if (row.agentStatus !== 'stopped') entry.serveable = true
            byRuntime.set(row.runtime.id, entry)
        }
        const candidates = [...byRuntime.values()]
            .filter((entry) => !entry.awake && entry.serveable)
            .map((entry) => entry.runtime)
        if (candidates.length === 0) return

        const headroom = await this.runtimeAccess.spritesWholesaleHeadroom()
        if (headroom.orgActive >= headroom.activeCap) {
            this.telemetry.event('sprite_keepalive_ensure_capacity_skip', {
                orgActive: headroom.orgActive,
                activeCap: headroom.activeCap,
                candidates: candidates.length
            })
            return
        }

        const now = Date.now()
        let woken = 0
        for (const runtime of candidates) {
            if (woken >= RECONCILE_MAX_ACTIONS_PER_TICK) break
            if (now < (this.ensureNextEligibleAt.get(runtime.id) ?? 0)) continue
            woken++
            try {
                await this.ensureServiceRunning(runtime)
                await this.ensureLease(runtime)
                this.ensureFailures.delete(runtime.id)
                this.ensureNextEligibleAt.set(
                    runtime.id,
                    now + ENSURE_RETRY_AFTER_MS
                )
                this.telemetry.event('sprite_keepalive_ensure_wake', {
                    runtimeId: runtime.id,
                    framework: runtime.framework,
                    spriteName: runtime.spriteName
                })
            } catch (err) {
                const failures = (this.ensureFailures.get(runtime.id) ?? 0) + 1
                this.ensureFailures.set(runtime.id, failures)
                this.ensureNextEligibleAt.set(
                    runtime.id,
                    now + ensureBackoffMs(failures)
                )
                this.telemetry.event('sprite_keepalive_ensure_failed', {
                    runtimeId: runtime.id,
                    framework: runtime.framework,
                    spriteName: runtime.spriteName,
                    error: (err as Error).message
                })
            }
        }
    }

    // tmp + `mv -f` is atomic: a RUNNING legacy shell (blocked at `wait`)
    // keeps its old inode and never executes torn bytes.
    private async writeStartScript(
        client: SpritesClient,
        spriteName: string,
        runtimeId: string,
        metadata: SpriteKeepAliveMetadata,
        opts?: { reportToken?: string; logger?: SpritesLogger }
    ): Promise<void> {
        const apiBaseUrl = this.config?.get<string>('PUBLIC_API_BASE_URL')
        const reportToken = apiBaseUrl
            ? (opts?.reportToken ??
              (await ensureRuntimeReportToken(this.db, this.crypto, runtimeId)))
            : null
        let report: { scriptPath: string; logPath: string } | undefined
        // writeStartScript only runs for service-kind frameworks, so
        // serviceName is always set here; the guard narrows the optional type
        // for reportHealthUrlFor below.
        if (!apiBaseUrl || !reportToken || !metadata.serviceName) {
            // Reporting must never break a wake: degrade to the plain
            // Phase 2 start.sh when the token or base URL is unavailable.
            this.log.warn(
                `runtime report assets skipped for ${runtimeId}: ${apiBaseUrl ? 'report token unavailable' : 'PUBLIC_API_BASE_URL unset'}`
            )
        } else {
            // DB-first ordering: record the fence generation BEFORE any
            // report asset lands on the sprite, so a generation found on disk
            // is verifiable by the report handler. Best-effort, not a hard
            // invariant: patchServiceReportFence swallows DB errors, so a
            // failed patch costs that boot's reports (409 until the next
            // rewrite re-patches the fence).
            await this.patchServiceReportFence(runtimeId, metadata.generation)
            const envFile = buildRuntimeReportEnvFile({
                url: `${apiBaseUrl}/api/internal/runtime-reports`,
                token: reportToken,
                runtimeId,
                generation: metadata.generation,
                healthUrl: this.reportHealthUrlFor(metadata.serviceName)
            })
            const envPath = `${metadata.stateDir}/report.env`
            const envTmpPath = `${envPath}.tmp`
            await this.writeFile(
                client,
                spriteName,
                {
                    absPath: envTmpPath,
                    body: Buffer.from(envFile, 'utf8'),
                    mode: '600',
                    timeoutMs: 30_000
                },
                opts?.logger
            )
            // tmp + `mv -f` like start.sh: the in-flight reporter re-sources
            // report.env on every POST attempt — racing exactly this rewrite —
            // and a direct write could hand it torn bytes.
            await this.exec(client, spriteName, {
                cmd: ['mv', '-f', envTmpPath, envPath],
                stdin: '',
                timeoutMs: 30_000,
                keepAliveMs: 5_000,
                livenessTimeoutMs: 15_000
            })
            const reportScript = buildRuntimeReportScript({
                envPath: `${metadata.stateDir}/report.env`,
                probeBudgetSec: REPORT_PROBE_BUDGET_SEC
            })
            await this.writeFile(
                client,
                spriteName,
                {
                    absPath: `${metadata.stateDir}/report.sh`,
                    body: Buffer.from(reportScript, 'utf8'),
                    mode: '700',
                    timeoutMs: 30_000
                },
                opts?.logger
            )
            report = {
                scriptPath: `${metadata.stateDir}/report.sh`,
                logPath: `${metadata.stateDir}/report.log`
            }
        }
        const script = buildServiceStartScript({ exec: metadata.exec, report })
        const tmpPath = `${metadata.startScriptPath}.tmp`
        await this.writeFile(
            client,
            spriteName,
            {
                absPath: tmpPath,
                body: Buffer.from(script, 'utf8'),
                mode: '755',
                timeoutMs: 30_000
            },
            opts?.logger
        )
        await this.exec(client, spriteName, {
            cmd: ['mv', '-f', tmpPath, metadata.startScriptPath],
            stdin: '',
            timeoutMs: 30_000,
            keepAliveMs: 5_000,
            livenessTimeoutMs: 15_000
        })
    }

    // RMW of capabilitiesJson.serviceReport mirroring patchMetadata. null
    // clears the fence on the stop path — cleared BEFORE stopService so
    // in-flight reports from the dying boot are rejected as stale.
    private async patchServiceReportFence(
        runtimeId: string,
        generation: string | null
    ): Promise<void> {
        try {
            const runtime = await this.runtimes.findById(runtimeId)
            if (!runtime) return
            const capabilities = {
                ...(runtime.capabilitiesJson ?? {}),
                serviceReport: generation
                    ? { generation, updatedAt: new Date().toISOString() }
                    : {}
            }
            await this.db
                .update(agentRuntimes)
                .set({
                    capabilitiesJson: capabilities,
                    updatedAt: new Date()
                })
                .where(eq(agentRuntimes.id, runtimeId))
        } catch (err) {
            this.log.warn(
                `service report fence patch failed for ${runtimeId}: ${(err as Error).message}`
            )
        }
    }

    // The k8s deployments' readiness probes hit these same paths
    // unauthenticated in production (hermes /v1/health, openclaw /healthz,
    // narranexus /healthz) — the reporter's local probe reuses that verified
    // contract.
    private reportHealthUrlFor(serviceName: ServiceFramework): string {
        switch (serviceName) {
            case 'hermes':
                return `http://127.0.0.1:${HERMES_PORT}/v1/health`
            case 'openclaw':
                return `http://127.0.0.1:${OPENCLAW_PORT}/healthz`
            case 'narranexus':
                return `http://127.0.0.1:${NARRANEXUS_PORT}/healthz`
        }
    }

    private async runCleanup(
        client: SpritesClient,
        spriteName: string,
        metadata: SpriteKeepAliveMetadata,
        opts: {
            killAppProcesses: boolean
            killStartScriptProcesses: boolean
        }
    ): Promise<CleanupSummary> {
        const script = buildKeepAliveCleanupScript({
            taskName: metadata.taskName,
            taskPrefix: metadata.taskPrefix,
            legacyTaskNames: metadata.legacyTaskNames,
            stateDir: metadata.stateDir,
            startScriptPath: metadata.startScriptPath,
            killAppProcesses: opts.killAppProcesses,
            killStartScriptProcesses: opts.killStartScriptProcesses
        })
        const result = await this.exec(client, spriteName, {
            cmd: ['bash', '-s'],
            stdin: script,
            timeoutMs: 30_000,
            keepAliveMs: 5_000,
            livenessTimeoutMs: 15_000
        })
        if (result.exitCode !== 0) {
            return {
                deletedTasks: [],
                remainingTasks: [],
                killedPids: [],
                errors: [
                    `cleanup exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
                ]
            }
        }
        const line = result.stdout
            .trim()
            .split(/\r?\n/)
            .reverse()
            .find((l) => l.trim().startsWith('{'))
        if (!line) {
            return {
                deletedTasks: [],
                remainingTasks: [],
                killedPids: [],
                errors: ['cleanup produced no JSON summary']
            }
        }
        try {
            return JSON.parse(line) as CleanupSummary
        } catch (err) {
            return {
                deletedTasks: [],
                remainingTasks: [],
                killedPids: [],
                errors: [`cleanup JSON parse failed: ${(err as Error).message}`]
            }
        }
    }

    private async matchingTasks(
        client: SpritesClient,
        spriteName: string,
        metadata: SpriteKeepAliveMetadata
    ): Promise<MatchingTasksResult> {
        try {
            const result = await this.exec(client, spriteName, {
                cmd: ['sprite-env', 'curl', '-s', '/v1/tasks'],
                stdin: '',
                timeoutMs: 20_000,
                keepAliveMs: 5_000,
                livenessTimeoutMs: 12_000
            })
            if (result.exitCode !== 0) {
                return {
                    tasks: [],
                    error: `task list exited ${result.exitCode}: ${result.stderr.slice(0, 512)}`
                }
            }
            const raw = result.stdout.trim()
            if (!raw) {
                return { tasks: [], error: 'task list returned empty body' }
            }
            const body = JSON.parse(raw) as {
                tasks?: Array<{ name?: unknown }>
            }
            const legacy = new Set(metadata.legacyTaskNames)
            return {
                tasks: (body.tasks ?? [])
                    .map((task) => task.name)
                    .filter((name): name is string => typeof name === 'string')
                    .filter(
                        (name) =>
                            name === metadata.taskName ||
                            name.startsWith(metadata.taskPrefix) ||
                            legacy.has(name)
                    )
            }
        } catch (err) {
            return {
                tasks: [],
                error: (err as Error).message
            }
        }
    }

    private nextMetadata(input: {
        runtimeId: string
        framework: AgentFramework
        serviceName?: ServiceFramework
        homeDir: string
        exec: string[]
        legacyTaskNames: string[]
        desiredState: DesiredState
    }): SpriteKeepAliveMetadata {
        const generation = randomUUID().replace(/-/g, '').slice(0, 12)
        const taskPrefix = `${PLATFORM_TASK_PREFIX}${input.framework}-${runtimeUnique(input.runtimeId)}-`
        return {
            serviceName: input.serviceName,
            taskPrefix,
            taskName: `${taskPrefix}${generation}`,
            generation,
            ttlSec: KEEPALIVE_TTL_SEC,
            refreshSec: KEEPALIVE_REFRESH_SEC,
            desiredState: input.desiredState,
            // .nca here (not .manyfold) is an on-sprite compatibility
            // contract: the legacy fused fleet wrote renew.pid under
            // .nca/keepalive and the shared-pid-file kill path depends on it.
            // Renaming needs its own convergence story.
            stateDir: `${input.homeDir}/.nca/keepalive`,
            startScriptPath: `${input.homeDir}/start.sh`,
            exec: input.exec,
            legacyTaskNames: input.legacyTaskNames
        }
    }

    private fallbackMetadata(
        runtime: AgentRuntimeRow
    ): SpriteKeepAliveMetadata {
        const framework = runtime.framework
        const homeDir = this.homeDirFor(runtime, null)
        // exec/legacyTaskNames/serviceName are service-supervision concepts;
        // an exec-kind sprite runs a lease-only keep-alive with none of them.
        if (!this.isServiceFramework(framework)) {
            return this.nextMetadata({
                runtimeId: runtime.id,
                framework,
                homeDir,
                exec: [],
                legacyTaskNames: [],
                desiredState: 'stopped'
            })
        }
        return this.nextMetadata({
            runtimeId: runtime.id,
            framework,
            serviceName: framework,
            homeDir,
            exec: fallbackExec(framework, homeDir),
            legacyTaskNames: legacyTaskNamesFor(framework),
            desiredState: 'stopped'
        })
    }

    private metadataFor(
        runtime: AgentRuntimeRow
    ): SpriteKeepAliveMetadata | null {
        const raw = runtime.capabilitiesJson?.keepAlive
        if (!raw || typeof raw !== 'object') return null
        const meta = raw as Partial<SpriteKeepAliveMetadata>
        // serviceName is intentionally not required: exec-kind (coding) sprites
        // persist lease-only metadata with no service to name.
        if (
            !meta.taskPrefix ||
            !meta.taskName ||
            !meta.generation ||
            !meta.stateDir ||
            !meta.startScriptPath ||
            !Array.isArray(meta.exec)
        ) {
            return null
        }
        return {
            serviceName: meta.serviceName,
            taskPrefix: meta.taskPrefix,
            taskName: meta.taskName,
            generation: meta.generation,
            ttlSec: meta.ttlSec ?? KEEPALIVE_TTL_SEC,
            refreshSec: meta.refreshSec ?? KEEPALIVE_REFRESH_SEC,
            desiredState: meta.desiredState ?? 'running',
            stateDir: meta.stateDir,
            startScriptPath: meta.startScriptPath,
            exec: meta.exec,
            legacyTaskNames: Array.isArray(meta.legacyTaskNames)
                ? meta.legacyTaskNames
                : legacyTaskNamesFor(meta.serviceName),
            desiredStateAt: meta.desiredStateAt,
            lastVerifiedAt: meta.lastVerifiedAt,
            lastError: meta.lastError
        }
    }

    private async patchMetadata(
        runtimeId: string,
        metadata: SpriteKeepAliveMetadata,
        opts?: { verified?: boolean }
    ): Promise<void> {
        try {
            const runtime = await this.runtimes.findById(runtimeId)
            if (!runtime) return
            const existing = this.metadataFor(runtime)
            // One clock reading stamps BOTH fields: a verified patch that
            // flips desiredState must land with lastVerifiedAt >=
            // desiredStateAt, or reconcile Pass A re-releases the
            // already-converged runtime once per flip.
            const stampedAt = new Date().toISOString()
            const desiredStateAt =
                !existing || existing.desiredState !== metadata.desiredState
                    ? stampedAt
                    : (existing.desiredStateAt ?? stampedAt)
            const patched = opts?.verified
                ? { ...metadata, lastVerifiedAt: stampedAt }
                : metadata
            const capabilities = {
                ...(runtime.capabilitiesJson ?? {}),
                keepAlive: stripUndefined({ ...patched, desiredStateAt })
            }
            await this.db
                .update(agentRuntimes)
                .set({
                    capabilitiesJson: capabilities,
                    updatedAt: new Date()
                })
                .where(eq(agentRuntimes.id, runtimeId))
        } catch (err) {
            this.log.warn(
                `keep-alive metadata patch failed for ${runtimeId}: ${(err as Error).message}`
            )
        }
    }

    protected async clientFor(
        runtime: AgentRuntimeRow
    ): Promise<{
        account: SpritesAccount
        client: SpritesClient
        spriteName: string
    } | null> {
        if (!runtime.accountId || !runtime.spriteName) return null
        const account = await this.accounts.getById(runtime.accountId)
        if (!account) return null
        const token = this.accounts.decryptToken(account)
        return {
            account,
            spriteName: runtime.spriteName,
            client: createClient({
                token,
                accountSlug: account.slug,
                logger: spritesLoggerFor(this.log)
            })
        }
    }

    protected exec(
        client: SpritesClient,
        spriteName: string,
        opts: ExecOptions
    ): Promise<ExecResult> {
        return execSprite(client, spriteName, opts)
    }

    protected writeFile(
        client: SpritesClient,
        spriteName: string,
        args: SpriteWriteFileArgs,
        logger?: SpritesLogger
    ): Promise<void> {
        return spriteWriteFile(client, spriteName, args, logger)
    }

    private isServiceFramework(
        framework: string
    ): framework is ServiceFramework {
        return (
            framework === 'hermes' ||
            framework === 'openclaw' ||
            framework === 'narranexus'
        )
    }

    // Full service topology for a runtime, in start (dependency) order —
    // stop paths iterate it reversed. Hermes with the dashboard enabled runs
    // gateway + dashboard + front proxy; the proxy holds the sprite's public
    // http_port, so wake/stop must treat the trio as one unit.
    private serviceNamesFor(runtime: AgentRuntimeRow): string[] {
        if (runtime.framework === 'hermes' && runtime.dashboardEnabled)
            return [
                runtime.framework,
                HERMES_DASHBOARD_SERVICE,
                HERMES_PROXY_SERVICE
            ]
        return [runtime.framework]
    }

    // Any sprite runtime can hold a keep-alive lease (the renewing /v1/tasks
    // loop that keeps the VM awake). Service-kind frameworks layer service
    // supervision on top; exec-kind (coding) sprites run the lease alone.
    // kind==='sprites' already excludes external frameworks by construction.
    private isLeaseEligible(runtime: AgentRuntimeRow): boolean {
        return runtime.kind === 'sprites' && !isExternal(runtime.framework)
    }

    private homeDirFor(
        runtime: AgentRuntimeRow,
        metadata: SpriteKeepAliveMetadata | null
    ): string {
        return (
            runtime.homeDir ??
            metadata?.stateDir.replace(/\/\.(?:manyfold|nca)\/keepalive$/, '') ??
            defaultHomeDir(runtime.framework)
        )
    }
}

const isSpritesNotFound = (err: unknown): boolean =>
    err instanceof SpritesError && err.code === 'not_found'

const runtimeUnique = (runtimeId: string): string =>
    runtimeId.includes('_')
        ? runtimeId.split('_').slice(1).join('_')
        : runtimeId

const legacyTaskNamesFor = (
    framework: ServiceFramework | undefined
): string[] => (framework ? [`${framework}-keepalive`] : [])

const defaultHomeDir = (framework: AgentFramework): string => {
    switch (framework) {
        case 'hermes':
            return '/home/sprite/.hermes'
        case 'openclaw':
            return '/home/sprite/.openclaw'
        case 'narranexus':
            return '/home/sprite/.narranexus'
        default:
            return '/home/sprite'
    }
}

const fallbackExec = (
    framework: ServiceFramework,
    homeDir: string
): string[] => {
    switch (framework) {
        case 'hermes':
            return [`${homeDir}/hermes-agent/venv/bin/hermes`, 'gateway']
        case 'openclaw':
            return ['openclaw', 'gateway']
        case 'narranexus':
            return ['bash', `${homeDir}/app/run.sh`]
    }
}

const stripUndefined = (
    input: SpriteKeepAliveMetadata
): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) out[key] = value
    }
    return out
}

const spritesLoggerFor = (log: Logger): SpritesLogger => ({
    debug: (msg, meta) => log.debug(`[sprites] ${msg} ${JSON.stringify(meta)}`),
    info: (msg, meta) => log.log(`[sprites] ${msg} ${JSON.stringify(meta)}`),
    warn: (msg, meta) => log.warn(`[sprites] ${msg} ${JSON.stringify(meta)}`),
    error: (msg, meta) => log.error(`[sprites] ${msg} ${JSON.stringify(meta)}`)
})
