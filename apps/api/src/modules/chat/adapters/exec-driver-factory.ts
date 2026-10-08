import {
    MF_ENV_AGENT_ID,
    MF_ENV_API_TOKEN,
    MF_ENV_API_URL,
    MF_ENV_DEPLOY_ENV,
    envTextFromExtras,
    envTextToRecord,
    frameworkCapability,
    frameworkDefinition,
    DAEMON_FEATURE_AUTH_CONTEXT,
    DAEMON_FEATURE_EXEC_ROOTS,
    DAEMON_MIN_CLI_VERSION,
    isCliVersionTooOld,
    DAEMON_FEATURE_EXEC_RESOURCES,
    type RuntimePlacement
} from '@manyfold/shared'
import type { AgentModelConfigSource } from '@manyfold/shared'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import {
    agentCredentials,
    userModelProviders,
    type Agent,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import type { DaemonAuthContextRef } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import {
    assertHostHonoursAuthContext,
    authContextRefFor,
    effectiveModelConfigSource
} from '@/modules/agents/model-config/runtime-auth-selection'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    RuntimeTokenService,
    decryptActiveIdentityToken,
    type RuntimeKind
} from '@/modules/auth/runtime-token.service'
import type { ExecDriver } from './exec-driver'
import {
    DaemonExecDriver,
    type DaemonExecDriverOptions
} from './daemon-exec-driver'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from './daemon-fenced-dispatch.service'
import {
    DaemonRecoveryFs,
    type RecoveryFs
} from '@/modules/chat/recovery/recovery-fs'
import { OpenclawRpcClient } from './openclaw-rpc-client'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { HostStorageService } from '@/modules/agents/host-storage/host-storage.service'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import {
    HostBringUpService
} from '@/modules/hosts/bring-up/host-bring-up.service'
import type { AwakeHold } from '@/modules/hosts/host-awake.service'
import { TurnDaemonError, type TurnDaemon } from '@/modules/chat/turn-daemon'
import { SANDBOX_MAINTENANCE_CODE } from '@/modules/chat/sandbox-maintenance-terminal'
import { spriteExecHealthConfig } from '@/modules/agents/sprite-exec-health/sprite-exec-health.service'
import { resolveMfDeployEnv } from '@/common/deploy-env'
import { ConnectionsService } from '@/modules/connections/connections.service'
import { UNKNOWN_PRICE_SCOPE, verifiedCodingPriceScope, type ServedPriceScope } from '@/modules/usage/served-price-scope'
import {
    RuntimeContextService,
    type RuntimeContext
} from '@/modules/hosts/runtime-context.service'
import { HostDaemonsService } from '@/modules/hosts/host-daemons.service'
import { HostDaemonAccess } from '@/modules/agents/adapters/host-daemon-access'
import type { ExecEndpointFailureClass } from '@/modules/hosts/providers/sandbox-provider'

export type ExecPlacement = Exclude<RuntimePlacement, 'external'>

export interface ExecDriverHandle {
    driver: ExecDriver
    // The host id: the routing key of the daemon that carries the turn.
    hostId: string
    creds: unknown
    resolvePriceScope?: () => Promise<ServedPriceScope>
    supportsExecResources?: () => Promise<boolean>
    runtime: ExecPlacement
    agent: Agent
    // Already included in the daemon driver's environment.
    baseEnv?: Record<string, string>
    authContext: DaemonAuthContextRef | null
}

// For reads made right after it resolves: resolving is what admitted the wake
// (the active slot, the bring-up). Each read holds a sandbox only while it
// runs, so a read made once the sandbox has gone back to sleep wakes it again
// outside that admission.
export interface RecoveryFsHandle {
    hostId: string
    fs: RecoveryFs
    runtime: ExecPlacement
    agent: Agent
}

type AgentContext = RuntimeContext & { agent: Agent; host: RuntimeHostRow }

// Every turn reaches its machine the same way (ADR-0037): agent → runtime →
// host → the host's one daemon. The placement only decides what rides along
// (credentials, identity token, sprite awake holds); the transport is always
// the daemon RPC keyed by the host id.
@Injectable()
export class ExecDriverFactory {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly runtimeContext: RuntimeContextService,
        private readonly crypto: CryptoService,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly spriteStorage: HostStorageService,
        private readonly connections: ConnectionsService,
        private readonly hostDaemons: HostDaemonsService,
        private readonly hostAccess: HostDaemonAccess,
        @Optional() private readonly config?: ConfigService,
        // Appended LAST and @Optional so positional test construction keeps
        // working; absent, daemon drivers dispatch unfenced as before.
        @Optional()
        private readonly fencedDispatch?: DaemonFencedDispatchService,
        // Same convention; absent, a daemon agent with no minted identity
        // simply gets no MF_API_TOKEN (#781).
        @Optional()
        private readonly runtimeTokens?: RuntimeTokenService,
        @Optional() private readonly bringUp?: HostBringUpService
    ) {}

    // The agent with its machine, for every path below; an external agent
    // has no machine and is refused by the callers' own words.
    private async contextFor(agentId: string): Promise<RuntimeContext & { agent: Agent }> {
        const ctx = await this.runtimeContext.forAgent(agentId)
        if (!ctx?.agent) throw new Error(`agent ${agentId} not found`)
        return ctx as RuntimeContext & { agent: Agent }
    }

    private requireMachine(
        ctx: RuntimeContext & { agent: Agent },
        what: string
    ): AgentContext {
        if (ctx.placement === 'external' || !ctx.host)
            throw new Error(`external agents have no ${what}`)
        return ctx as AgentContext
    }

    async forAgent(
        agentId: string,
        preloaded?: Agent,
        turnSource?: AgentModelConfigSource,
        carryingDaemonId?: string
    ): Promise<ExecDriverHandle> {
        const ctx = this.requireMachine(await this.contextFor(agentId), 'exec driver')
        const agent = preloaded?.id === agentId ? preloaded : ctx.agent
        const placement = ctx.placement as ExecPlacement
        // Per-turn platform/local selection can differ from the saved default.
        // The driver and the injected credentials must use that same selection.
        const selectedAuthContext = authContextRefFor(
            turnSource
                ? { ...agent, extras: { modelConfig: { source: turnSource } } }
                : agent,
            placement
        )

        const runner = carryingDaemonId
            ? { hostId: carryingDaemonId, roots: turnRoots(agent, placement) }
            : await this.resolveTurnDaemon(ctx)
        const hostId = runner.hostId
        const coding = frameworkCapability(agent.framework).kind === 'coding'
        // A turn on the CLI's own sign-in needs no stored credential, and a
        // sandbox runtime prepared bare has none until a provider is bound —
        // so only a platform turn off a local machine insists on the row.
        const credentialOptional =
            placement === 'daemon' ||
            (turnSource ?? effectiveModelConfigSource(agent, placement)) ===
                'runtime-local'
        const [creds, connectionEnv, identityToken] = await Promise.all([
            credentialOptional
                ? this.tryDecryptCreds(agent.runtimeId)
                : this.decryptCreds(agent.runtimeId),
            coding ? this.connections.resolveAgentEnv(agent) : undefined,
            // A pod host bakes no identity into its Secret (ADR-0035), so a
            // k8s turn gets the same lazily minted, rotatable token as a
            // sprite or daemon turn.
            coding ? this.lazyIdentityToken(agent, placement) : null
        ])
        const baseEnv = coding
            ? agentBaseEnv(this.config, agent, connectionEnv, identityToken)
            : undefined
        if (selectedAuthContext)
            assertHostHonoursAuthContext(
                selectedAuthContext,
                await this.hostFeatures(hostId),
                'this runner'
            )
        if (placement === 'sprites')
            void this.spriteStorage.measureIfDue(agent.id, 'chat')
        return {
            driver: this.daemonDriverFor(hostId, baseEnv, selectedAuthContext, {
                roots: runner.roots,
                reconnect: this.reconnectFor(ctx.host)
            }),
            hostId,
            creds,
            resolvePriceScope: () =>
                this.priceScopeForCredentials(agent, creds),
            supportsExecResources: async () =>
                (await this.hostFeatures(hostId))?.clientFeatures.includes(
                    DAEMON_FEATURE_EXEC_RESOURCES
                ) ?? false,
            runtime: placement,
            agent,
            baseEnv,
            authContext: selectedAuthContext
        }
    }

    // The daemon that will carry a turn for this agent, brought up when the
    // host is hosted and asleep (R11). The handle's daemonId is the host id.
    async resolveTurnDaemon(
        input: Agent | string | (RuntimeContext & { agent: Agent })
    ): Promise<TurnDaemon> {
        const loaded =
            typeof input === 'string'
                ? await this.contextFor(input)
                : 'runtime' in input && 'placement' in input
                  ? input
                  : await this.contextFor(input.id)
        const ctx = this.requireMachine(loaded, 'runner')
        const { agent, host, placement } = ctx
        // The machine is its owner's: an agent never inherits another
        // user's runtime, whatever row points at it.
        if (host.userId !== agent.userId)
            throw new TurnDaemonError(placement, 'runtime owner mismatch')
        if (ctx.availability === 'unavailable')
            throw new TurnDaemonError(placement, 'runtime unavailable')
        // Before the active slot: reserving it opens metering and marks the
        // machine running, and nothing may wake a sandbox in maintenance.
        if (ctx.availability === 'maintenance')
            throw new TurnDaemonError(placement, SANDBOX_MAINTENANCE_CODE)
        const runnerFacts = frameworkDefinition(agent.framework)?.runner
        const roots = turnRoots(agent, placement)
        // A root the daemon does not own by construction (the agent's
        // workspace outside the managed tree, a framework home on a shared
        // machine) rides on the exec, which only a daemon with the feature
        // admits; an older one is asked to update rather than refusing the
        // cwd mid-turn.
        const required = [
            ...(authContextRefFor(agent, placement)
                ? [DAEMON_FEATURE_AUTH_CONTEXT]
                : []),
            ...(runnerFacts?.requiredFeatures ?? []),
            ...(roots.some((root) => !underWorkspaceBase(root, host))
                ? [DAEMON_FEATURE_EXEC_ROOTS]
                : [])
        ]
        // A sandbox turn is metered from its admission: the active slot is
        // reserved before the machine is woken for it.
        if (placement === 'sprites')
            await this.runtimeAccess.reserveActiveSlot({
                userId: agent.userId,
                hostId: host.id
            })
        const ensured = await this.hostAccess.ensure({
            host,
            daemon: ctx.daemon,
            placement,
            agentId: agent.id,
            requiredFeatures: required,
            firstExecTimeoutMs: spriteExecHealthConfig().firstExecTimeoutMs
        })
        if (!ensured.online || !ensured.daemon)
            throw new TurnDaemonError(
                placement,
                ensured.fallbackReason ?? 'runner unavailable',
                ensured.fallbackReason === 'runner_cli_too_old' ||
                    ensured.fallbackReason === 'runner_missing_turn_rpc',
                ensured.execFailure
            )
        const daemon = ensured.daemon
        if (
            isCliVersionTooOld(daemon.cliVersion, DAEMON_MIN_CLI_VERSION) ||
            required.some(
                (feature) => !(daemon.clientFeatures ?? []).includes(feature)
            )
        )
            throw new TurnDaemonError(
                placement,
                'runner version or capability',
                true
            )
        return { hostId: host.id, roots }
    }

    // A turn's first exec.start retries once after the daemon reconnects on
    // a fresh lease (ADR-0038): the turn holds the machine awake, so a socket
    // the thaw replaced is back within seconds.
    private reconnectFor(host: RuntimeHostRow): ((since: Date) => Promise<boolean>) | undefined {
        const manager = this.bringUp
        if (!manager) return undefined
        return async (since) => (await manager.awaitReconnect(host, since)) !== null
    }

    // The exec-health probe on an agent's sandbox (#730), under a reserved
    // active slot; null for an agent that is not on one.
    async probeExecForAgent(
        agentId: string,
        timeoutMs: number
    ): Promise<'ok' | 'inconclusive' | ExecEndpointFailureClass | null> {
        const ctx = await this.contextFor(agentId)
        if (ctx.placement !== 'sprites' || !ctx.host || !this.bringUp)
            return null
        await this.runtimeAccess.reserveActiveSlot({
            userId: ctx.agent.userId,
            hostId: ctx.host.id
        })
        return this.bringUp.probeExec(ctx.host, timeoutMs)
    }

    private async priceScopeForCredentials(agent: Agent, credentials: unknown): Promise<ServedPriceScope> {
        if (!agent.modelProviderId || !['claude-code', 'codex', 'gemini-cli', 'pi', 'antigravity-cli'].includes(agent.framework))
            return { ...UNKNOWN_PRICE_SCOPE }
        const [provider] = await this.db.select().from(userModelProviders)
            .where(eq(userModelProviders.id, agent.modelProviderId)).limit(1)
        if (!provider || provider.userId !== agent.userId) return { ...UNKNOWN_PRICE_SCOPE }
        return verifiedCodingPriceScope({
            framework: agent.framework,
            credentials,
            provider,
            providerApiKey: this.crypto.decrypt({ ciphertext: provider.apiKeyCiphertext, keyVersion: provider.keyVersion })
        })
    }

    // Capability lookup for the auth-context gate: the host's daemon row is
    // the only place a daemon's advertised features live.
    private async hostFeatures(
        hostId: string
    ): Promise<{ clientFeatures: string[] } | null> {
        const row = await this.hostDaemons.findByHostId(hostId)
        return row ? { clientFeatures: row.clientFeatures ?? [] } : null
    }

    // Resume uses this directly, with no new credentials or environment.
    daemonDriverFor(
        daemonId: string,
        baseEnv?: Record<string, string>,
        authContext: DaemonAuthContextRef | null = null,
        options: DaemonExecDriverOptions = {}
    ): ExecDriver {
        return new DaemonExecDriver(
            this.daemonRegistry,
            daemonId,
            baseEnv,
            this.fencedDispatch,
            authContext,
            options
        )
    }

    async recoveryFsForAgent(agentId: string): Promise<RecoveryFsHandle> {
        const ctx = this.requireMachine(
            await this.contextFor(agentId),
            'recovery filesystem'
        )
        const runner = await this.resolveTurnDaemon(ctx)
        return {
            hostId: runner.hostId,
            fs: new DaemonRecoveryFs(
                this.daemonRegistry,
                runner.hostId,
                this.recoveryHold(ctx, ctx.agent.id)
            ),
            runtime: ctx.placement as ExecPlacement,
            agent: ctx.agent
        }
    }

    async openclawRpcForAgent(
        agentId: string,
        carryingDaemonId?: string
    ): Promise<OpenclawRpcClient | null> {
        const ctx = await this.runtimeContext.forAgent(agentId)
        if (!ctx?.agent) return null
        if (ctx.agent.framework !== 'openclaw') return null
        const daemonId =
            carryingDaemonId ??
            (await this.resolveTurnDaemon(ctx as RuntimeContext & { agent: Agent })).hostId
        return new OpenclawRpcClient(
            this.daemonDriverFor(daemonId),
            this.recoveryHold(ctx, agentId)
        )
    }

    // A daemon read is no activity to a sprite, so each history read holds it
    // for its own run (whileHeld); other machines never sleep.
    private recoveryHold(
        ctx: RuntimeContext,
        agentId: string
    ): (() => AwakeHold) | undefined {
        const { bringUp } = this
        const { host } = ctx
        if (ctx.placement !== 'sprites' || !host || !bringUp) return undefined
        return () => bringUp.holdAwake(host, `recovery-${agentId}`)
    }

    // The agent's active identity for a runtime kind, minted lazily on the
    // first turn that needs it: agents attached before daemon identity existed
    // have no 'daemon' token row, and a backfill would mint tokens nothing
    // consumes. Two concurrent first turns can both mint (the second revokes
    // the first's token for that one turn); the next turn heals. Every carrier
    // can afford that rotation because none holds a baked copy of the token:
    // the token rides each exec.

    private async lazyIdentityToken(
        agent: Agent,
        runtimeKind: RuntimeKind
    ): Promise<string | null> {
        const existing = await decryptActiveIdentityToken(
            this.db,
            this.crypto,
            agent.id,
            runtimeKind
        )
        if (existing) return existing
        if (!this.runtimeTokens) return null
        const minted = await this.runtimeTokens.ensureRuntimeIdentity({
            userId: agent.userId,
            agentId: agent.id,
            runtimeKind
        })
        return minted.plaintext
    }

    private async decryptCreds(runtimeId: string): Promise<unknown> {
        const [row] = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, runtimeId))
            .limit(1)
        if (!row)
            throw new Error(`no stored credentials for runtime ${runtimeId}`)
        return JSON.parse(
            this.crypto.decrypt({
                ciphertext: row.payloadCiphertext,
                keyVersion: row.keyVersion
            })
        )
    }

    private async tryDecryptCreds(runtimeId: string): Promise<unknown | null> {
        const [row] = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, runtimeId))
            .limit(1)
        if (!row) return null
        return JSON.parse(
            this.crypto.decrypt({
                ciphertext: row.payloadCiphertext,
                keyVersion: row.keyVersion
            })
        )
    }
}

export const manyfoldRuntimeEnv = (
    config: ConfigService | undefined,
    agentId: string
): Record<string, string> => {
    const env: Record<string, string> = {
        [MF_ENV_AGENT_ID]: agentId
    }
    const apiBaseUrl = config?.get<string>('PUBLIC_API_BASE_URL')?.trim()
    if (apiBaseUrl) env[MF_ENV_API_URL] = publicApiUrlWithApiPrefix(apiBaseUrl)
    env[MF_ENV_DEPLOY_ENV] = resolveMfDeployEnv(
        config?.get<string>('MF_DEPLOY_ENV')
    )
    return env
}

// One composition for every per-exec surface: user extras first so the
// platform groups always win a name collision (reserved prefixes already stop
// most of them at parse time).
const agentBaseEnv = (
    config: ConfigService | undefined,
    agent: Agent,
    connectionEnv: Record<string, string> | undefined,
    identityToken: string | null
): Record<string, string> => ({
    ...envTextToRecord(envTextFromExtras(agent.extras)),
    ...connectionEnv,
    ...manyfoldRuntimeEnv(config, agent.id),
    ...(identityToken ? { [MF_ENV_API_TOKEN]: identityToken } : {})
})

// The directories a turn of this agent runs in beyond the daemon's own
// roots: its workspace (a gateway-backed framework resolves its own on the
// first turn and declares none) and the framework's home roots for the
// placement.
const turnRoots = (agent: Agent, placement: RuntimePlacement): readonly string[] => {
    const facts = frameworkDefinition(agent.framework)?.runner
    const workspace = facts?.lazyWorkspace
        ? null
        : (agent.workspacePath ?? agent.mountPath)
    return [
        ...(workspace ? [workspace] : []),
        ...(facts?.homeRoots?.[placement] ?? [])
    ]
}

// Under the host's managed workspace tree the daemon admits a path by
// construction; anywhere else it has to be told.
const underWorkspaceBase = (path: string, host: RuntimeHostRow): boolean => {
    const base = host.workspaceBaseDir?.replace(/\/+$/, '')
    return Boolean(base && (path === base || path.startsWith(`${base}/`)))
}
