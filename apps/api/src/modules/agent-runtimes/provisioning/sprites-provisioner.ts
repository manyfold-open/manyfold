import {
    AgentFramework,
    AgentModelConfig,
    AgentModelConfigSource,
    FrameworkInstallSource,
    SPRITE_HOME_BASE,
    codingAgentWorkspacePath,
    createObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    hostDaemons,
    runtimeHosts,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow,
    type RuntimeProvider
} from '@manyfold/db'
import {
    SpritesError,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { SpriteServiceBootstraps } from '@/modules/agents/bootstrap/sprite-service-bootstraps'
import {
    BootstrapError,
    type BootstrapContext
} from '@/modules/agents/bootstrap/framework-bootstrap'
import {
    isCodingHostFramework,
    sessionScriptRunner,
    setUpHostFramework,
    type SessionScriptRunner
} from '@/modules/agents/bootstrap/host-framework-setup'
import {
    frameworkVersionDescriptor,
    type FrameworkReleaseArtifacts
} from '@/modules/framework-versions/framework-version-registry'
import type {
    SpriteServiceBootstrap,
    SpriteServiceBootstrapResult
} from '@/modules/agents/bootstrap/sprite-framework-bootstrap'
import type { AgentProgressEmitter } from '@/modules/agents/orchestration/agent-orchestrator.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { SandboxActiveDurationService } from '@/modules/agents/sandbox-active-duration/sandbox-active-duration.service'
import { RuntimeTokenService } from '@/modules/auth/runtime-token.service'
import { isWorkspacePreflightUserError } from '@/modules/agents/workspace/workspace-preflight'
import { SpriteKeepAliveLeaseService } from '@/modules/agents/keep-alive/sprite-keepalive-lease.service'
import { HostsService } from '@/modules/hosts/hosts.service'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'
import { HostPlacementService } from '@/modules/hosts/providers/host-placement.service'
import { SandboxProviderRegistry } from '@/modules/hosts/providers/sandbox-provider'
import { recordPower } from '@/modules/hosts/providers/generation'
import { DaemonTokenService } from '@/modules/daemon/daemon-token.service'
import {
    HostDaemonAccess,
    HostDaemonOfflineError,
    type HostSession
} from '@/modules/agents/adapters/host-daemon-access'

// How long a failed exec-readiness probe stays on a sandbox host as a diagnostic
// marker. Short enough that a recovered VM's record clears without an operator.
const SANDBOX_EXEC_COOLDOWN_MS = 10 * 60_000

export interface SpritesProvisionInput {
    userId: string
    framework: AgentFramework
    // A sprites runtime provider to pin (admins only); null = placement.
    providerId?: string | null
    // When set, attach to this existing sandbox host instead of provisioning
    // a new VM. The provider is the host's, not selected.
    attachHostId?: string | null
    isAdmin: boolean
    credentials: unknown
    emitter: AgentProgressEmitter
    agentId: string
    workspacePath?: string
    workspaceManaged?: boolean
    modelConfig?: AgentModelConfig | null
    // 'runtime-local': the CLI on the machine owns the model credentials, so
    // nothing pins a platform provider there (setUpHostFramework).
    modelConfigSource?: AgentModelConfigSource | null
    frameworkVersion?: string | null
    // Provenance of `frameworkVersion`; drives whether a failed install is fatal
    // or degrades to the framework's built-in default. See installFrameworkVersionOn.
    frameworkVersionSource?: FrameworkInstallSource
    // Repository a git-installed framework clones from, resolved with
    // `frameworkVersion` so the two cannot name different repos.
    frameworkRepo?: string | null
    frameworkArtifacts?: FrameworkReleaseArtifacts | null
}

// A runtime on a sandbox the user already owns, with no agent yet: the
// framework installed (or, for a service framework, installed and started) and
// the row published ready, so accounts can be added and the first agent joins
// through the attach path like any later one.
export interface SpritesPrepareInput {
    userId: string
    framework: AgentFramework
    hostId: string
    // Service frameworks write these into their gateway config; a prepare
    // passes none, and the first agent's provider pick lands them via the
    // credentials update + restart.
    credentials?: unknown
    frameworkVersion?: string | null
    frameworkVersionSource?: FrameworkInstallSource
    frameworkRepo?: string | null
    frameworkArtifacts?: FrameworkReleaseArtifacts | null
}

export interface SpritesPrepareOutput {
    runtime: AgentRuntimeRow
    endpointUrl?: string | null
    generatedCredentials?: Record<string, string>
}

export interface SpritesProvisionOutput {
    runtime: AgentRuntimeRow
    host: RuntimeHostRow
    provider: { id: string; name: string }
    homeDir: string | null
    /** sprite URL captured from a service-kind bootstrap, for the runtime's ingress. */
    endpointUrl?: string | null
    /** Tokens generated by a service-kind bootstrap (apiServerKey, gatewayToken). */
    generatedCredentials?: Record<string, string>
}

// What a create left on the machine. A service framework reports its home,
// its sprite URL and the tokens its bootstrap minted; a coding framework's
// home is the one the daemon declared.
interface FrameworkOnSprite {
    installedVersion: string | null
    homeDir?: string
    endpointUrl?: string | null
    generatedCredentials?: Record<string, string>
}

interface SpriteHost {
    host: RuntimeHostRow
    provider: RuntimeProvider
    client: SpritesClient
    spriteName: string
}

// Sprites hosts (ADR-0037): a hosted host on a sprites.dev organisation, its
// machine made by the sprites adapter, its daemon brought up by the runner
// manager, and every framework on it installed through that daemon.
@Injectable()
export class SpritesProvisioner {
    private readonly log = new Logger(SpritesProvisioner.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly hosts: HostsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly clients: HostProviderClients,
        private readonly placement: HostPlacementService,
        private readonly providers: SandboxProviderRegistry,
        private readonly hostAccess: HostDaemonAccess,
        private readonly tokens: DaemonTokenService,
        private readonly runtimes: AgentRuntimesService,
        private readonly serviceBootstraps: SpriteServiceBootstraps,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly config: ConfigService,
        private readonly keepAliveLease: SpriteKeepAliveLeaseService,
        private readonly activeDuration: SandboxActiveDurationService,
        @Optional() private readonly runtimeToken?: RuntimeTokenService
    ) {}

    private spritesLogger(): SpritesLogger {
        return this.clients.spritesLoggerFor(this.log)
    }

    // Run a daemon (service-kind) bootstrap, degrading to the framework's
    // built-in version when we only *implicitly* asked for the newest upstream
    // release. Unlike a coding agent — where the sprite image already ships a
    // working CLI to fall back on — a daemon has nothing installed, so the only
    // way to honour "keep creating agents even when the newest release is
    // broken" is to re-run an npm bootstrap unpinned (openclaw dist-tag).
    // Git defaults have no catalog admission, so git failures and asked-for
    // versions (user dto / admin pin) fail loud instead.
    //
    // The retry is deliberately narrowed to the `<framework>-install` step, which
    // is the FIRST thing every daemon bootstrap does — before it writes config or
    // touches the Services API. Re-running after a later failure is not safe: the
    // service would already exist with the first attempt's generated tokens, and
    // `upsertService` alone does not propagate new env (that needs the
    // delete→upsert→start dance in `restart()`), so the sprite would keep running
    // token A while we persist token B.
    private async runServiceBootstrap(
        bootstrap: SpriteServiceBootstrap,
        ctx: BootstrapContext,
        credentials: unknown
    ): Promise<
        SpriteServiceBootstrapResult & { installedVersion: string | null }
    > {
        const requested = ctx.frameworkVersion ?? null
        try {
            const result = await bootstrap.run(ctx, credentials)
            return {
                ...result,
                installedVersion: requested?.replace(/^v/, '') ?? null
            }
        } catch (err) {
            const retryable =
                frameworkVersionDescriptor(bootstrap.framework).source
                    .kind === 'npm' &&
                requested !== null &&
                ctx.frameworkVersionSource === 'latest' &&
                err instanceof BootstrapError &&
                err.step === `${bootstrap.framework}-install`
            if (!retryable) throw err
            ctx.logger.warn(`${bootstrap.framework}.install.latest.failed`, {
                spriteName: ctx.spriteName,
                requested,
                detail: (err as Error).message
            })
            // Version left null: we don't know what the fallback installed, and
            // guessing would put a wrong version on the runtime row. The existing
            // probe / sandbox detect fills it in.
            const result = await bootstrap.run(
                {
                    ...ctx,
                    frameworkVersion: null,
                    frameworkVersionSource: 'none'
                },
                credentials
            )
            return { ...result, installedVersion: null }
        }
    }

    /**
     * Mint and persist the agent's runtime identity for per-exec injection.
     * Split out of provisioning because the mint writes
     * an agent_runtime_tokens row whose agent_id FK references agents.id — so it
     * MUST run AFTER the agents row is inserted, not during bootstrap.
     *
     * Fail-loud (§3.5 gate): when there is a reachable API URL the identity is
     * mandatory — a missing token service or a mint failure
     * failure all throw so the caller rolls the half-provisioned runtime back
     * via teardownRuntime (never a tokenless agent in a gated env). Without an
     * API URL the token is inert (the agent falls back to `mf login`), so we
     * skip with a single WARN — preserving local/non-gated provisions.
     */
    async installRuntimeIdentity(args: {
        userId: string
        agentId: string
    }): Promise<void> {
        const apiBaseUrl = this.config?.get<string>('PUBLIC_API_BASE_URL')
        if (!apiBaseUrl) {
            this.log.warn(
                `skipping runtime identity for ${args.agentId}: PUBLIC_API_BASE_URL not configured`
            )
            return
        }
        if (!this.runtimeToken)
            throw new Error(
                `runtime identity required for ${args.agentId} (PUBLIC_API_BASE_URL is set) but RuntimeTokenService is not wired`
            )
        // Mint + encrypt-store the per-agent identity. It is injected per-exec
        // from the encrypted copy, NOT written to the shared sprite profile, so
        // co-resident agents on one VM keep distinct identities.
        await this.runtimeToken.mintRuntimeIdentity({
            userId: args.userId,
            agentId: args.agentId,
            runtimeKind: 'sprites'
        })
    }

    // Attach uses the sandbox's own provider (the VM already lives there), not
    // a freshly-selected one. Validates ownership, kind and a ready host.
    private async resolveAttachHost(
        userId: string,
        hostId: string
    ): Promise<SpriteHost> {
        const host = await this.hosts.findForUser(userId, hostId)
        if (
            !host ||
            host.kind !== 'hosted' ||
            host.status !== 'ready' ||
            host.providerRef?.kind !== 'sprites' ||
            !host.providerRef.spriteId
        )
            throw new NotFoundException({
                message: `sandbox ${hostId} not available`,
                code: 'SANDBOX_NOT_FOUND'
            })
        return this.spriteHost(host)
    }

    private async spriteHost(host: RuntimeHostRow): Promise<SpriteHost> {
        const { client, spriteName, provider } =
            await this.clients.spritesClientForHost(host, this.spritesLogger())
        if (provider.kind !== 'sprites')
            throw new NotFoundException({
                message: `sandbox ${host.id} is not a sprite`,
                code: 'SANDBOX_NOT_FOUND'
            })
        return { host, provider, client, spriteName }
    }

    // Bring up the machine of a host the caller has already inserted
    // (`hosted`, `provisioning`, provider kind sprites) and its daemon
    // (ADR-0037): adapter.create under a fresh generation, the host helpers,
    // then the daemon — whose register with a token bound to the host is what
    // makes the host `ready`. A failure leaves the host `failed` with the
    // reason, its machine torn down best-effort so nothing bills.
    async provisionSandbox(args: { host: RuntimeHostRow }): Promise<RuntimeHostRow> {
        const provider = await this.clients.providerForHost(args.host)
        const adapter = this.providers.for(provider.kind)
        try {
            const generation = await this.hosts.bumpGeneration(args.host.id)
            await adapter.create({
                host: args.host,
                provider,
                generation,
                spec: {
                    name: args.host.name,
                    region: args.host.region,
                    cpuMillicores: args.host.cpuMillicores,
                    memoryMb: args.host.memoryMb,
                    diskGb: args.host.diskGb
                }
            })
            await recordPower(this.hosts, args.host.id, 'running')
            const created = await this.requireHost(args.host.id)
            await this.onHostDaemon(created, '-', 'provision-sandbox', async () => undefined)
            const ready = await this.requireHost(created.id)
            if (ready.status === 'provisioning')
                return (await this.hosts.setStatus(ready.id, 'ready')) ?? ready
            return ready
        } catch (err) {
            const reason = describeError(err)
            this.log.warn(
                `sandbox provisioning failed hostId=${args.host.id}: ${reason}`
            )
            await this.hosts.setStatus(args.host.id, 'failed', reason)
            const current = await this.hosts.findById(args.host.id)
            if (current)
                await adapter
                    .destroy({
                        host: current,
                        provider,
                        generation: current.generation
                    })
                    .catch((cleanupErr: Error) =>
                        this.log.warn(
                            `sandbox cleanup failed hostId=${args.host.id}: ${cleanupErr.message}`
                        )
                    )
            throw err
        }
    }

    private async requireHost(hostId: string): Promise<RuntimeHostRow> {
        const host = await this.hosts.findById(hostId)
        if (!host) throw new Error(`host ${hostId} disappeared`)
        return host
    }

    // Record that a sandbox host failed an exec probe. Nothing consumes the
    // cooldown for placement any more (placement is explicit — see
    // reserveSpriteRuntime), so this is the diagnostic trail for a wedged VM.
    private async quarantineHost(hostId: string, detail: string): Promise<void> {
        const until = new Date(Date.now() + SANDBOX_EXEC_COOLDOWN_MS)
        await this.hosts.patch(hostId, { execCooldownUntil: until })
        this.log.warn(
            `sandbox host quarantined ${JSON.stringify({
                hostId,
                cooldownUntil: until.toISOString(),
                detail
            })}`
        )
    }

    // Work on the host's daemon, for a runtime about to be installed or
    // bootstrapped on it, under the machine's awake hold for the whole of it
    // (ADR-0038). On an attach the VM may have no liveness signal at all — a
    // sprite whose exec endpoint is chronically 502ing would otherwise fail
    // deep inside bootstrap — so an exec-endpoint verdict from the bring-up
    // quarantines the host and answers a clean 503. There is no failover: the
    // caller named one sandbox.
    private async onHostDaemon<T>(
        host: RuntimeHostRow,
        agentId: string,
        reason: string,
        work: (session: HostSession) => Promise<T>
    ): Promise<T> {
        try {
            return await this.hostAccess.withHost(
                { host, daemon: null, placement: 'sprites', agentId, reason },
                work
            )
        } catch (err) {
            if (!(err instanceof HostDaemonOfflineError)) throw err
            if (err.execFailure) {
                const detail = `exec ${err.execFailure.failureClass}${
                    err.execFailure.upstreamStatus
                        ? ` HTTP ${err.execFailure.upstreamStatus}`
                        : ''
                }`
                await this.quarantineHost(host.id, detail)
                throw new ServiceUnavailableException({
                    message: `sandbox is not accepting commands (${detail})`,
                    code: 'SANDBOX_EXEC_UNAVAILABLE'
                })
            }
            throw new ServiceUnavailableException({
                message: `sandbox ${host.id} has no reachable daemon (${err.reason})`,
                code: 'SANDBOX_DAEMON_OFFLINE'
            })
        }
    }

    private sessionRunner(
        host: RuntimeHostRow,
        session: HostSession
    ): SessionScriptRunner {
        return sessionScriptRunner({ run: session.exec }, (event, fields) =>
            this.log.warn(`${event} ${JSON.stringify({ hostId: host.id, ...fields })}`)
        )
    }

    // An agent's workspace on the machine, through its daemon: a managed one
    // is created under the daemon's workspace root; a custom one is the
    // user's own directory, checked usable and admitted as a root.
    private async ensureWorkspace(
        session: HostSession,
        path: string,
        managed: boolean
    ): Promise<void> {
        try {
            await session.rpc({
                method: 'workspace.ensure',
                payload: { path, create: managed }
            })
        } catch (err) {
            const message = (err as Error).message
            if (isWorkspacePreflightUserError(message))
                throw new BadRequestException(message)
            throw err
        }
    }

    async provisionRuntime(
        input: SpritesProvisionInput
    ): Promise<SpritesProvisionOutput> {
        const { userId, framework, isAdmin, credentials, emitter, agentId } =
            input

        emitter.step('selecting_account')
        const attached = input.attachHostId
            ? await this.resolveAttachHost(userId, input.attachHostId)
            : null
        const provider =
            attached?.provider ??
            (await this.placement.selectProvider({
                kind: 'sprites',
                providerId: input.providerId ?? null,
                callerIsAdmin: isAdmin
            }))

        const workspacePath =
            input.workspacePath ?? codingAgentWorkspacePath('sprites', agentId)
        const workspaceManaged = input.workspaceManaged ?? true

        emitter.step('checking_quota')
        // reserveSpriteRuntime assigns the sandbox host atomically under the
        // per-user lock. hostCreated=false means we landed on an existing VM
        // (co-resident framework) and must first prove its daemon answers.
        const { runtime: reserved, hostCreated } =
            await this.runtimeAccess.reserveSpriteRuntime({
                id: createObjectId('agentRuntime'),
                userId,
                framework,
                providerId: provider.id,
                hostId: attached?.host.id,
                mountPath: workspacePath,
                currentPhase: 'creating_sprite'
            })
        const runtimeId = reserved.id
        if (!reserved.hostId)
            throw new Error(
                `reserveSpriteRuntime assigned no host for ${runtimeId}`
            )
        let host = await this.requireHost(reserved.hostId)

        try {
            if (hostCreated) {
                emitter.step('creating_sprite')
                host = await this.provisionSandbox({ host })
            }
            const coding = isCodingHostFramework(framework) ? framework : null
            await this.runtimes.setPhase(runtimeId, 'bootstrapping')
            emitter.step('bootstrapping')
            const install = {
                frameworkVersion: input.frameworkVersion ?? null,
                frameworkVersionSource: input.frameworkVersionSource ?? 'none',
                frameworkRepo: input.frameworkRepo ?? null,
                frameworkArtifacts: input.frameworkArtifacts ?? null
            }
            // The whole create runs in one session on the machine, held awake
            // until the framework is in place (ADR-0038), and everything a
            // coding framework needs goes through the daemon (ADR-0037 R6).
            // An attached sandbox proves its daemon answers before anything
            // is written to it.
            const created = await this.onHostDaemon(
                host,
                agentId,
                `create-${framework}`,
                async (session): Promise<FrameworkOnSprite> => {
                    if (coding) {
                        await this.ensureWorkspace(
                            session,
                            workspacePath,
                            workspaceManaged
                        )
                        // Coding CLIs install to the resolved version here;
                        // claude-code is a big package, so it gets its own
                        // step or `bootstrapping` sits over a minute and
                        // looks dead.
                        emitter.step('installing_framework')
                        const setup = await setUpHostFramework({
                            runner: this.sessionRunner(host, session),
                            framework: coding,
                            workspaceBase: CODING_WORKSPACES_ROOT,
                            credentials,
                            modelConfigSource: input.modelConfigSource ?? null,
                            install: { ...install, execTimeoutMs: 60_000 }
                        })
                        return { installedVersion: setup.frameworkVersion }
                    }
                    const serviceBootstrap = this.serviceBootstraps.get(framework)
                    if (!serviceBootstrap)
                        throw new Error(
                            `sprites runtime does not support framework ${framework}`
                        )
                    if (!workspaceManaged)
                        await this.ensureWorkspace(session, workspacePath, false)
                    const { client, spriteName } = await this.spriteHost(host)
                    // Heartbeat steps for service-kind bootstraps — install
                    // can take ~3 min and starting the service another ~10s.
                    // Without these the UI sits on `bootstrapping` and looks
                    // dead.
                    emitter.step('installing_framework')
                    const result = await this.runServiceBootstrap(
                        serviceBootstrap,
                        {
                            agentId,
                            runtimeId,
                            userId,
                            spriteName,
                            mountPath: workspacePath,
                            client,
                            logger: this.spritesLogger(),
                            execTimeoutMs: 60_000,
                            modelConfig: input.modelConfig ?? null,
                            modelConfigSource: input.modelConfigSource ?? null,
                            ...install
                        },
                        credentials
                    )
                    emitter.step('starting_service')
                    return {
                        installedVersion: result.installedVersion,
                        homeDir: result.homeDir,
                        endpointUrl: result.endpointUrl,
                        generatedCredentials: result.generatedCredentials
                    }
                }
            )

            if (created.installedVersion)
                await this.runtimes.applyProvisioningPatch(runtimeId, {
                    frameworkVersion: created.installedVersion,
                    frameworkVersionCheckedAt: new Date()
                })

            const refreshed = await this.runtimes.findById(runtimeId)
            if (!refreshed) throw new Error('runtime row disappeared')
            // The home the daemon declared when it registered.
            const current = await this.requireHost(host.id)
            return {
                runtime: refreshed,
                host: current,
                provider: { id: provider.id, name: provider.name },
                homeDir: created.homeDir ?? current.homeDir ?? null,
                endpointUrl: created.endpointUrl,
                generatedCredentials: created.generatedCredentials
            }
        } catch (err) {
            const reason = describeError(err)
            if (hostCreated) {
                // The VM is ours and nothing else lives on it: it goes, and
                // so does the runtime slot it was made for.
                await this.discardHost(host, reason)
            } else {
                // A reused host survives (it still owns its other runtimes);
                // the runtime keeps its slot as `failed` so a retry reuses
                // it. A transient sprite failure here would otherwise leave
                // the host first in line for the next create — the exact
                // loop the readiness probe exists to break. Quarantine it
                // too; the probe only covers the window before bootstrap.
                if (isTransientSpriteError(err))
                    await this.quarantineHost(
                        host.id,
                        'exec endpoint unavailable before connection opened'
                    ).catch((markErr: unknown) =>
                        this.log.warn(
                            `sandbox host quarantine failed for ${host.id} class=${errorClass(markErr)}`
                        )
                    )
                await this.runtimes.applyStatusPatch(runtimeId, {
                    status: 'failed',
                    failureReason: reason
                })
                await this.runtimes.setPhase(runtimeId, null)
            }
            throw err
        }
    }

    async prepareRuntime(
        input: SpritesPrepareInput
    ): Promise<SpritesPrepareOutput> {
        const { userId, framework, hostId } = input
        const { host, provider } = await this.resolveAttachHost(userId, hostId)
        const coding = isCodingHostFramework(framework) ? framework : null
        const serviceBootstrap = coding
            ? undefined
            : this.serviceBootstraps.get(framework)
        if (!coding && !serviceBootstrap)
            throw new ConflictException(
                `sprites runtime does not support framework ${framework}`
            )
        // The row's mount path is a seed only: a coding agent brings its own
        // workspace when it attaches, and a service framework's home is what
        // its bootstrap uses.
        const mountPath =
            this.serviceBootstraps.mountPath(framework) ??
            CODING_WORKSPACES_ROOT
        const { runtime: reserved } =
            await this.runtimeAccess.reserveSpriteRuntime({
                id: createObjectId('agentRuntime'),
                userId,
                framework,
                providerId: provider.id,
                hostId: host.id,
                mountPath,
                currentPhase: 'bootstrapping'
            })
        const runtimeId = reserved.id
        const install = {
            frameworkVersion: input.frameworkVersion ?? null,
            frameworkVersionSource: input.frameworkVersionSource ?? 'none',
            frameworkRepo: input.frameworkRepo ?? null,
            frameworkArtifacts: input.frameworkArtifacts ?? null
        }
        try {
            const prepared = await this.onHostDaemon(
                host,
                '-',
                `prepare-${framework}`,
                async (session): Promise<FrameworkOnSprite> => {
                    // A prepare has no agent: the framework's own directories,
                    // its configuration and its CLI, as a create sets up.
                    if (coding) {
                        const setup = await setUpHostFramework({
                            runner: this.sessionRunner(host, session),
                            framework: coding,
                            workspaceBase: CODING_WORKSPACES_ROOT,
                            credentials: input.credentials ?? null,
                            modelConfigSource: null,
                            install: { ...install, execTimeoutMs: 60_000 }
                        })
                        return { installedVersion: setup.frameworkVersion }
                    }
                    const { client, spriteName } = await this.spriteHost(host)
                    return this.runServiceBootstrap(
                        serviceBootstrap!,
                        {
                            // No agent yet; the bootstraps only read this for
                            // per-agent paths, none of which a prepare touches.
                            agentId: '',
                            runtimeId,
                            userId,
                            spriteName,
                            mountPath,
                            client,
                            logger: this.spritesLogger(),
                            execTimeoutMs: 60_000,
                            ...install
                        },
                        input.credentials ?? {}
                    )
                }
            )
            if (prepared.installedVersion)
                await this.runtimes.applyProvisioningPatch(runtimeId, {
                    frameworkVersion: prepared.installedVersion,
                    frameworkVersionCheckedAt: new Date()
                })
            await this.finalizeReady(runtimeId, new Date())
            const runtime = await this.runtimes.findById(runtimeId)
            if (!runtime) throw new Error('runtime row disappeared')
            return {
                runtime,
                endpointUrl: prepared.endpointUrl,
                generatedCredentials: prepared.generatedCredentials
            }
        } catch (err) {
            // The sandbox is the user's and keeps living; the row this
            // prepare claimed reads failed and keeps its slot for a retry.
            await this.runtimes.applyStatusPatch(runtimeId, {
                status: 'failed',
                failureReason: describeError(err)
            })
            await this.runtimes.setPhase(runtimeId, null)
            throw err
        }
    }

    async finalizeReady(runtimeId: string, now: Date): Promise<void> {
        await this.runtimes.applyStatusPatch(runtimeId, {
            status: 'ready',
            lastBootstrappedAt: now,
            failureReason: null
        })
        await this.runtimes.setPhase(runtimeId, null)
    }

    /**
     * Wake the sprite-side framework service. Never holds the machine
     * awake: the host's keep-awake switch does (HostKeepAwakeService), not
     * traffic, and the service's pre-start cleanup leaves the switch's hold
     * alone.
     */
    async wakeSpriteRuntime(runtime: AgentRuntimeRow): Promise<void> {
        await this.keepAliveLease.ensureServiceRunning(runtime)
    }

    // Delete a runtime. Refused while a ready agent still lives on it (R8);
    // agents mid-create go with it, as the rollback of a failed create relies
    // on. When this empties the host, the default PRESERVES the VM (sets
    // emptied_at so the reaper deletes it after the idle window) so a deleted
    // agent leaves a reusable sandbox. reapImmediatelyIfEmpty restores the
    // eager delete for explicit runtime deletes + failed creates.
    async teardownRuntime(
        runtime: AgentRuntimeRow,
        opts?: { reapImmediatelyIfEmpty?: boolean }
    ): Promise<void> {
        const reapImmediately = opts?.reapImmediatelyIfEmpty ?? false
        const [ready] = await this.db
            .select({ value: count() })
            .from(agents)
            .where(
                and(eq(agents.runtimeId, runtime.id), eq(agents.status, 'ready'))
            )
        if (Number(ready?.value ?? 0) > 0)
            throw new ConflictException({
                message: 'runtime still has agents; delete them first',
                code: 'RUNTIME_NOT_EMPTY'
            })
        // Settle any open active-duration interval before this teardown clears
        // the host's running status or deletes the row, so the final running
        // seconds are credited and no stale watermark survives. If the host stays
        // occupied + running, the next status sample re-opens it (≤3s gap).
        if (runtime.hostId)
            await this.activeDuration.settleHostNotRunning(
                runtime.hostId,
                runtime.userId,
                new Date()
            )
        // Serialize against reserveSpriteRuntime (same per-user advisory lock,
        // namespace 0) so a concurrent attach can't reuse this host between the
        // emptiness check and the marking/deletion.
        const action = await this.db.transaction(async (tx) => {
            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${runtime.userId}, 0))`
            )
            await tx.delete(agents).where(eq(agents.runtimeId, runtime.id))
            await tx
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.id, runtime.id))
            if (!runtime.hostId) return 'keep' as const
            const [row] = await tx
                .select({ value: count() })
                .from(agentRuntimes)
                .where(eq(agentRuntimes.hostId, runtime.hostId))
            if (Number(row?.value ?? 0) > 0) return 'keep' as const
            if (!reapImmediately) {
                // Preserve the now-empty VM. Start the reaper clock and clear
                // the accrual watermark so it stops counting.
                await tx
                    .update(runtimeHosts)
                    .set({
                        emptiedAt: new Date(),
                        activeAccrualSince: null,
                        updatedAt: new Date()
                    })
                    .where(
                        and(
                            eq(runtimeHosts.id, runtime.hostId),
                            eq(runtimeHosts.kind, 'hosted'),
                            sql`${runtimeHosts.emptiedAt} is null`
                        )
                    )
                return 'keep' as const
            }
            return 'reap' as const
        })
        if (action !== 'reap' || !runtime.hostId) return
        const host = await this.hosts.findById(runtime.hostId)
        if (host) await this.discardHost(host, 'runtime deleted')
    }

    // Remove a host the platform made and nothing lives on any more (R8):
    // `deleting` → tokens revoked → adapter.destroy → runtimes, daemon and
    // host rows gone in one transaction. A destroy that fails leaves the host
    // `deleting` with the reason, for a retry.
    private async discardHost(host: RuntimeHostRow, reason: string): Promise<void> {
        const provider = await this.clients.providerForHost(host)
        const adapter = this.providers.for(provider.kind)
        await this.activeDuration.settleHostNotRunning(
            host.id,
            host.userId,
            new Date()
        )
        const generation = await this.db.transaction(async (tx) => {
            await this.hosts.patch(
                host.id,
                { status: 'deleting', failureReason: reason },
                tx
            )
            await this.tokens.revokeForHost(host.id, tx)
            return host.generation
        })
        const current = (await this.hosts.findById(host.id)) ?? host
        try {
            await adapter.destroy({
                host: current,
                provider,
                generation: Math.max(generation, current.generation)
            })
        } catch (err) {
            this.log.warn(
                `sandbox destroy failed hostId=${host.id}: ${(err as Error).message}`
            )
            return
        }
        await this.db.transaction(async (tx) => {
            await tx
                .delete(agentRuntimes)
                .where(eq(agentRuntimes.hostId, host.id))
            await tx.delete(hostDaemons).where(eq(hostDaemons.hostId, host.id))
            await tx.delete(runtimeHosts).where(eq(runtimeHosts.id, host.id))
        })
    }

    // The daemon rows of the hosts a batch of runtimes lives on, for callers
    // that render availability without a RuntimeContext lookup per row.
    async daemonsForHosts(hostIds: string[]) {
        return this.hostDaemons.findByHostIds(hostIds)
    }

    async agentsOnHost(hostId: string): Promise<number> {
        const [row] = await this.db
            .select({ value: count() })
            .from(agents)
            .innerJoin(agentRuntimes, eq(agentRuntimes.id, agents.runtimeId))
            .where(eq(agentRuntimes.hostId, hostId))
        return Number(row?.value ?? 0)
    }

    async runtimesOnHosts(hostIds: string[]): Promise<AgentRuntimeRow[]> {
        if (hostIds.length === 0) return []
        return this.db
            .select()
            .from(agentRuntimes)
            .where(inArray(agentRuntimes.hostId, hostIds))
    }
}

// Only a transient sprite failure says anything about host health. Auth, quota,
// not_found and a framework's own non-zero exit are the agent's problem, not the
// VM's, and must not take a working host out of rotation.
const isTransientSpriteError = (err: unknown): boolean =>
    err instanceof SpritesError &&
    err.code === 'transient' &&
    err.execPhase === 'pre_open'

const errorClass = (err: unknown): string =>
    err instanceof SpritesError
        ? `SpritesError:${err.code}`
        : err instanceof Error && err.name
          ? err.name
          : typeof err

const describeError = (err: unknown): string =>
    ((err as Error)?.message ?? 'unknown error')
        .slice(0, 512)
        .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')

// Where the coding CLIs' workspaces live on a sprite; a service framework's
// runtime lives in its own home instead (SpriteServiceBootstraps.mountPath).
const CODING_WORKSPACES_ROOT = `${SPRITE_HOME_BASE}/.manyfold/workspaces`
