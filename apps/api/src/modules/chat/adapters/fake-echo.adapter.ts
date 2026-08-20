import type {
    AgentFramework,
    ChatCapabilities,
    ChatMessage
} from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type {
    ApiChatAdapter,
    ApiChatAdapterContext,
    EmittedChatEvent
} from '@/modules/chat/chat-adapter'
import { messageToPromptText } from './message-content'

@Injectable()
export class FakeEchoAdapter implements ApiChatAdapter {
    readonly framework: AgentFramework = 'claude-code'

    getCapabilities(): ChatCapabilities {
        return {
            streaming: true,
            toolCalls: false,
            thinking: false,
            attachments: true,
            multiTurn: true
        }
    }

    async *sendMessage(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent> {
        const text = messageToPromptText(userMessage)
        const reply = `echo: ${text}`
        for (const chunk of chunkify(reply, 6)) {
            await delay(30)
            yield { type: 'token', text: chunk }
        }
        yield { type: 'done', finalMessageId: ctx.messageId }
    }
}

const chunkify = (text: string, size: number): string[] => {
    const out: string[] = []
    for (let i = 0; i < text.length; i += size) {
        out.push(text.slice(i, i + size))
    }
    return out
}

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))
