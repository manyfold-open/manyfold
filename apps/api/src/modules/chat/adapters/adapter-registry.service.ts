import { UnknownFrameworkError, type AgentFramework } from '@manyfold/shared'
import { Injectable, Optional } from '@nestjs/common'
import type { ApiChatAdapter } from '@/modules/chat/chat-adapter'
import { ClaudeCodeAdapter } from '@/modules/chat/adapters/claude-code.adapter'
import { OpenclawAdapter } from '@/modules/chat/adapters/openclaw.adapter'
import { CodexAdapter } from '@/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '@/modules/chat/adapters/gemini-cli.adapter'
import { PiAdapter } from '@/modules/chat/adapters/pi.adapter'
import { HermesAdapter } from '@/modules/chat/adapters/hermes.adapter'
import {
    A2aChatAdapter,
    DifyChatAdapter,
    LangflowChatAdapter
} from '@/modules/chat/adapters/external-api.adapter'
import { FrameworkExtensionsRegistry } from '@/modules/frameworks/framework-extensions.registry'

@Injectable()
export class ChatAdapterRegistry {
    private readonly adapters = new Map<AgentFramework, ApiChatAdapter>()

    constructor(
        private readonly claudeCode: ClaudeCodeAdapter,
        private readonly openclaw: OpenclawAdapter,
        private readonly codex: CodexAdapter,
        private readonly geminiCli: GeminiCliAdapter,
        private readonly pi: PiAdapter,
        private readonly hermes: HermesAdapter,
        private readonly dify: DifyChatAdapter,
        private readonly langflow: LangflowChatAdapter,
        private readonly a2a: A2aChatAdapter,
        @Optional()
        private readonly extensions: FrameworkExtensionsRegistry = new FrameworkExtensionsRegistry()
    ) {
        this.register(this.claudeCode)
        this.register(this.openclaw)
        this.register(this.codex)
        this.register(this.geminiCli)
        this.register(this.pi)
        this.register(this.hermes)
        this.register(this.dify)
        this.register(this.langflow)
        this.register(this.a2a)
    }

    register(adapter: ApiChatAdapter): void {
        this.adapters.set(adapter.framework, adapter)
    }

    get(framework: AgentFramework): ApiChatAdapter {
        const adapter =
            this.adapters.get(framework) ??
            this.extensions.get(framework)?.chatAdapter
        if (!adapter) throw new UnknownFrameworkError(framework)
        return adapter
    }

    has(framework: AgentFramework): boolean {
        return (
            this.adapters.has(framework) ||
            this.extensions.get(framework) !== undefined
        )
    }
}
