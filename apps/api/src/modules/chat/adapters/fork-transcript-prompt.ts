import type { ChatContentBlock, ChatMessage } from '@manyfold/shared'
import { messageToPromptText } from './message-content'

// Same budget/shape as openclaw/hermes truncateHistory: the fork transcript is
// re-inlined into the prompt of every non-resume turn, so an unbounded history
// grows token cost and TTFT linearly with conversation length.
const FORK_TRANSCRIPT_HISTORY_BUDGET = 30

const truncateHistory = (
    history: ChatMessage[],
    budget: number
): ChatMessage[] => {
    const systemPrefix: ChatMessage[] = []
    const rest: ChatMessage[] = []
    for (const msg of history) {
        if (msg.role === 'system' && rest.length === 0) systemPrefix.push(msg)
        else rest.push(msg)
    }
    const recent = rest.slice(-budget)
    return [...systemPrefix, ...recent]
}

// The prompt a resume-by-ref CLI (codex, pi) gets when the chat session has no
// runtime session to resume — after a message edit forked it — so the fresh
// runtime session still knows what was said before.
export const forkTranscriptPrompt = (
    history: ChatMessage[],
    userMessage: ChatMessage,
    frameworkLabel: string
): string => {
    const latestPrompt = messageToPromptText(userMessage)
    const priorMessages = truncateHistory(
        history,
        FORK_TRANSCRIPT_HISTORY_BUDGET
    ).filter((message) => message.id !== userMessage.id)
    if (priorMessages.length === 0) return latestPrompt

    const transcript = priorMessages
        .map((message) => {
            const role =
                message.role === 'assistant' ? 'assistant' : message.role
            return `<message role="${role}">\n${messageToTranscriptText(message)}\n</message>`
        })
        .join('\n\n')

    return [
        `You are continuing a Manyfold chat in a fresh ${frameworkLabel} runtime session.`,
        'The prior runtime session was intentionally forked after the user edited an earlier message.',
        'Use the transcript below as conversation context; do not mention the replay unless it is directly relevant.',
        '',
        '<previous_transcript>',
        transcript,
        '</previous_transcript>',
        '',
        'Continue from this latest user message:',
        '<latest_user_message>',
        latestPrompt,
        '</latest_user_message>'
    ].join('\n')
}

const messageToTranscriptText = (message: ChatMessage): string => {
    const visibleText = messageToPromptText(message)
    const activity = message.contentBlocks
        .map(summarizeNonTextBlock)
        .filter((line): line is string => Boolean(line))
    const parts = [visibleText, ...activity].filter(Boolean)
    return parts.length > 0 ? parts.join('\n') : '(no visible content)'
}

const summarizeNonTextBlock = (block: ChatContentBlock): string | null => {
    if (
        block.type === 'text' ||
        block.type === 'attachment' ||
        block.type === 'context_ref'
    )
        return null
    if (block.type === 'thinking') return `[thinking] ${block.text}`
    if (block.type === 'tool_call')
        return `[tool_call ${block.toolName}] ${safeStringify(block.args)}`
    if (block.type === 'tool_result')
        return `[tool_result ${block.toolCallId}] ${safeStringify(
            block.result
        )}`
    return null
}

const safeStringify = (value: unknown): string => {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}
