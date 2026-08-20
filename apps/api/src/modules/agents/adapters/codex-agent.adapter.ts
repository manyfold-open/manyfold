import type { AgentFramework } from '@manyfold/shared'
import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { SpritesAgentAttacher } from './sprites-agent-attacher'
import { K8sAgentAttacher } from './k8s-agent-attacher'
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
export class CodexAgentAdapter implements AgentAdapter {
    readonly framework: AgentFramework = 'codex'

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly attacher: SpritesAgentAttacher,
        private readonly k8sAttacher: K8sAgentAttacher,
        private readonly daemonAttacher: DaemonAgentAttacher
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
            extras: { spriteId: ctx.runtime.spriteId }
        }))
    }

    async addAgent(ctx: AddAgentContext): Promise<AddAgentResult> {
        if (ctx.runtime.kind === 'sprites') {
            const { workspacePath, internalId } = await this.attacher.attach({
                runtime: ctx.runtime,
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
        if (ctx.runtime.kind === 'k8s') {
            const { workspacePath, internalId } = await this.k8sAttacher.attach(
                {
                    runtime: ctx.runtime,
                    agentId: ctx.agentId,
                    primaryAgentId: ctx.primaryAgentId,
                    workspace: ctx.workspace
                }
            )
            return {
                internalId,
                workspace: workspacePath,
                model: ctx.model ?? null,
                extras: workspaceExtras(!ctx.workspace)
            }
        }
        if (ctx.runtime.kind === 'daemon') {
            const { workspacePath, internalId } =
                await this.daemonAttacher.attach({
                    runtime: ctx.runtime,
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
        throw new NotSupportedError(this.framework, 'addAgent')
    }

    async removeAgent(ctx: RemoveAgentContext): Promise<void> {
        if (ctx.runtime.kind === 'sprites') {
            await this.attacher.detach({
                runtime: ctx.runtime,
                agent: ctx.agent
            })
            return
        }
        if (ctx.runtime.kind === 'k8s') {
            await this.k8sAttacher.detach({
                runtime: ctx.runtime,
                agent: ctx.agent,
                primaryAgentId: ctx.primaryAgentId
            })
            return
        }
        if (ctx.runtime.kind === 'daemon') {
            await this.daemonAttacher.detach({
                runtime: ctx.runtime,
                agent: ctx.agent
            })
            return
        }
        throw new NotSupportedError(this.framework, 'removeAgent')
    }
}
