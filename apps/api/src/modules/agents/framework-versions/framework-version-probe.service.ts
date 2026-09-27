import {
    AgentSummary,
    isVersionedFramework,
    parseProbedSemver
} from '@manyfold/shared'
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agentRuntimes, type Agent, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import { FrameworkExecResolver } from '@/modules/agents/adapters/framework-exec'
import { frameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'
import { RuntimeContextService } from '@/modules/hosts/runtime-context.service'
import { hostsFrameworkCli, runOnRuntimeHost } from './runtime-host-shell'

const PROBE_TIMEOUT_MS = 30_000

@Injectable()
export class FrameworkVersionProbeService {
    private readonly log = new Logger(FrameworkVersionProbeService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly agents: AgentsService,
        private readonly runtimeContext: RuntimeContextService,
        private readonly execResolver: FrameworkExecResolver
    ) {}

    // Probe + persist the installed framework version for an agent, then return
    // the refreshed summary. Ownership is enforced via AgentsService.
    async refresh(
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
        await this.probeAndPersist(agent)
        return this.agents.get(agentId, callerUserId, isAdmin)
    }

    // Hosted machines only, through their daemon (ADR-0037). No-op for
    // non-versioned frameworks or other placements. A probe that cannot run
    // leaves the stored version untouched (never clobbers a known-good value
    // with null).
    async probeAndPersist(agent: Agent): Promise<string | null> {
        if (!isVersionedFramework(agent.framework)) return null
        const ctx = await this.runtimeContext.forRuntime(agent.runtimeId)
        if (!ctx || !hostsFrameworkCli(ctx.placement)) return null

        const descriptor = frameworkVersionDescriptor(agent.framework)
        let parsed: string | null = null
        try {
            const exec = await this.execResolver.forRuntime(ctx.runtime, this.log)
            const result = await runOnRuntimeHost(
                exec,
                descriptor.probeShell,
                PROBE_TIMEOUT_MS
            )
            parsed = parseProbedSemver(`${result.stdout}\n${result.stderr}`)
        } catch (err) {
            this.log.warn(
                `framework-version probe failed for agent ${agent.id}: ${(err as Error).message}`
            )
            return null
        }

        const now = new Date()
        await this.db
            .update(agentRuntimes)
            .set({
                ...(parsed ? { frameworkVersion: parsed } : {}),
                frameworkVersionCheckedAt: now,
                updatedAt: now
            })
            .where(eq(agentRuntimes.id, ctx.runtime.id))
        return parsed
    }
}
