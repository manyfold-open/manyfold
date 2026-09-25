import { AgentSummary, envTextFromExtras } from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    type Database
} from '@manyfold/db'
import {
    createClient as createSpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import type { BootstrapContext } from '@/modules/agents/bootstrap/framework-bootstrap'
import { SpriteServiceBootstraps } from '@/modules/agents/bootstrap/sprite-service-bootstraps'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { resolveAgentPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import { PodHostServices } from '@/modules/agent-runtimes/provisioning/pod-host-services'
import { podServiceRecipe } from '@/modules/agent-runtimes/provisioning/pod-service-frameworks'
import { podScriptRunner } from '@/modules/agent-runtimes/provisioning/pod-framework-setup'

const POD_SERVICE_READY_TIMEOUT_MS = 180_000

// Restarting a framework's long-lived service to pick up edited environment
// variables or credentials. Sprite env only propagates via delete→upsert→start
// (SpritesClient.upsertService caveat), so each bootstrap's `restart` re-runs
// that dance with the freshly merged env — no reinstall. On a pod host the
// recipe rewrites the config and the host's daemon restarts the service
// (ADR-0035). Coding agents have no service (their env applies per-exec), so
// they 400 here.
@Injectable()
export class AgentServiceRestartService {
    private readonly log = new Logger(AgentServiceRestartService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly agents: AgentsService,
        private readonly crypto: CryptoService,
        private readonly serviceBootstraps: SpriteServiceBootstraps,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, pod hosts are refused.
        @Optional() private readonly k8s?: KubernetesService,
        @Optional() private readonly podExec?: PodExecFactory,
        @Optional() private readonly podServices?: PodHostServices
    ) {}

    async restart(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const agent = await this.agents.findForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        const bootstrap = this.serviceBootstraps.get(agent.framework)
        if (!bootstrap)
            throw new BadRequestException(
                `${agent.framework} agents don't run a restartable service; environment variables apply on the next command`
            )
        if (agent.runtime === 'k8s') {
            await this.restartOnPod(agent)
            return this.recordStart(agentId, callerUserId, isAdmin)
        }
        if (agent.runtime !== 'sprites')
            throw new BadRequestException(
                'service restart is only supported on sandboxes and cloud computers'
            )
        if (!agent.runtimeId)
            throw new BadRequestException('agent has no runtime')
        if (!agent.accountId || !agent.spriteName)
            throw new BadRequestException('agent has no sprite')

        const creds = await this.decryptCreds(agent.runtimeId)
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new Error(`sprites account ${agent.accountId} not found`)
        const client = createSpritesClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
        const [runtimeRow] = await this.db
            .select({
                controlUiEnabled: agentRuntimes.controlUiEnabled,
                dashboardEnabled: agentRuntimes.dashboardEnabled
            })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, agent.runtimeId))
            .limit(1)
        const ctx: BootstrapContext = {
            agentId: agent.id,
            runtimeId: agent.runtimeId,
            userId: agent.userId,
            spriteName: agent.spriteName,
            mountPath: agent.mountPath,
            client,
            logger: this.spritesLogger(),
            envText: envTextFromExtras(agent.extras) ?? null,
            controlUiEnabled: runtimeRow?.controlUiEnabled,
            dashboardEnabled: runtimeRow?.dashboardEnabled
        }
        this.log.log(
            `restarting ${agent.framework} service for agent ${agent.id} to apply env`
        )
        await bootstrap.restart(ctx, creds)
        return this.recordStart(agentId, callerUserId, isAdmin)
    }

    // The process that carried the old env is gone, so record when this one
    // came up: it is how anything holding "saved but not yet applied" state
    // (the web's environment pending-restart mark) learns the values are
    // live, no matter which surface triggered the restart.
    private async recordStart(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const startedAt = new Date()
        await this.db
            .update(agents)
            .set({ startedAt, updatedAt: startedAt })
            .where(eq(agents.id, agentId))
        return this.agents.get(agentId, callerUserId, isAdmin)
    }

    private async restartOnPod(
        agent: NonNullable<Awaited<ReturnType<AgentsService['findForCaller']>>>
    ): Promise<void> {
        const recipe = podServiceRecipe(agent.framework)
        if (!recipe || !this.k8s || !this.podExec || !this.podServices)
            throw new BadRequestException(
                `${agent.framework} has no service to restart on a cloud computer`
            )
        const [runtime] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, agent.runtimeId))
            .limit(1)
        if (!runtime?.hostId)
            throw new BadRequestException('agent is not on a cloud computer')
        const creds = await this.decryptCreds(runtime.id)
        const pod = await resolveAgentPod(this.k8s, runtime)
        const exec = this.podExec.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const setup = await recipe.configure(
            podScriptRunner(exec, (event, fields) =>
                this.log.warn(`${event} ${JSON.stringify(fields)}`)
            ),
            {
                credentials: creds,
                envText: envTextFromExtras(agent.extras) ?? null,
                controlUiEnabled: runtime.controlUiEnabled
            }
        )
        const host = { id: runtime.hostId, userId: runtime.userId }
        this.log.log(
            `restarting ${agent.framework} service on pod host ${runtime.hostId} for agent ${agent.id}`
        )
        await this.podServices.upsert(host, setup.spec)
        await this.podServices.restart(host, setup.spec.name)
        await this.podServices.waitHealthy(
            host,
            setup.spec.name,
            POD_SERVICE_READY_TIMEOUT_MS
        )
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

    private spritesLogger(): SpritesLogger {
        return {
            debug: () => {},
            info: (m, meta) =>
                this.log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            warn: (m, meta) =>
                this.log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
            error: (m, meta) =>
                this.log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
        }
    }
}