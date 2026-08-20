import type { AgentFramework } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ApiChatAdapter } from '@/modules/chat/chat-adapter'
import { FakeEchoAdapter } from '@/modules/chat/adapters/fake-echo.adapter'
import { ClaudeCodeAdapter } from '@/modules/chat/adapters/claude-code.adapter'
import { OpenclawAdapter } from '@/modules/chat/adapters/openclaw.adapter'
import { CodexAdapter } from '@/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '@/modules/chat/adapters/gemini-cli.adapter'
import { HermesAdapter } from '@/modules/chat/adapters/hermes.adapter'
import { NarraNexusChatAdapter } from '@/modules/narranexus/narranexus-chat.adapter'
import {
    A2aChatAdapter,
    DifyChatAdapter,
    LangflowChatAdapter
} from '@/modules/chat/adapters/external-api.adapter'

@Injectable()
export class ChatAdapterRegistry {
    private readonly adapters = new Map<AgentFramework, ApiChatAdapter>()
    private fallback: ApiChatAdapter | null = null

    constructor(
        private readonly fakeEcho: FakeEchoAdapter,
        private readonly claudeCode: ClaudeCodeAdapter,
        private readonly openclaw: OpenclawAdapter,
        private readonly codex: CodexAdapter,
        private readonly geminiCli: GeminiCliAdapter,
        private readonly hermes: HermesAdapter,
        private readonly narraNexus: NarraNexusChatAdapter,
        private readonly dify: DifyChatAdapter,
        private readonly langflow: LangflowChatAdapter,
        private readonly a2a: A2aChatAdapter
    ) {
        this.fallback = this.fakeEcho
        this.register(this.claudeCode)
        this.register(this.openclaw)
        this.register(this.codex)
        this.register(this.geminiCli)
        this.register(this.hermes)
        this.register(this.narraNexus)
        this.register(this.dify)
        this.register(this.langflow)
        this.register(this.a2a)
    }

    register(adapter: ApiChatAdapter): void {
        this.adapters.set(adapter.framework, adapter)
    }

    get(framework: AgentFramework): ApiChatAdapter {
        const adapter = this.adapters.get(framework)
        if (adapter) return adapter
        if (this.fallback) return this.fallback
        throw new Error(
            `No chat adapter registered for framework '${framework}'`
        )
    }

    has(framework: AgentFramework): boolean {
        return this.adapters.has(framework)
    }
}
