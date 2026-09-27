import type { AgentFramework, AgentRuntime, RuntimeProviderKind } from '@manyfold/shared'
import type {
    Agent,
    AgentRuntimeRow,
    HostDaemonRow,
    RuntimeHostRow
} from '@manyfold/db'

// Where a runtime runs, resolved once through agent → runtime → host → host
// daemon (ADR-0037). RuntimeContextService returns a superset of this shape,
// so a context can be passed wherever a target is expected.
export interface RuntimeTarget {
    runtime: AgentRuntimeRow
    // null for an external-API runtime
    host: RuntimeHostRow | null
    daemon: HostDaemonRow | null
    providerKind: RuntimeProviderKind | null
    placement: AgentRuntime
}

export interface AgentAdapterContext extends RuntimeTarget {
    agentId: string
    name: string
}

export interface AgentAdapterCreateResult {
    workspacePath: string
}

export interface AgentAdapterListContext extends RuntimeTarget {
    primaryAgentId: string | null
}

export interface FrameworkAgent {
    id: string
    name: string
    workspace: string | null
    model: string | null
    extras: Record<string, unknown>
}

export interface AddAgentContext extends RuntimeTarget {
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

export interface RemoveAgentContext extends RuntimeTarget {
    agent: Agent
    primaryAgentId: string | null
}

export interface UpdateAgentContext extends RuntimeTarget {
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
    deleteAgent(ctx: RuntimeTarget & { agent: Agent }): Promise<void>
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
