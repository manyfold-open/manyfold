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
    agents,
    type Agent,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import type { SpritesLogger } from '@manyfold/sprites'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import type { BootstrapContext } from '@/modules/agents/bootstrap/framework-bootstrap'
import { SpriteServiceBootstraps } from '@/modules/agents/bootstrap/sprite-service-bootstraps'
import { PodHostServices } from '@/modules/agent-runtimes/provisioning/pod-host-services'
import { podServiceRecipe } from '@/modules/agent-runtimes/provisioning/pod-service-frameworks'
import { podScriptRunner } from '@/modules/agent-runtimes/provisioning/pod-framework-setup'
import type { RuntimeContext } from '@/modules/hosts/runtime-context.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'

const POD_SERVICE_READY_TIMEOUT_MS = 180_000

type HostedAgent = RuntimeContext & { agent: Agent; host: RuntimeHostRow }

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
        private readonly agents: AgentsService,
        private readonly crypto: CryptoService,
        private readonly serviceBootstraps: SpriteServiceBootstraps,
        private readonly hostClients: HostProviderClients,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, pod hosts are refused.
        @Optional() private readonly podServices?: PodHostServices
    ) {}

    async restart(
        agentId: string,
        callerUserId: string,
        isAdmin: boolean
    ): Promise<AgentSummary> {
        const ctx = await this.agents.contextForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!ctx) throw new NotFoundException(`agent ${agentId} not found`)
        const { agent } = ctx
        const bootstrap = this.serviceBootstraps.get(agent.framework)
        if (!bootstrap)
            throw new BadRequestException(
                `${agent.framework} agents don't run a restartable service; environment variables apply on the next command`
            )
        if (!ctx.host)
            throw new BadRequestException(
                'service restart is only supported on sandboxes and cloud computers'
            )
        const hosted = ctx as HostedAgent
        if (ctx.placement === 'k8s') {
            await this.restartOnPod(hosted)
            return this.recordStart(agentId, callerUserId, isAdmin)
        }
        if (ctx.placement !== 'sprites')
            throw new BadRequestException(
                'service restart is only supported on sandboxes and cloud computers'
            )

        const creds = await this.decryptCreds(agent.runtimeId)
        const { client, spriteName } =
            await this.hostClients.spritesClientForHost(hosted.host)
        const bootstrapCtx: BootstrapContext = {
            agentId: agent.id,
            runtimeId: agent.runtimeId,
            userId: agent.userId,
            spriteName,
            mountPath: agent.mountPath,
            client,
            logger: this.spritesLogger(),
            envText: envTextFromExtras(agent.extras) ?? null,
            controlUiEnabled: ctx.runtime.controlUiEnabled,
            dashboardEnabled: ctx.runtime.dashboardEnabled
        }
        this.log.log(
            `restarting ${agent.framework} service for agent ${agent.id} to apply env`
        )
        await bootstrap.restart(bootstrapCtx, creds)
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

    private async restartOnPod(ctx: HostedAgent): Promise<void> {
        const { agent, runtime, host } = ctx
        const recipe = podServiceRecipe(agent.framework)
        if (!recipe || !this.podServices)
            throw new BadRequestException(
                `${agent.framework} has no service to restart on a cloud computer`
            )
        const creds = await this.decryptCreds(runtime.id)
        const exec = await this.hostClients.podExecForHost(host)
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
        this.log.log(
            `restarting ${agent.framework} service on pod host ${host.id} for agent ${agent.id}`
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
