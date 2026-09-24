import { UnknownFrameworkError, type AgentFramework } from '@manyfold/shared'
import { Injectable, Optional } from '@nestjs/common'
import type { AgentAdapter } from './agent-adapter'
import { ClaudeCodeAgentAdapter } from './claude-code-agent.adapter'
import { CodexAgentAdapter } from './codex-agent.adapter'
import { GeminiCliAgentAdapter } from './gemini-cli-agent.adapter'
import { PiAgentAdapter } from './pi-agent.adapter'
import { OpenclawAgentAdapter } from './openclaw-agent.adapter'
import { HermesAgentAdapter } from './hermes-agent.adapter'
import {
    A2aAgentAdapter,
    DifyAgentAdapter,
    LangflowAgentAdapter
} from './external-api-agent.adapter'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'

@Injectable()
export class AgentAdapterRegistry {
    private readonly map = new Map<AgentFramework, AgentAdapter>()

    constructor(
        claudeCode: ClaudeCodeAgentAdapter,
        codex: CodexAgentAdapter,
        geminiCli: GeminiCliAgentAdapter,
        pi: PiAgentAdapter,
        openclaw: OpenclawAgentAdapter,
        hermes: HermesAgentAdapter,
        dify: DifyAgentAdapter,
        langflow: LangflowAgentAdapter,
        a2a: A2aAgentAdapter,
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry()
    ) {
        for (const adapter of [
            claudeCode,
            codex,
            geminiCli,
            pi,
            openclaw,
            hermes,
            dify,
            langflow,
            a2a
        ])
            this.map.set(adapter.framework, adapter)
    }

    get(framework: AgentFramework): AgentAdapter {
        const adapter =
            this.map.get(framework) ??
            this.extensions.get(framework)?.agentAdapter
        if (!adapter) throw new UnknownFrameworkError(framework)
        return adapter
    }
}
