import {
    AgentSummary,
    isVersionedFramework,
    parseProbedSemver
} from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    type Agent,
    type AgentRuntimeRow,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentsService } from '@/modules/agents/agents.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { frameworkVersionDescriptor } from '@/modules/framework-versions/framework-version-registry'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { hostsFrameworkCli, runOnRuntimeHost } from './runtime-host-shell'

const PROBE_TIMEOUT_MS = 30_000

@Injectable()
export class FrameworkVersionProbeService {
    private readonly log = new Logger(FrameworkVersionProbeService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly agents: AgentsService,
        // Appended last + @Optional so positional test construction keeps
        // working; absent, only sprites are probed.
        @Optional() private readonly k8s?: KubernetesService,
        @Optional() private readonly podExec?: PodExecFactory
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

    // Sprites and pod hosts. No-op for non-versioned frameworks or other
    // runtimes. A probe that cannot run leaves the stored version untouched
    // (never clobbers a known-good value with null).
    async probeAndPersist(agent: Agent): Promise<string | null> {
        if (!isVersionedFramework(agent.framework) || !agent.runtimeId)
            return null
        const runtime = await this.loadRuntime(agent.runtimeId)
        if (!runtime || !hostsFrameworkCli(runtime)) return null
        if (runtime.kind === 'sprites' && !(agent.spriteName ?? runtime.spriteName))
            return null

        const descriptor = frameworkVersionDescriptor(agent.framework)
        let parsed: string | null = null
        try {
            const result = await runOnRuntimeHost(
                { accounts: this.accounts, k8s: this.k8s, podExec: this.podExec },
                agent,
                runtime,
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
            .where(eq(agentRuntimes.id, runtime.id))
        return parsed
    }

    private async loadRuntime(
        runtimeId: string
    ): Promise<AgentRuntimeRow | null> {
        const [row] = await this.db
            .select()
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, runtimeId))
            .limit(1)
        return row ?? null
    }
}
