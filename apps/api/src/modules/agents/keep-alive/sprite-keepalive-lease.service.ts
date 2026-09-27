import {
    HERMES_DASHBOARD_SERVICE,
    HERMES_PROXY_SERVICE,
    PLATFORM_TASK_PREFIX,
    SPRITE_HOME_BASE,
    UnknownFrameworkError,
    frameworkDefinition
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentKeepAliveRelease
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type KeepAwakeLease,
    type RuntimeHostRow
} from '@manyfold/db'
import {
    buildKeepAliveCleanupScript,
    buildKeepAliveLeaseScript,
    buildRuntimeReportEnvFile,
    buildRuntimeReportScript,
    buildServiceStartScript,
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
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { liveHostedHosts } from '@/modules/runtime-access/runtime-usage-counts'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { ensureRuntimeReportToken } from '@/modules/agents/keep-alive/runtime-report-token'
import { HERMES_PORT } from '@/modules/agents/bootstrap/hermes-shared'
import { OPENCLAW_PORT } from '@/modules/agents/bootstrap/openclaw-shared'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'

const KEEPALIVE_TTL = '5m'
const KEEPALIVE_TTL_SEC = 300
const KEEPALIVE_REFRESH_SEC = 60
const RELEASE_READY_SEC = 90
// Per-pass action caps: bound the exec storm a sweep can raise.
const RECONCILE_MAX_ACTIONS_PER_TICK = 5
// +120s after ANY ensure attempt — covers the ≤30s slow-cadence status-sync
// visibility lag plus spin-up, preventing double-wakes before the running
// flip lands.
const ENSURE_RETRY_AFTER_MS = 120_000
const ENSURE_MAX_BACKOFF_MS = 5 * 60_000
const REPORT_PROBE_BUDGET_SEC = 120
// The host's lease state lives on the machine under the sprite user's home,
// beside nothing framework-specific: one lease per host (ADR-0037 R7).
const HOST_LEASE_STATE_DIR = `${SPRITE_HOME_BASE}/.nca/keepalive`

const ensureBackoffMs = (failures: number): number =>
    Math.min(60_000 * 2 ** Math.min(failures, 5), ENSURE_MAX_BACKOFF_MS)

const createGeneration = (): string =>
    randomUUID().replace(/-/g, '').slice(0, 12)

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

type ServiceFramework = AgentFramework
type DesiredState = 'running' | 'stopped'

// A framework service's start/report assets on the sprite (start.sh,
// report.env, report.sh) and their fence: per runtime, because the report
// fence and the service topology are the framework's. The host's lease is
// separate (KeepAwakeLease on the host row).
export interface SpriteKeepAliveMetadata {
    // Set only for service-kind frameworks; exec-kind (coding) sprites hold
    // no framework service to name.
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
    // The credentials row does not exist yet at install time — the bootstrap
    // mints the report token and the orchestrator persists it afterwards.
    reportToken: string
    logger?: SpritesLogger
}

// Either row names the machine: a host directly, a runtime through its host.
export type LeaseSubject = RuntimeHostRow | AgentRuntimeRow

const isRuntimeRow = (subject: LeaseSubject): subject is AgentRuntimeRow =>
    'framework' in subject

const hostUnique = (hostId: string): string =>
    hostId.includes('_') ? hostId.split('_').slice(1).join('_') : hostId

// The task names one host's lease may use; cleanup matches the prefix so a
// renewer from any earlier generation is found without stored metadata.
const hostTaskPrefix = (hostId: string): string =>
    `${PLATFORM_TASK_PREFIX}host-${hostUnique(hostId)}-`

const emptyLease = (): KeepAwakeLease => ({
    generation: 0,
    taskName: null,
    desiredStateAt: null,
    lastVerifiedAt: null,
    lastError: null
})

@Injectable()
export class SpriteKeepAliveLeaseService {
    private readonly log = new Logger(SpriteKeepAliveLeaseService.name)
    private readonly ensureNextEligibleAt = new Map<string, number>()
    private readonly ensureFailures = new Map<string, number>()
    private readonly releaseNextEligibleAt = new Map<string, number>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly hostClients: HostProviderClients,
        private readonly runtimes: AgentRuntimesService,
        private readonly telemetry: TelemetryService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly crypto: CryptoService,
        private readonly config: ConfigService,
        // Appended last + @Optional: frameworks a module registers
        // (ADR-0034); absent means only the core service frameworks.
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry()
    ) {}

    async install(input: InstallInput): Promise<SpriteKeepAliveMetadata> {
        const metadata = this.nextMetadata({
            runtimeId: input.runtimeId,
            framework: input.framework,
            serviceName: input.serviceName,
            homeDir: input.homeDir,
            exec: input.exec,
            desiredState: 'stopped'
        })
        await this.writeStartScript(
            input.client,
            input.spriteName,
            input.runtimeId,
            metadata,
            { reportToken: input.reportToken, logger: input.logger }
        )
        await this.patchMetadata(input.runtimeId, metadata, { verified: true })
        return metadata
    }

    /**
     * Wake the framework service if it is not running. Never touches the
     * host's lease — traffic wake must not resurrect a lease the user turned
     * off. The pre-start FULL cleanup preserves straggler/port clearing.
     */
    async ensureServiceRunning(
        runtime: AgentRuntimeRow
    ): Promise<{ started: boolean }> {
        if (!this.isServiceFramework(runtime.framework)) {
            return { started: false }
        }
        const host = await this.hostOf(runtime)
        if (!host) return { started: false }
        const ctx = await this.clientFor(host)
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
                if (!isSpritesNotFound(err)) {
                    this.log.warn(
                        `getService ${name} on ${ctx.spriteName} failed before start: ${(err as Error).message}`
                    )
                }
                notRunning.push(name)
            }
        }
        if (notRunning.length === 0) return { started: false }

        const base = this.metadataFor(runtime) ?? this.fallbackMetadata(runtime)
        // Each service boot needs a fresh report fence and matching assets.
        await this.writeStartScript(ctx.client, ctx.spriteName, runtime.id, {
            ...base,
            generation: createGeneration()
        })
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

    // Stop a framework's services on the sprite (reverse topology order) and
    // record it. The only downward writer of service_status — report-driven
    // paths are structurally unable to produce 'stopped'.
    async stopService(runtime: AgentRuntimeRow): Promise<string | undefined> {
        if (!this.isServiceFramework(runtime.framework)) return undefined
        const host = await this.hostOf(runtime)
        if (!host) return 'host not found'
        const ctx = await this.clientFor(host)
        if (!ctx) return 'sprites provider or sprite name missing'
        // Clear the report fence BEFORE stopService so in-flight reports
        // from the dying boot 409 even before the stopped guards land.
        await this.patchServiceReportFence(runtime.id, null)
        let serviceMessage: string | undefined
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
        const base = this.metadataFor(runtime) ?? this.fallbackMetadata(runtime)
        await this.runCleanup(ctx.client, ctx.spriteName, base, {
            killAppProcesses: true,
            killStartScriptProcesses: true
        })
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
        await this.patchMetadata(runtime.id, {
            ...base,
            desiredState: 'stopped',
            lastError: serviceMessage
        })
        return serviceMessage
    }

    /**
     * Establish (or re-establish) the host's keep-awake lease loop: the
     * renewing /v1/tasks task that holds the VM running. Never starts or
     * stops a framework service — that is the daemon's job. The pre-spawn
     * lease-only cleanup kills any existing renewer so exactly one survives.
     */
    async ensureLease(subject: LeaseSubject): Promise<void> {
        const host = await this.hostOf(subject)
        if (!host || !this.isLeaseEligible(host)) return
        const ctx = await this.clientFor(host)
        if (!ctx) return

        const previous = host.keepAwakeLease ?? emptyLease()
        const generation = previous.generation + 1
        const taskPrefix = hostTaskPrefix(host.id)
        const taskName = `${taskPrefix}${generation}-${createGeneration()}`
        // Cleanup runs against the prefix: the old renewer's renew.pid lives
        // wherever the previous generation put it, under the same state dir.
        await this.runCleanup(
            ctx.client,
            ctx.spriteName,
            this.hostLeaseCleanupTarget(host.id, previous),
            { killAppProcesses: false, killStartScriptProcesses: false }
        )
        const leaseScript = buildKeepAliveLeaseScript({
            taskName,
            taskPrefix,
            ttl: KEEPALIVE_TTL,
            refreshIntervalSeconds: KEEPALIVE_REFRESH_SEC,
            stateDir: HOST_LEASE_STATE_DIR
        })
        await this.writeFile(ctx.client, ctx.spriteName, {
            absPath: `${HOST_LEASE_STATE_DIR}/keepalive.sh`,
            body: Buffer.from(leaseScript, 'utf8'),
            mode: '755',
            timeoutMs: 30_000
        })
        await this.exec(ctx.client, ctx.spriteName, {
            cmd: [
                'bash',
                '-lc',
                `setsid nohup bash '${HOST_LEASE_STATE_DIR}/keepalive.sh' </dev/null >/dev/null 2>&1 & echo ok`
            ],
            stdin: '',
            timeoutMs: 30_000,
            keepAliveMs: 5_000,
            livenessTimeoutMs: 15_000
        })
        // The spawn is detached; task_create lands ~100ms-1s later.
        let observed = await this.matchingTasks(ctx.client, ctx.spriteName, {
            taskName,
            taskPrefix
        })
        for (
            let attempt = 1;
            attempt < 3 && (observed.tasks.length === 0 || observed.error);
            attempt++
        ) {
            await sleep(1_000)
            observed = await this.matchingTasks(ctx.client, ctx.spriteName, {
                taskName,
                taskPrefix
            })
        }
        const verified = observed.tasks.length > 0 && !observed.error
        const stampedAt = new Date().toISOString()
        await this.saveLease(host.id, {
            generation,
            taskName,
            desiredStateAt: stampedAt,
            lastVerifiedAt: verified ? stampedAt : previous.lastVerifiedAt,
            lastError: verified
                ? null
                : observed.error
                  ? `keep-alive task verification failed: ${observed.error}`
                  : `keep-alive task ${taskName} not observed after spawn`
        })
        // A disable racing this ensure may have run its lease-only cleanup
        // BEFORE the spawn above, leaving a renewing loop on a host whose
        // switch already reads false. Re-check and release deterministically.
        const fresh = await this.hosts.findById(host.id)
        if (fresh && fresh.keepAwake === false) {
            await this.releaseLease(fresh, 'ensure-raced-disable')
        }
    }

    /**
     * Lease-only release: kills the renewer, deletes the host's tasks and
     * records the verified (or degraded) outcome on the host row. NEVER
     * touches a framework service — this is the no-restart toggle-off and
     * the sweep's only action.
     */
    async releaseLease(
        subject: LeaseSubject,
        reason: string
    ): Promise<{ verified: boolean }> {
        const host = await this.hostOf(subject)
        if (!host || !this.isLeaseEligible(host)) {
            return { verified: false }
        }
        const previous = host.keepAwakeLease ?? emptyLease()
        const stampedAt = new Date().toISOString()
        const ctx = await this.clientFor(host)
        if (!ctx) {
            await this.saveLease(host.id, {
                ...previous,
                desiredStateAt: stampedAt,
                lastError: 'sprites provider or sprite name missing'
            })
            return { verified: false }
        }
        const target = this.hostLeaseCleanupTarget(host.id, previous)
        const cleanup = await this.runCleanup(ctx.client, ctx.spriteName, target, {
            killAppProcesses: false,
            killStartScriptProcesses: false
        })
        const remaining = await this.matchingTasks(
            ctx.client,
            ctx.spriteName,
            target
        )
        const verified = remaining.tasks.length === 0 && !remaining.error
        const message = verified
            ? null
            : remaining.error
              ? `keep-alive task verification failed: ${remaining.error}`
              : `keep-alive tasks still present: ${remaining.tasks.join(', ')}`
        await this.saveLease(host.id, {
            generation: previous.generation,
            taskName: verified ? null : previous.taskName,
            desiredStateAt: stampedAt,
            lastVerifiedAt: verified ? stampedAt : previous.lastVerifiedAt,
            lastError:
                message ??
                (cleanup.errors.length > 0
                    ? `cleanup errors: ${JSON.stringify(cleanup.errors).slice(0, 512)}`
                    : null)
        })
        if (!verified) {
            this.telemetry.event('sprite_keepalive_release_degraded', {
                hostId: host.id,
                spriteName: ctx.spriteName,
                reason,
                remainingTasks: remaining.tasks.length
            })
        }
        return { verified }
    }

    // Release the host's lease and say how long the VM may still read as
    // running: the sandbox stop path's keep-alive half.
    async stopAndRelease(
        subject: LeaseSubject,
        reason: string
    ): Promise<AgentKeepAliveRelease> {
        const host = await this.hostOf(subject)
        if (!host || !this.isLeaseEligible(host)) {
            return { state: 'not_applicable', maxStaleSec: 0 }
        }
        // Nothing to release if this host never held a lease: skip the
        // sprite exec round-trips (and the false 'degraded' telemetry a
        // transient task-list read could otherwise emit).
        if (!host.keepAwake && !host.keepAwakeLease?.taskName) {
            return { state: 'not_applicable', maxStaleSec: 0 }
        }
        try {
            const { verified } = await this.releaseLease(host, reason)
            return {
                state: verified ? 'verified' : 'degraded',
                maxStaleSec: verified
                    ? RELEASE_READY_SEC
                    : KEEPALIVE_TTL_SEC + RELEASE_READY_SEC
            }
        } catch (err) {
            const message = `release error: ${(err as Error).message}`
            this.log.warn(
                `stopAndRelease host=${host.id} threw: ${(err as Error).message}`
            )
            this.telemetry.event('sprite_keepalive_release_degraded', {
                hostId: host.id,
                reason,
                error: (err as Error).message
            })
            return {
                state: 'degraded',
                maxStaleSec: KEEPALIVE_TTL_SEC + RELEASE_READY_SEC,
                message
            }
        }
    }

    async reconcileLeases(): Promise<void> {
        await this.reconcileReleasePass()
        await this.reconcileEnsurePass()
    }

    /**
     * Pass A — converge switched-off hosts whose release never verified:
     * keep_awake false with a lease task still recorded. Acts via
     * releaseLease, never a service stop — a chat-woken host with the switch
     * off is running legitimately, and only the lease is ours to remove.
     */
    private async reconcileReleasePass(): Promise<void> {
        const rows = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    liveHostedHosts('sprites'),
                    eq(runtimeHosts.keepAwake, false),
                    // A sleeping VM holds no live task (the TTL expired with
                    // its renewer), and the release exec would wake it — the
                    // one thing a release must never do.
                    eq(runtimeHosts.powerState, 'running'),
                    isNotNull(runtimeHosts.keepAwakeLease),
                    sql`${runtimeHosts.keepAwakeLease}->>'taskName' is not null`
                )
            )
        const now = Date.now()
        let released = 0
        for (const host of rows) {
            const lease = host.keepAwakeLease
            if (!lease?.taskName) continue
            const anchor = Date.parse(
                lease.desiredStateAt ?? host.updatedAt.toISOString()
            )
            const ageSec = Math.floor((now - anchor) / 1000)
            if (ageSec < RELEASE_READY_SEC) continue
            if (now < (this.releaseNextEligibleAt.get(host.id) ?? 0)) continue
            if (ageSec > KEEPALIVE_TTL_SEC + RELEASE_READY_SEC) {
                this.telemetry.event('sprite_keepalive_release_stale', {
                    hostId: host.id,
                    ageSec
                })
            }
            if (released >= RECONCILE_MAX_ACTIONS_PER_TICK) break
            released++
            this.releaseNextEligibleAt.set(host.id, now + RELEASE_READY_SEC * 1000)
            try {
                await this.releaseLease(host, 'reconcile')
            } catch (err) {
                this.log.warn(
                    `reconcile releaseLease failed for host ${host.id}: ${(err as Error).message}`
                )
            }
        }
    }

    /**
     * Pass B — re-lease kept-awake hosts that slept anyway (SIGKILLed loop,
     * host eviction, TTL expiry). Admission control happened at enable time;
     * re-leasing restores previously-admitted state, so there is no per-user
     * quota re-check here (a lowered cap must not leave the switch ON with a
     * silently sleeping machine). The org wholesale hard cap IS observed.
     */
    private async reconcileEnsurePass(): Promise<void> {
        const candidates = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    liveHostedHosts('sprites'),
                    eq(runtimeHosts.status, 'ready'),
                    eq(runtimeHosts.keepAwake, true),
                    ne(runtimeHosts.powerState, 'running')
                )
            )
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
        for (const host of candidates) {
            if (woken >= RECONCILE_MAX_ACTIONS_PER_TICK) break
            if (now < (this.ensureNextEligibleAt.get(host.id) ?? 0)) continue
            woken++
            try {
                await this.ensureLease(host)
                this.ensureFailures.delete(host.id)
                this.ensureNextEligibleAt.set(
                    host.id,
                    now + ENSURE_RETRY_AFTER_MS
                )
                this.telemetry.event('sprite_keepalive_ensure_wake', {
                    hostId: host.id
                })
            } catch (err) {
                const failures = (this.ensureFailures.get(host.id) ?? 0) + 1
                this.ensureFailures.set(host.id, failures)
                this.ensureNextEligibleAt.set(
                    host.id,
                    now + ensureBackoffMs(failures)
                )
                this.telemetry.event('sprite_keepalive_ensure_failed', {
                    hostId: host.id,
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
            // start.sh when the token or base URL is unavailable.
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
    // unauthenticated in production (hermes /v1/health, openclaw /healthz) —
    // the reporter's local probe reuses that verified contract. A framework a
    // module registers declares its own (FrameworkSpriteService.supervision).
    private reportHealthUrlFor(serviceName: ServiceFramework): string {
        if (serviceName === 'hermes')
            return `http://127.0.0.1:${HERMES_PORT}/v1/health`
        if (serviceName === 'openclaw')
            return `http://127.0.0.1:${OPENCLAW_PORT}/healthz`
        return this.supervisionFor(serviceName).healthUrl
    }

    private supervisionFor(framework: AgentFramework) {
        const supervision =
            this.extensions.get(framework)?.spriteService?.supervision
        if (!supervision) throw new UnknownFrameworkError(framework)
        return supervision
    }

    private hostLeaseCleanupTarget(
        hostId: string,
        lease: KeepAwakeLease
    ): Pick<
        SpriteKeepAliveMetadata,
        'taskName' | 'taskPrefix' | 'stateDir' | 'startScriptPath'
    > {
        const taskPrefix = hostTaskPrefix(hostId)
        return {
            taskName: lease.taskName ?? `${taskPrefix}${lease.generation}`,
            taskPrefix,
            stateDir: HOST_LEASE_STATE_DIR,
            startScriptPath: `${HOST_LEASE_STATE_DIR}/start.sh`
        }
    }

    private async runCleanup(
        client: SpritesClient,
        spriteName: string,
        metadata: Pick<
            SpriteKeepAliveMetadata,
            'taskName' | 'taskPrefix' | 'stateDir' | 'startScriptPath'
        >,
        opts: {
            killAppProcesses: boolean
            killStartScriptProcesses: boolean
        }
    ): Promise<CleanupSummary> {
        const script = buildKeepAliveCleanupScript({
            taskName: metadata.taskName,
            taskPrefix: metadata.taskPrefix,
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
        metadata: Pick<SpriteKeepAliveMetadata, 'taskName' | 'taskPrefix'>
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
            return {
                tasks: (body.tasks ?? [])
                    .map((task) => task.name)
                    .filter((name): name is string => typeof name === 'string')
                    .filter(
                        (name) =>
                            name === metadata.taskName ||
                            name.startsWith(metadata.taskPrefix)
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
        desiredState: DesiredState
    }): SpriteKeepAliveMetadata {
        const generation = createGeneration()
        const taskPrefix = `${PLATFORM_TASK_PREFIX}${input.framework}-${runtimeUnique(input.runtimeId)}-`
        return {
            serviceName: input.serviceName,
            taskPrefix,
            taskName: `${taskPrefix}${generation}`,
            generation,
            ttlSec: KEEPALIVE_TTL_SEC,
            refreshSec: KEEPALIVE_REFRESH_SEC,
            desiredState: input.desiredState,
            // Persisted state location shared by the service and cleanup paths.
            stateDir: `${input.homeDir}/.nca/keepalive`,
            startScriptPath: `${input.homeDir}/start.sh`,
            exec: input.exec
        }
    }

    private fallbackMetadata(
        runtime: AgentRuntimeRow
    ): SpriteKeepAliveMetadata {
        const framework = runtime.framework
        const homeDir = this.homeDirFor(runtime, null)
        if (!this.isServiceFramework(framework)) {
            return this.nextMetadata({
                runtimeId: runtime.id,
                framework,
                homeDir,
                exec: [],
                desiredState: 'stopped'
            })
        }
        return this.nextMetadata({
            runtimeId: runtime.id,
            framework,
            serviceName: framework,
            homeDir,
            exec: this.fallbackExec(framework, homeDir),
            desiredState: 'stopped'
        })
    }

    private metadataFor(
        runtime: AgentRuntimeRow
    ): SpriteKeepAliveMetadata | null {
        const raw = runtime.capabilitiesJson?.keepAlive
        if (!raw || typeof raw !== 'object') return null
        const meta = raw as Partial<SpriteKeepAliveMetadata>
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

    private async saveLease(hostId: string, lease: KeepAwakeLease): Promise<void> {
        try {
            await this.hosts.patch(hostId, { keepAwakeLease: lease })
        } catch (err) {
            this.log.warn(
                `keep-awake lease patch failed for host ${hostId}: ${(err as Error).message}`
            )
        }
    }

    // The host a subject names, re-read so the switch and lease are current.
    protected async hostOf(subject: LeaseSubject): Promise<RuntimeHostRow | null> {
        if (isRuntimeRow(subject)) {
            if (!subject.hostId) return null
            return this.hosts.findById(subject.hostId)
        }
        return subject
    }

    // Seam so tests can fake the sprites.dev control-plane client.
    protected async clientFor(
        host: RuntimeHostRow
    ): Promise<{ client: SpritesClient; spriteName: string } | null> {
        if (host.kind !== 'hosted' || host.providerRef?.kind !== 'sprites')
            return null
        try {
            const { client, spriteName } =
                await this.hostClients.spritesClientForHost(
                    host,
                    spritesLoggerFor(this.log)
                )
            return { client, spriteName }
        } catch (err) {
            this.log.warn(
                `sprites client unavailable for host ${host.id}: ${(err as Error).message}`
            )
            return null
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
        return frameworkDefinition(framework)?.kind === 'service'
    }

    private fallbackExec(
        framework: ServiceFramework,
        homeDir: string
    ): string[] {
        if (framework === 'hermes')
            return [`${homeDir}/hermes-agent/venv/bin/hermes`, 'gateway']
        if (framework === 'openclaw') return ['openclaw', 'gateway']
        return this.supervisionFor(framework).fallbackExec(homeDir)
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

    // Only a hosted sprites machine holds a keep-awake lease (the renewing
    // /v1/tasks loop that keeps the VM awake).
    private isLeaseEligible(host: RuntimeHostRow): boolean {
        return (
            host.kind === 'hosted' &&
            host.providerRef?.kind === 'sprites' &&
            host.status !== 'retired'
        )
    }

    private defaultHomeDir(framework: AgentFramework): string {
        if (framework === 'hermes') return `${SPRITE_HOME_BASE}/.hermes`
        if (framework === 'openclaw') return `${SPRITE_HOME_BASE}/.openclaw`
        return (
            this.extensions.get(framework)?.spriteService?.supervision
                .homeDir ?? SPRITE_HOME_BASE
        )
    }

    private homeDirFor(
        runtime: AgentRuntimeRow,
        metadata: SpriteKeepAliveMetadata | null
    ): string {
        return (
            metadata?.stateDir.replace(/\/\.(?:manyfold|nca)\/keepalive$/, '') ??
            this.defaultHomeDir(runtime.framework)
        )
    }
}

const isSpritesNotFound = (err: unknown): boolean =>
    err instanceof SpritesError && err.code === 'not_found'

const runtimeUnique = (runtimeId: string): string =>
    runtimeId.includes('_')
        ? runtimeId.split('_').slice(1).join('_')
        : runtimeId

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
