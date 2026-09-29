import { AgentSummary, envTextFromExtras } from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agentCredentials, agents, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { HostServices } from '@/modules/agent-runtimes/provisioning/host-services'
import { serviceFrameworkRecipe } from '@/modules/agents/bootstrap/service-frameworks'

// Restarting a framework's long-lived service to pick up edited environment
// variables or credentials: the recipe rewrites the config and the host's
// daemon restarts the service on the new env, a sandbox's and a cloud
// computer's alike. Coding agents have no service (their env applies
// per-exec), so they 400 here.
@Injectable()
export class AgentServiceRestartService {
    private readonly log = new Logger(AgentServiceRestartService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly agents: AgentsService,
        private readonly crypto: CryptoService,
        private readonly hostServices: HostServices
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
        const { agent, runtime, host } = ctx
        if (!serviceFrameworkRecipe(agent.framework))
            throw new BadRequestException(
                `${agent.framework} agents don't run a restartable service; environment variables apply on the next command`
            )
        if (!host || (ctx.placement !== 'sprites' && ctx.placement !== 'k8s'))
            throw new BadRequestException(
                'service restart is only supported on sandboxes and cloud computers'
            )
        this.log.log(
            `restarting ${agent.framework} service on host ${host.id} for agent ${agent.id}`
        )
        await this.hostServices.reconfigure(runtime, host, {
            credentials: await this.decryptCreds(runtime.id),
            envText: envTextFromExtras(agent.extras) ?? null,
            controlUiEnabled: runtime.controlUiEnabled,
            dashboardEnabled: runtime.dashboardEnabled
        })
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
}
