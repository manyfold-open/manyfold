import {
    HERMES_DASHBOARD_SERVICE,
    HERMES_PROXY_SERVICE,
    PLATFORM_TASK_PREFIX,
    SPRITE_HOME_BASE,
    UnknownFrameworkError,
    frameworkDefinition
} from '@manyfold/shared'
import type { AgentFramework } from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import {
    buildKeepAliveCleanupScript,
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
import { CryptoService } from '@/modules/secrets/crypto.service'
import { ensureRuntimeReportToken } from '@/modules/agents/keep-alive/runtime-report-token'
import { HERMES_PORT } from '@/modules/agents/bootstrap/hermes-shared'
import { OPENCLAW_PORT } from '@/modules/agents/bootstrap/openclaw-shared'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'

const KEEPALIVE_TTL_SEC = 300
const KEEPALIVE_REFRESH_SEC = 60
const REPORT_PROBE_BUDGET_SEC = 120

const createGeneration = (): string =>
    randomUUID().replace(/-/g, '').slice(0, 12)

type ServiceFramework = AgentFramework
type DesiredState = 'running' | 'stopped'

// A framework service's start/report assets on the sprite (start.sh,
// report.env, report.sh) and their fence: per runtime, because the report
// fence and the service topology are the framework's. Keeping the host awake
// is not theirs (HostKeepAwakeService).
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

@Injectable()
export class SpriteKeepAliveLeaseService {
    private readonly log = new Logger(SpriteKeepAliveLeaseService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly hostClients: HostProviderClients,
        private readonly runtimes: AgentRuntimesService,
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
     * host's keep-awake: traffic wake must not hold a machine awake whose
     * switch is off. The pre-start FULL cleanup preserves straggler/port
     * clearing.
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

    private async runCleanup(
        client: SpritesClient,
        spriteName: string,
        metadata: Pick<
            SpriteKeepAliveMetadata,
            'taskName' | 'taskPrefix' | 'stateDir' | 'startScriptPath'
        >,
        opts: { killStartScriptProcesses: boolean }
    ): Promise<CleanupSummary> {
        const script = buildKeepAliveCleanupScript({
            taskName: metadata.taskName,
            taskPrefix: metadata.taskPrefix,
            stateDir: metadata.stateDir,
            startScriptPath: metadata.startScriptPath,
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

    // The runtime's host, re-read so it is current.
    protected async hostOf(
        runtime: AgentRuntimeRow
    ): Promise<RuntimeHostRow | null> {
        if (!runtime.hostId) return null
        return this.hosts.findById(runtime.hostId)
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
