import type { AgentContextDocStatus } from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { createClient, type SpritesClient } from '@manyfold/sprites'
import { agents, type Agent, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { runDaemonBash } from '@/modules/daemon/daemon-fs'
import {
    AgentContextDocService,
    MANYFOLD_CONTEXT_VERSION,
    contextDocInstructionFile,
    spriteContextDocRunner
} from '@/modules/agent-self/agent-context-doc.service'

// What AgentContextDocService.write recorded into agents.extras on its last
// successful install — the DB is the source of truth for the status card so it
// works without waking a cold sprite.
const readRecord = (
    agent: Agent
): { version: number | null; generatedAt: string | null } => {
    const cd = (
        agent.extras as {
            contextDoc?: { version?: number; generatedAt?: string }
        } | null
    )?.contextDoc
    return {
        version: typeof cd?.version === 'number' ? cd.version : null,
        generatedAt: typeof cd?.generatedAt === 'string' ? cd.generatedAt : null
    }
}

// Read/install/refresh an agent's AGENTS.manyfold.md. Status is DB-backed
// (cold-safe); install/on-change writes to the live sprite.
@Injectable()
export class AgentContextDocManageService {
    private readonly log = new Logger(AgentContextDocManageService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly accounts: SpritesAccountsService,
        private readonly contextDoc: AgentContextDocService,
        private readonly daemonRegistry: DaemonRegistryService
    ) {}

    async getStatus(
        userId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentContextDocStatus> {
        const agent = await this.requireAgent(userId, agentId, isAdmin)
        if (!this.isSupported(agent))
            return {
                supported: false,
                installed: false,
                version: null,
                generatedAt: null,
                currentVersion: MANYFOLD_CONTEXT_VERSION,
                upToDate: false,
                agentRunning: false
            }
        const { version, generatedAt } = readRecord(agent)
        const installed = version !== null
        return {
            supported: true,
            installed,
            version,
            generatedAt,
            currentVersion: MANYFOLD_CONTEXT_VERSION,
            upToDate: installed && version === MANYFOLD_CONTEXT_VERSION,
            agentRunning: agent.status === 'running'
        }
    }

    async refresh(
        userId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentContextDocStatus> {
        const agent = await this.requireAgent(userId, agentId, isAdmin)
        if (!this.isSupported(agent))
            throw new BadRequestException(
                'the context doc is only available for coding-framework agents on sandbox or self-owned computer runtimes'
            )
        // Writing needs a live workspace. A running sprite agent whose VM has
        // idled to warm/cold is fine — exec resumes it; a daemon agent's
        // `running` status is presence-derived, so it means the computer is
        // reachable (#781).
        if (agent.status !== 'running')
            throw new BadRequestException(
                'start the agent before installing its context doc'
            )
        await this.writeDoc(agent)
        return this.getStatus(userId, agentId, isAdmin)
    }

    // Best-effort push after a connection change (the caller already authorized
    // the agent). Only writes for a running agent; never throws.
    async refreshOnChange(agent: Agent): Promise<void> {
        if (!this.isSupported(agent) || agent.status !== 'running') return
        try {
            await this.writeDoc(agent)
        } catch (err) {
            this.log.warn(
                `context doc on-change refresh failed for ${agent.id}: ${(err as Error).message}`
            )
        }
    }

    private isSupported(agent: Agent): boolean {
        return (
            (agent.runtime === 'sprites' || agent.runtime === 'daemon') &&
            contextDocInstructionFile(agent.framework) !== undefined
        )
    }

    private async writeDoc(agent: Agent): Promise<void> {
        if (agent.runtime === 'daemon') {
            const workspacePath = agent.workspacePath ?? agent.mountPath
            if (!agent.daemonId || !workspacePath) return
            const daemonId = agent.daemonId
            await this.contextDoc.write({
                agentId: agent.id,
                framework: agent.framework,
                workspacePath,
                run: (script, timeoutMs) =>
                    runDaemonBash(
                        this.daemonRegistry,
                        daemonId,
                        script,
                        timeoutMs
                    ),
                targetLabel: daemonId
            })
            return
        }
        if (!agent.spriteName || !agent.mountPath) return
        await this.contextDoc.write({
            agentId: agent.id,
            framework: agent.framework,
            workspacePath: agent.mountPath,
            run: spriteContextDocRunner(
                await this.spriteClientFor(agent),
                agent.spriteName
            ),
            targetLabel: agent.spriteName
        })
    }

    private async requireAgent(
        userId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<Agent> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent || (agent.userId !== userId && !isAdmin))
            throw new NotFoundException(`agent ${agentId} not found`)
        return agent
    }

    private async spriteClientFor(agent: Agent): Promise<SpritesClient> {
        if (!agent.accountId)
            throw new BadRequestException('agent has no sprites account')
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new NotFoundException('sprites account not found for agent')
        return createClient({
            token: this.accounts.decryptToken(account),
            accountSlug: account.slug
        })
    }
}
