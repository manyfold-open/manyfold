import type { AgentFramework } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { AgentAdapter } from './agent-adapter'
import { ClaudeCodeAgentAdapter } from './claude-code-agent.adapter'
import { CodexAgentAdapter } from './codex-agent.adapter'
import { GeminiCliAgentAdapter } from './gemini-cli-agent.adapter'
import { OpenclawAgentAdapter } from './openclaw-agent.adapter'
import { HermesAgentAdapter } from './hermes-agent.adapter'
import { NarraNexusAgentAdapter } from '@/modules/narranexus/narranexus-agent.adapter'
import {
    A2aAgentAdapter,
    DifyAgentAdapter,
    LangflowAgentAdapter
} from './external-api-agent.adapter'

@Injectable()
export class AgentAdapterRegistry {
    private readonly map = new Map<AgentFramework, AgentAdapter>()

    constructor(
        claudeCode: ClaudeCodeAgentAdapter,
        codex: CodexAgentAdapter,
        geminiCli: GeminiCliAgentAdapter,
        openclaw: OpenclawAgentAdapter,
        hermes: HermesAgentAdapter,
        narraNexus: NarraNexusAgentAdapter,
        dify: DifyAgentAdapter,
        langflow: LangflowAgentAdapter,
        a2a: A2aAgentAdapter
    ) {
        for (const adapter of [
            claudeCode,
            codex,
            geminiCli,
            openclaw,
            hermes,
            narraNexus,
            dify,
            langflow,
            a2a
        ])
            this.map.set(adapter.framework, adapter)
    }

    get(framework: AgentFramework): AgentAdapter {
        const adapter = this.map.get(framework)
        if (!adapter)
            throw new Error(`no AgentAdapter registered for ${framework}`)
        return adapter
    }
}
