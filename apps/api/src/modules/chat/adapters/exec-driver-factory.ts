import {
    MF_ENV_AGENT_ID,
    MF_ENV_API_TOKEN,
    MF_ENV_API_URL,
    MF_ENV_DEPLOY_ENV,
    agentWsUrl,
    envTextFromExtras,
    envTextToRecord,
    frameworkCapability
} from '@manyfold/shared'
import type { OpenclawCredentialsInput } from '@manyfold/shared'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import type { V1Pod } from '@kubernetes/client-node'
import {
    agentRuntimes,
    agents,
    agentCredentials,
    type Agent,
    type Database
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    type SpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    RuntimeTokenService,
    decryptActiveIdentityToken
} from '@/modules/auth/runtime-token.service'
import {
    KubernetesService,
    type K8sClient
} from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { AGENT_CONTAINER_NAME } from '@/modules/agents/orchestration/k8s-resource-builder'
import type { ExecDriver } from './exec-driver'
import { SpritesExecDriver } from './sprites-exec-driver'
import { K8sExecDriver } from './k8s-exec-driver'
import { DaemonExecDriver } from './daemon-exec-driver'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from './daemon-fenced-dispatch.service'
import {
    DaemonRecoveryFs,
    K8sRecoveryFs,
    SpriteRecoveryFs,
    type RecoveryFs
} from '@/modules/chat/recovery/recovery-fs'
import { OpenclawRpcClient } from './openclaw-rpc-client'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import { SpriteStorageService } from '@/modules/agents/sprite-storage/sprite-storage.service'
import { SpritesSessionRegistry } from '@/modules/agents/sprite-sessions/sprite-sessions.registry'
import { publicApiUrlWithApiPrefix } from '@/common/public-api-url'
import { resolveMfDeployEnv } from '@/common/deploy-env'
import { ConnectionsService } from '@/modules/connections/connections.service'

export interface ExecDriverHandle {
    driver: ExecDriver
    creds: unknown
    runtime: 'sprites' | 'k8s' | 'daemon'
    agent: Agent
    // Per-agent runtime identity + connection env (sprites), or connection +
    // extras env (coding daemons, #781). Already baked into `driver`; exposed
    // so a runner turn that swaps the transport via daemonDriverFor() can
    // carry the same identity (#581).
    baseEnv?: Record<string, string>
}

export interface RecoveryFsHandle {
    fs: RecoveryFs
    runtime: 'sprites' | 'k8s' | 'daemon'
    agent: Agent
    // sprites only: the same client backing `fs`, exposed so turn adoption can
    // check exec-session liveness (listExecSessions) as a stall signal.
    spritesClient?: SpritesClient
}

@Injectable()
export class ExecDriverFactory {
    private readonly log = new Logger(ExecDriverFactory.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly crypto: CryptoService,
        private readonly k8s: KubernetesService,
        private readonly podExecFactory: PodExecFactory,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly runtimeAccess: RuntimeAccessService,
        private readonly spriteStorage: SpriteStorageService,
        private readonly sessionRegistry: SpritesSessionRegistry,
        private readonly connections: ConnectionsService,
        @Optional() private readonly config?: ConfigService,
        // Appended LAST and @Optional so positional test construction keeps
        // working; absent, daemon drivers dispatch unfenced as before.
        @Optional()
        private readonly fencedDispatch?: DaemonFencedDispatchService,
        // Same convention; absent, a daemon agent with no minted identity
        // simply gets no MF_API_TOKEN (#781).
        @Optional()
        private readonly runtimeTokens?: RuntimeTokenService
    ) {}

    async forAgent(
        agentId: string,
        preloaded?: Agent
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

        if (agent.runtime === 'daemon') {
            if (!agent.daemonId)
                throw new Error(`daemon agent ${agentId} missing daemonId`)
            // A coding daemon turn spawns per exec, so the same identity +
            // connection + extras base env the sprites branch assembles rides
            // each dispatch (#781). Service frameworks stay bare: openclaw's
            // turn payload has no env channel (#783), and hermes carries the
            // extras inside its own turn payload.
            const coding =
                frameworkCapability(agent.framework).kind === 'coding'
            const [creds, connectionEnv, identityToken] = await Promise.all([
                this.tryDecryptCreds(agent.runtimeId),
                coding ? this.connections.resolveAgentEnv(agent) : undefined,
                coding ? this.daemonIdentityToken(agent) : null
            ])
            const baseEnv = coding
                ? agentBaseEnv(this.config, agent, connectionEnv, identityToken)
                : undefined
            return {
                driver: new DaemonExecDriver(
                    this.daemonRegistry,
                    agent.daemonId,
                    baseEnv,
                    this.fencedDispatch
                ),
                creds,
                runtime: 'daemon',
                agent,
                ...(baseEnv ? { baseEnv } : {})
            }
        }

        if (agent.runtime === 'k8s') {
            const creds = await this.decryptCreds(agent.runtimeId)
            if (!agent.namespace)
                throw new Error(`k8s agent ${agentId} missing namespace`)
            const podLookupId = await this.k8sPodLookupId(agent)
            const client = await this.k8s.getClient(agent.clusterId)
            const pod = await this.pickRunningPod(
                client,
                agent.namespace,
                podLookupId
            )
            if (!pod?.metadata?.name)
                throw new Error(
                    `no running pod for agent ${agentId} (looked up via ${podLookupId}) in ${agent.namespace}`
                )
            const podExec = this.podExecFactory.forClient(
                client,
                agent.namespace,
                pod.metadata.name,
                AGENT_CONTAINER_NAME
            )
            return {
                driver: new K8sExecDriver(podExec),
                creds,
                runtime: 'k8s',
                agent
            }
        }

        if (!agent.accountId)
            throw new Error(`sprites agent ${agentId} missing accountId`)
        if (!agent.spriteName)
            throw new Error(`sprites agent ${agentId} missing spriteName`)
        if (!agent.hostId)
            throw new Error(`sprites agent ${agentId} missing hostId`)
        // Independent reads/decrypts batched to keep them off the turn's
        // critical path; if reserveActiveSlot rejects, the sibling reads are
        // side-effect-free, and if a read rejects after the slot opened, the
        // status sync reconciles the host like any exec that failed to start.
        const [creds, , account, identityToken, connectionEnv] =
            await Promise.all([
                this.decryptCreds(agent.runtimeId),
                this.runtimeAccess.reserveActiveSlot({
                    userId: agent.userId,
                    hostId: agent.hostId
                }),
                this.accounts.getById(agent.accountId),
                // Per-agent identity injected at exec time (the sprite's shared
                // profile no longer carries a token, so co-resident agents stay
                // distinct).
                decryptActiveIdentityToken(
                    this.db,
                    this.crypto,
                    agent.id,
                    'sprites'
                ),
                this.connections.resolveAgentEnv(agent)
            ])
        if (!account)
            throw new Error(
                `sprites account ${agent.accountId} not found for agent ${agentId}`
            )
        const token = this.accounts.decryptToken(account)
        const logger = spritesLoggerFor(this.log, agent.id)
        const client = createSpritesClient({
            token,
            accountSlug: account.slug,
            logger
        })
        void this.spriteStorage.measureIfDue(agent.id)
        const baseEnv = agentBaseEnv(
            this.config,
            agent,
            connectionEnv,
            identityToken
        )
        return {
            driver: new SpritesExecDriver(client, agent.spriteName, logger, {
                sessionRegistry: this.sessionRegistry,
                agentId: agent.id,
                env: baseEnv
            }),
            creds,
            runtime: 'sprites',
            agent,
            baseEnv
        }
    }

    // Dispatch a sprite turn through that sprite's own runner instead of a
    // bare sprite exec. Same transport the daemon runtime uses, so
    // the turn gets a sequenced, resumable stream; the sprite handle (fs,
    // spritesClient) stays available to the caller for transcript fallback.
    // baseEnv: the ExecDriverHandle's per-agent identity env — without it the
    // runner child falls back to the shared spriterunner profile (#581).
    daemonDriverFor(
        daemonId: string,
        baseEnv?: Record<string, string>
    ): ExecDriver {
        return new DaemonExecDriver(
            this.daemonRegistry,
            daemonId,
            baseEnv,
            this.fencedDispatch
        )
    }

    async recoveryFsForAgent(agentId: string): Promise<RecoveryFsHandle> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) throw new Error(`agent ${agentId} not found`)

        if (agent.runtime === 'daemon') {
            if (!agent.daemonId)
                throw new Error(`daemon agent ${agentId} missing daemonId`)
            return {
                fs: new DaemonRecoveryFs(this.daemonRegistry, agent.daemonId),
                runtime: 'daemon',
                agent
            }
        }

        if (agent.runtime === 'sprites') {
            if (!agent.accountId)
                throw new Error(`sprites agent ${agentId} missing accountId`)
            if (!agent.spriteName)
                throw new Error(`sprites agent ${agentId} missing spriteName`)
            if (!agent.hostId)
                throw new Error(`sprites agent ${agentId} missing hostId`)
            const [, account] = await Promise.all([
                this.runtimeAccess.reserveActiveSlot({
                    userId: agent.userId,
                    hostId: agent.hostId
                }),
                this.accounts.getById(agent.accountId)
            ])
            if (!account)
                throw new Error(
                    `sprites account ${agent.accountId} not found for agent ${agentId}`
                )
            const token = this.accounts.decryptToken(account)
            const logger = spritesLoggerFor(this.log, agent.id)
            const client = createSpritesClient({
                token,
                accountSlug: account.slug,
                logger
            })
            return {
                fs: new SpriteRecoveryFs(client, agent.spriteName, logger),
                runtime: 'sprites',
                agent,
                spritesClient: client
            }
        }

        if (agent.runtime === 'k8s') {
            if (!agent.namespace)
                throw new Error(`k8s agent ${agentId} missing namespace`)
            const podLookupId = await this.k8sPodLookupId(agent)
            const client = await this.k8s.getClient(agent.clusterId)
            const pod = await this.pickRunningPod(
                client,
                agent.namespace,
                podLookupId
            )
            if (!pod?.metadata?.name)
                throw new Error(
                    `no running pod for agent ${agentId} (looked up via ${podLookupId}) in ${agent.namespace}`
                )
            const podExec = this.podExecFactory.forClient(
                client,
                agent.namespace,
                pod.metadata.name,
                AGENT_CONTAINER_NAME
            )
            return {
                fs: new K8sRecoveryFs(podExec),
                runtime: 'k8s',
                agent
            }
        }

        throw new Error(`unsupported runtime for agent ${agentId}`)
    }

    async openclawRpcForAgent(
        agentId: string
    ): Promise<OpenclawRpcClient | null> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent) return null
        if (agent.framework !== 'openclaw') return null
        if (!agent.ingressHost) return null
        if (!agent.runtimeId) return null
        const creds = (await this.decryptCreds(
            agent.runtimeId
        )) as OpenclawCredentialsInput
        if (!creds.gatewayToken) return null
        const url = agentWsUrl(agent.ingressHost)
        const client = new OpenclawRpcClient({
            url,
            token: creds.gatewayToken,
            logger: this.log
        })
        try {
            await client.connect()
        } catch (err) {
            this.log.warn(
                `openclawRpcForAgent connect failed for ${agentId}: ${(err as Error).message}`
            )
            client.disconnect()
            return null
        }
        return client
    }

    // The agent's active daemon identity, minted lazily on the first turn that
    // needs it: agents attached before daemon identity existed have no
    // 'daemon' token row, and a backfill would mint tokens nothing consumes.
    // Two concurrent first turns can both mint (the second revokes the first's
    // token for that one turn); the next turn heals.
    private async daemonIdentityToken(agent: Agent): Promise<string | null> {
        const existing = await decryptActiveIdentityToken(
            this.db,
            this.crypto,
            agent.id,
            'daemon'
        )
        if (existing) return existing
        if (!this.runtimeTokens) return null
        const minted = await this.runtimeTokens.mintRuntimeIdentity({
            userId: agent.userId,
            agentId: agent.id,
            runtimeKind: 'daemon'
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

    private async pickRunningPod(
        client: K8sClient,
        namespace: string,
        agentId: string
    ): Promise<V1Pod | undefined> {
        const { core } = client.apis
        const res = await core.listNamespacedPod({
            namespace,
            labelSelector: `nca.netmind.ai/agent-id=${agentId}`
        })
        const pods = res.items ?? []
        return pods.find((p) => p.status?.phase === 'Running')
    }

    private async k8sPodLookupId(agent: Agent): Promise<string> {
        if (!agent.runtimeId) return agent.id
        const [runtime] = await this.db
            .select({ primaryAgentId: agentRuntimes.primaryAgentId })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, agent.runtimeId))
            .limit(1)
        return runtime?.primaryAgentId ?? agent.id
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
