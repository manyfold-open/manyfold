import { randomUUID } from 'node:crypto'
import {
    MF_ENV_AGENT_ID,
    MF_ENV_API_TOKEN,
    MF_ENV_API_URL,
    MF_ENV_DEPLOY_ENV,
    envTextFromExtras,
    envTextToRecord,
    frameworkCapability,
    DAEMON_FEATURE_AUTH_CONTEXT,
    DAEMON_FEATURE_TURN_HERMES,
    DAEMON_FEATURE_TURN_OPENCLAW,
    DAEMON_FEATURE_TURN_OPENCLAW_ACP,
    DAEMON_MIN_CLI_VERSION,
    DAEMON_ONLINE_THRESHOLD_MS,
    isCliVersionTooOld,
    DAEMON_FEATURE_EXEC_RESOURCES
} from '@manyfold/shared'
import type { AgentModelConfigSource } from '@manyfold/shared'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq } from 'drizzle-orm'
import {
    runtimeHosts,
    agents,
    agentCredentials,
    userModelProviders,
    type Agent,
    type Database
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import type { DaemonAuthContextRef } from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import {
    assertHostHonoursAuthContext,
    authContextRefFor
} from '@/modules/agents/model-config/runtime-auth-selection'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    RuntimeTokenService,
    decryptActiveIdentityToken,
    type RuntimeKind
} from '@/modules/auth/runtime-token.service'
import type { ExecDriver } from './exec-driver'
import { DaemonExecDriver } from './daemon-exec-driver'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from './daemon-fenced-dispatch.service'
import {
    DaemonRecoveryFs,
    type RecoveryFs
} from '@/modules/chat/recovery/recovery-fs'
import { OpenclawRpcClient } from './openclaw-rpc-client'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { SpriteStorageService } from '@/modules/agents/sprite-storage/sprite-storage.service'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import {
    RunnerManagerService,
    type RunnerResolution,
    type SpriteAwakeHold
} from '@/modules/chat/runner/runner-manager.service'
import { ChatRunnerError, type ChatRunner } from '@/modules/chat/runner/chat-runner'
import { spriteExecHealthConfig } from '@/modules/agents/sprite-exec-health/sprite-exec-health.service'
import { execSprite } from '@manyfold/sprites'
import { resolveMfDeployEnv } from '@/common/deploy-env'
import { ConnectionsService } from '@/modules/connections/connections.service'
import { UNKNOWN_PRICE_SCOPE, verifiedCodingPriceScope, type ServedPriceScope } from '@/modules/usage/served-price-scope'

export interface ExecDriverHandle {
    driver: ExecDriver
    daemonId: string
    creds: unknown
    resolvePriceScope?: () => Promise<ServedPriceScope>
    supportsExecResources?: () => Promise<boolean>
    runtime: 'sprites' | 'k8s' | 'daemon'
    agent: Agent
    // Already included in the daemon driver's environment.
    baseEnv?: Record<string, string>
    authContext: DaemonAuthContextRef | null
}

export interface RecoveryFsHandle {
    daemonId: string
    fs: RecoveryFs
    runtime: 'sprites' | 'k8s' | 'daemon'
    agent: Agent
    awakeHold?: SpriteAwakeHold
    // Sprite bootstrap/health only; transcript access always uses the daemon.
    spritesClient?: SpritesClient
}

@Injectable()
export class ExecDriverFactory {
    private readonly log = new Logger(ExecDriverFactory.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly crypto: CryptoService,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly spriteStorage: SpriteStorageService,
        private readonly connections: ConnectionsService,
        @Optional() private readonly config?: ConfigService,
        // Appended LAST and @Optional so positional test construction keeps
        // working; absent, daemon drivers dispatch unfenced as before.
        @Optional()
        private readonly fencedDispatch?: DaemonFencedDispatchService,
        // Same convention; absent, a daemon agent with no minted identity
        // simply gets no MF_API_TOKEN (#781).
        @Optional()
        private readonly runtimeTokens?: RuntimeTokenService,
        @Optional() private readonly runnerManager?: RunnerManagerService
    ) {}

    async forAgent(
        agentId: string,
        preloaded?: Agent,
        turnSource?: AgentModelConfigSource,
        carryingDaemonId?: string
    ): Promise<ExecDriverHandle> {
        const agent =
            preloaded?.id === agentId
                ? preloaded
                : (
                      await this.db
                          .select()
                          .from(agents)
                          .where(eq(agents.id, agentId))
                          .limit(1)
                  )[0]
        if (!agent) throw new Error(`agent ${agentId} not found`)

        if (!agent.runtimeId)
            throw new Error(`agent ${agentId} has no linked runtime`)
        // Per-turn platform/local selection can differ from the saved default.
        // The driver and the injected credentials must use that same selection.
        const selectedAuthContext = authContextRefFor(
            turnSource
                ? { ...agent, extras: { modelConfig: { source: turnSource } } }
                : agent
        )

        if (agent.runtime === 'external')
            throw new Error('external agents have no exec driver')
        const daemonId =
            carryingDaemonId ?? (await this.resolveRunner(agent)).daemonId
        const coding = frameworkCapability(agent.framework).kind === 'coding'
        const [creds, connectionEnv, identityToken] = await Promise.all([
            agent.runtime === 'daemon'
                ? this.tryDecryptCreds(agent.runtimeId)
                : this.decryptCreds(agent.runtimeId),
            coding ? this.connections.resolveAgentEnv(agent) : undefined,
            coding
                ? agent.runtime === 'k8s'
                    ? this.podIdentityToken(agent)
                    : this.lazyIdentityToken(agent, agent.runtime)
                : null
        ])
        const baseEnv = coding
            ? agentBaseEnv(this.config, agent, connectionEnv, identityToken)
            : undefined
        if (selectedAuthContext)
            assertHostHonoursAuthContext(
                selectedAuthContext,
                await this.hostFeatures(daemonId),
                'this runner'
            )
        if (agent.runtime === 'sprites')
            void this.spriteStorage.measureIfDue(agent.id, 'chat')
        return {
            driver: this.daemonDriverFor(
                daemonId,
                baseEnv,
                selectedAuthContext
            ),
            daemonId,
            creds,
            resolvePriceScope: () =>
                this.priceScopeForCredentials(agent, creds),
            supportsExecResources: async () =>
                (await this.hostFeatures(daemonId))?.clientFeatures.includes(
                    DAEMON_FEATURE_EXEC_RESOURCES
                ) ?? false,
            runtime: agent.runtime,
            agent,
            baseEnv,
            authContext: selectedAuthContext
        }
    }

    async resolveRunner(input: Agent | string): Promise<ChatRunner> {
        const agent =
            typeof input === 'string'
                ? (
                      await this.db
                          .select()
                          .from(agents)
                          .where(eq(agents.id, input))
                          .limit(1)
                  )[0]
                : input
        if (!agent) throw new Error('agent not found')
        if (agent.runtime === 'external')
            throw new Error('external agents have no runner')
        let daemonId = agent.daemonId
        let exec: ChatRunner['exec'] = null
        let spritesClient: SpritesClient | undefined
        // Gateway-backed frameworks create/resolve their own workspace on the
        // first turn; admission must not require that lazy path to exist yet.
        const workspacePath = ['openclaw', 'narranexus'].includes(agent.framework)
            ? null
            : agent.workspacePath ?? agent.mountPath
        if (agent.runtime !== 'daemon') {
            if (!this.runnerManager)
                throw new ChatRunnerError(
                    agent.runtime,
                    'runner manager unavailable'
                )
            let resolution: RunnerResolution
            if (agent.runtime === 'sprites') {
                const client = await this.spritesClientForAgent(agent)
                spritesClient = client
                exec = (args) =>
                    execSprite(client, agent.spriteName!, {
                        ...args,
                        stdin: args.stdin ?? ''
                    })
                resolution = await this.runnerManager.ensureRunner({
                    agentId: agent.id,
                    userId: agent.userId,
                    spriteName: agent.spriteName!,
                    workspacePath,
                    firstExecTimeoutMs:
                        spriteExecHealthConfig().firstExecTimeoutMs,
                    exec
                })
            } else {
                if (!agent.runtimeId)
                    throw new ChatRunnerError(agent.runtime, 'runtime missing')
                resolution = await this.runnerManager.resolvePodRunner({
                    userId: agent.userId,
                    runtimeId: agent.runtimeId,
                    workspacePath
                })
            }
            if (!resolution.handle)
                throw new ChatRunnerError(
                    agent.runtime,
                    resolution.fallbackReason ?? 'runner unavailable',
                    resolution.fallbackReason === 'runner_cli_too_old' ||
                        resolution.fallbackReason === 'runner_missing_turn_rpc',
                    resolution.execFailure
                )
            daemonId = resolution.handle.daemonId
        }
        if (!daemonId)
            throw new ChatRunnerError(agent.runtime, 'runner missing')
        const [host] = await this.db
            .select()
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.id, daemonId),
                    eq(runtimeHosts.userId, agent.userId)
                )
            )
            .limit(1)
        if (!host || host.kind !== 'daemon')
            throw new ChatRunnerError(agent.runtime, 'runner missing')
        const required = [
            ...(authContextRefFor(agent) ? [DAEMON_FEATURE_AUTH_CONTEXT] : []),
            ...(agent.framework === 'hermes'
                ? [DAEMON_FEATURE_TURN_HERMES]
                : []),
            ...(agent.framework === 'openclaw'
                ? [DAEMON_FEATURE_TURN_OPENCLAW_ACP]
                : []),
            ...(agent.framework === 'narranexus'
                ? [DAEMON_FEATURE_TURN_OPENCLAW]
                : [])
        ]
        if (
            isCliVersionTooOld(host.cliVersion, DAEMON_MIN_CLI_VERSION) ||
            required.some(
                (feature) => !(host.clientFeatures ?? []).includes(feature)
            )
        )
            throw new ChatRunnerError(
                agent.runtime,
                'runner version or capability',
                true
            )
        if (
            host.status !== 'active' ||
            !host.rpcLastSeenAt ||
            Date.now() - host.rpcLastSeenAt.getTime() >=
                DAEMON_ONLINE_THRESHOLD_MS
        )
            throw new ChatRunnerError(agent.runtime, 'runner offline')
        return { daemonId, exec, spritesClient }
    }

    async spritesClientForAgent(agent: Agent): Promise<SpritesClient> {
        if (
            agent.runtime !== 'sprites' ||
            !agent.accountId ||
            !agent.spriteName ||
            !agent.hostId
        )
            throw new Error('agent has no sprite host')
        await this.runtimeAccess.reserveActiveSlot({
            userId: agent.userId,
            hostId: agent.hostId
        })
        const account = await this.accounts.getById(agent.accountId)
        if (!account) throw new Error('sprite account not found')
        return createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug,
            logger: spritesLoggerFor(this.log, agent.id)
        })
    }

    private async priceScopeForCredentials(agent: Agent, credentials: unknown): Promise<ServedPriceScope> {
        if (!agent.modelProviderId || !['codex', 'gemini-cli'].includes(agent.framework))
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

    // Capability lookup for the auth-context gate: the registration row is
    // the only place a daemon's advertised features live.
    private async hostFeatures(
        daemonId: string
    ): Promise<{ clientFeatures: string[] } | null> {
        const [row] = await this.db
            .select({ clientFeatures: runtimeHosts.clientFeatures })
            .from(runtimeHosts)
            .where(eq(runtimeHosts.id, daemonId))
            .limit(1)
        return row ? { clientFeatures: row.clientFeatures ?? [] } : null
    }

    // Resume uses this directly, with no new credentials or environment.
    daemonDriverFor(
        daemonId: string,
        baseEnv?: Record<string, string>,
        authContext: DaemonAuthContextRef | null = null
    ): ExecDriver {
        return new DaemonExecDriver(
            this.daemonRegistry,
            daemonId,
            baseEnv,
            this.fencedDispatch,
            authContext
        )
    }

    async recoveryFsForAgent(agentId: string): Promise<RecoveryFsHandle> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) throw new Error(`agent ${agentId} not found`)

        if (agent.runtime === 'external') throw new Error('external agents have no recovery filesystem')
        const runner = await this.resolveRunner(agent)
        return {
            daemonId: runner.daemonId,
            fs: new DaemonRecoveryFs(this.daemonRegistry, runner.daemonId),
            runtime: agent.runtime,
            agent,
            ...(runner.exec && this.runnerManager
                ? {
                      awakeHold: this.runnerManager.keepSpriteAwake({
                          exec: runner.exec,
                          turnId: `recovery-${agent.id}-${randomUUID()}`
                      })
                  }
                : {}),
            spritesClient: runner.spritesClient
        }
    }

    async openclawRpcForAgent(
        agentId: string,
        carryingDaemonId?: string
    ): Promise<OpenclawRpcClient | null> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) return null
        if (agent.framework !== 'openclaw') return null
        const daemonId = carryingDaemonId ?? (await this.resolveRunner(agent)).daemonId
        return new OpenclawRpcClient(this.daemonDriverFor(daemonId))
    }

    // The agent's active identity for a runtime kind, minted lazily on the
    // first turn that needs it: agents attached before daemon identity existed
    // have no 'daemon' token row, and a backfill would mint tokens nothing
    // consumes. Two concurrent first turns can both mint (the second revokes
    // the first's token for that one turn); the next turn heals. A daemon can
    // afford that rotation because it holds no baked copy of the token; a pod
    // cannot, which is why the k8s arm uses podIdentityToken instead.
    // The k8s twin of lazyIdentityToken, without the rotation. See
    // RuntimeTokenService.readOrMintRuntimeIdentity for why a pod must never
    // have an active row rotated out from under it.
    private async podIdentityToken(agent: Agent): Promise<string | null> {
        const existing = await decryptActiveIdentityToken(
            this.db,
            this.crypto,
            agent.id,
            'k8s'
        )
        if (existing) return existing
        if (!this.runtimeTokens) return null
        return this.runtimeTokens.readOrMintRuntimeIdentity({
            userId: agent.userId,
            agentId: agent.id,
            runtimeKind: 'k8s'
        })
    }

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

const spritesLoggerFor = (log: Logger, agentId?: string): SpritesLogger => {
    const withAgent = (meta?: Record<string, unknown>): Record<string, unknown> =>
        agentId ? { agentId, ...(meta ?? {}) } : (meta ?? {})
    return {
        debug: () => {},
        info: (m, meta) => log.log(`[sprites] ${m} ${JSON.stringify(withAgent(meta))}`),
        warn: (m, meta) =>
            log.warn(`[sprites] ${m} ${JSON.stringify(withAgent(meta))}`),
        error: (m, meta) =>
            log.error(`[sprites] ${m} ${JSON.stringify(withAgent(meta))}`)
    }
}
