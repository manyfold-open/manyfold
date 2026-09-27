import type { AgentFramework } from '@manyfold/shared'
import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { DaemonAgentAttacher } from './daemon-agent-attacher'
import { workspaceExtras } from '@/modules/agents/workspace/workspace-preflight'
import {
    NotSupportedError,
    type AddAgentContext,
    type AddAgentResult,
    type AgentAdapter,
    type AgentAdapterContext,
    type AgentAdapterCreateResult,
    type AgentAdapterListContext,
    type FrameworkAgent,
    type RemoveAgentContext
} from './agent-adapter'

@Injectable()
export class GeminiCliAgentAdapter implements AgentAdapter {
    readonly framework: AgentFramework = 'gemini-cli'

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly attacher: DaemonAgentAttacher
    ) {}

    async createAgent(
        ctx: AgentAdapterContext
    ): Promise<AgentAdapterCreateResult> {
        return {
            workspacePath: `${ctx.runtime.mountPath}/${ctx.agentId}`
        }
    }

    async deleteAgent(): Promise<void> {}

    async listAgents(ctx: AgentAdapterListContext): Promise<FrameworkAgent[]> {
        const rows = await this.db
            .select()
            .from(agents)
            .where(eq(agents.runtimeId, ctx.runtime.id))
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            workspace: row.workspacePath,
            model: row.model,
            extras: {}
        }))
    }

    async addAgent(ctx: AddAgentContext): Promise<AddAgentResult> {
        if (!ctx.host) throw new NotSupportedError(this.framework, 'addAgent')
        const { workspacePath, internalId } = await this.attacher.attach({
            target: ctx,
            agentId: ctx.agentId,
            workspace: ctx.workspace
        })
        return {
            internalId,
            workspace: workspacePath,
            model: ctx.model ?? null,
            extras: workspaceExtras(!ctx.workspace)
        }
    }

    async removeAgent(ctx: RemoveAgentContext): Promise<void> {
        if (!ctx.host)
            throw new NotSupportedError(this.framework, 'removeAgent')
        await this.attacher.detach({ target: ctx, agent: ctx.agent })
    }
}
