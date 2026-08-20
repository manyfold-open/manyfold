import type { AgentFramework } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
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

abstract class ExternalApiAgentAdapterBase implements AgentAdapter {
    abstract readonly framework: AgentFramework

    async createAgent(
        _ctx: AgentAdapterContext
    ): Promise<AgentAdapterCreateResult> {
        return { workspacePath: '' }
    }

    async deleteAgent(): Promise<void> {}

    async listAgents(_ctx: AgentAdapterListContext): Promise<FrameworkAgent[]> {
        return []
    }

    async addAgent(_ctx: AddAgentContext): Promise<AddAgentResult> {
        throw new NotSupportedError(this.framework, 'addAgent')
    }

    async removeAgent(_ctx: RemoveAgentContext): Promise<void> {}
}

@Injectable()
export class DifyAgentAdapter extends ExternalApiAgentAdapterBase {
    readonly framework: AgentFramework = 'dify'
}

@Injectable()
export class LangflowAgentAdapter extends ExternalApiAgentAdapterBase {
    readonly framework: AgentFramework = 'langflow'
}

@Injectable()
export class A2aAgentAdapter extends ExternalApiAgentAdapterBase {
    readonly framework: AgentFramework = 'a2a'
}
