import type { AgentFramework } from '@manyfold/shared'
import type { Agent, AgentRuntimeRow } from '@manyfold/db'

export interface AgentAdapterContext {
    runtime: AgentRuntimeRow
    agentId: string
    name: string
}

export interface AgentAdapterCreateResult {
    workspacePath: string
}

export interface AgentAdapterListContext {
    runtime: AgentRuntimeRow
    primaryAgentId: string | null
}

export interface FrameworkAgent {
    id: string
    name: string
    workspace: string | null
    model: string | null
    extras: Record<string, unknown>
}

export interface AddAgentContext {
    runtime: AgentRuntimeRow
    primaryAgentId: string | null
    agentId: string
    internalId: string
    name: string
    workspace?: string
    model?: string
    cloneFrom?: string
}

export interface AddAgentResult {
    internalId: string
    workspace: string | null
    model: string | null
    extras: Record<string, unknown>
}

export interface RemoveAgentContext {
    runtime: AgentRuntimeRow
    agent: Agent
    primaryAgentId: string | null
}

export interface UpdateAgentContext {
    runtime: AgentRuntimeRow
    agent: Agent
    patch: { name?: string; description?: string }
}

export class NotSupportedError extends Error {
    constructor(
        public readonly framework: AgentFramework,
        action: string
    ) {
        super(`${action} not supported for framework ${framework}`)
        this.name = 'NotSupportedError'
    }
}

export interface AgentAdapter {
    readonly framework: AgentFramework
    createAgent(ctx: AgentAdapterContext): Promise<AgentAdapterCreateResult>
    deleteAgent(ctx: { runtime: AgentRuntimeRow; agent: Agent }): Promise<void>
    /**
     * Implementations must THROW when enumeration is impossible (unreachable
     * runtime, missing credentials, malformed output). An empty array means
     * the runtime confirmed zero agents — reconcile will stop-mark rows
     * missing from the result.
     */
    listAgents(ctx: AgentAdapterListContext): Promise<FrameworkAgent[]>
    addAgent(ctx: AddAgentContext): Promise<AddAgentResult>
    removeAgent(ctx: RemoveAgentContext): Promise<void>
    updateAgent?(ctx: UpdateAgentContext): Promise<void>
}
