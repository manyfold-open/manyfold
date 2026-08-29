import type {
    ChatContentBlock,
    ChatError,
    ChatPermissionOption,
    ChatPermissionOutcome
} from '@manyfold/shared'

export interface StreamError {
    id: string
    error: ChatError
    messageId?: string
}

export type StreamingBlock =
    | { kind: 'token'; text: string }
    | { kind: 'thinking'; text: string }
    | {
          kind: 'tool_call'
          toolCallId: string
          toolName: string
          args: unknown
          elapsedMs?: number
      }
    | {
          kind: 'tool_result'
          toolCallId: string
          result: unknown
          elapsedMs?: number
      }
    | {
          kind: 'permission_request'
          requestId: string
          toolCallId: string | null
          title: string
          detail: string | null
          options: ChatPermissionOption[]
      }
    | {
          kind: 'permission_resolution'
          requestId: string
          outcome: ChatPermissionOutcome
          optionId: string | null
      }

// The typewriter calls this once per animation frame, so it must not grow
// with the answer. Merging replaces the tail entry in one copied array
// instead of building a sliced one and spreading it. The text itself stays a
// rope until something flattens it, and the single flatten per frame belongs
// to the renderer — measured on darwin/node22 [2026-08-09] at 0.02 ms for a
// 200 kB answer, against the 780 ms of heal + split it feeds.
export const appendStreamingBlock = (
    blocks: StreamingBlock[],
    next: StreamingBlock
): StreamingBlock[] => {
    const last = blocks[blocks.length - 1]
    const merged =
        (last?.kind === 'token' && next.kind === 'token') ||
        (last?.kind === 'thinking' && next.kind === 'thinking')
    if (!merged) return [...blocks, next]
    const out = blocks.slice()
    out[out.length - 1] = { kind: next.kind, text: last.text + next.text }
    return out
}

export const streamingBlocksToContentBlocks = (
    blocks: StreamingBlock[]
): ChatContentBlock[] => {
    const out: ChatContentBlock[] = []
    for (const block of blocks) {
        if (block.kind === 'token') {
            appendTextBlock(out, block.text)
            continue
        }
        if (block.kind === 'thinking') {
            appendThinkingBlock(out, block.text)
            continue
        }
        if (block.kind === 'tool_call') {
            out.push({
                type: 'tool_call',
                toolCallId: block.toolCallId,
                toolName: block.toolName,
                args: block.args,
                elapsedMs: block.elapsedMs
            })
            continue
        }
        if (block.kind === 'permission_request') {
            out.push({
                type: 'permission_request',
                requestId: block.requestId,
                toolCallId: block.toolCallId,
                title: block.title,
                detail: block.detail,
                options: block.options
            })
            continue
        }
        if (block.kind === 'permission_resolution') {
            out.push({
                type: 'permission_resolution',
                requestId: block.requestId,
                outcome: block.outcome,
                optionId: block.optionId
            })
            continue
        }
        out.push({
            type: 'tool_result',
            toolCallId: block.toolCallId,
            result: block.result,
            elapsedMs: block.elapsedMs
        })
    }
    return out
}

// The inverse, for the one caller that starts a stream from content it
// already has: a cold attach seeds the live blocks from the checkpoint the
// message page shipped, and resumes the SSE from the event id that checkpoint
// pairs with, rather than replaying the turn from its first event.
//
// Round-trips with streamingBlocksToContentBlocks for every block the server
// can checkpoint. Anything else is dropped rather than guessed at: a block
// kind the live stream has no way to produce cannot be part of a fold of
// stream events, so keeping it would put content in the bubble that the
// replay path would not have produced.
export const contentBlocksToStreamingBlocks = (
    blocks: ChatContentBlock[]
): StreamingBlock[] => {
    const out: StreamingBlock[] = []
    for (const block of blocks) {
        // Empty text and thinking blocks are dropped, not carried. The server
        // writes one when a `replace` supersedes the answer with nothing at
        // all, and the live reducer appends nothing in that case — so keeping
        // it would leave an empty bubble where the replay path shows the
        // working indicator.
        if (block.type === 'text') {
            if (block.text) out.push({ kind: 'token', text: block.text })
        } else if (block.type === 'thinking') {
            if (block.text) out.push({ kind: 'thinking', text: block.text })
        } else if (block.type === 'tool_call')
            out.push({
                kind: 'tool_call',
                toolCallId: block.toolCallId,
                toolName: block.toolName,
                args: block.args,
                elapsedMs: block.elapsedMs
            })
        else if (block.type === 'tool_result')
            out.push({
                kind: 'tool_result',
                toolCallId: block.toolCallId,
                result: block.result,
                elapsedMs: block.elapsedMs
            })
        else if (block.type === 'permission_request')
            out.push({
                kind: 'permission_request',
                requestId: block.requestId,
                toolCallId: block.toolCallId,
                title: block.title,
                detail: block.detail,
                options: block.options
            })
        else if (block.type === 'permission_resolution')
            out.push({
                kind: 'permission_resolution',
                requestId: block.requestId,
                outcome: block.outcome,
                optionId: block.optionId
            })
    }
    return out
}

const appendTextBlock = (out: ChatContentBlock[], text: string): void => {
    const last = out[out.length - 1]
    if (last?.type === 'text') {
        last.text += text
        return
    }
    out.push({ type: 'text', text })
}

const appendThinkingBlock = (out: ChatContentBlock[], text: string): void => {
    const last = out[out.length - 1]
    if (last?.type === 'thinking') {
        last.text += text
        return
    }
    out.push({ type: 'thinking', text })
}
