import type { ChatUsage } from '@manyfold/shared'

export interface ClaudeModelUsage {
    input_tokens?: number
    inputTokens?: number
    output_tokens?: number
    outputTokens?: number
    cache_creation_input_tokens?: number
    cacheCreationInputTokens?: number
    cache_read_input_tokens?: number
    cacheReadInputTokens?: number
}

export interface ClaudeResultUsage {
    input_tokens?: number
    inputTokens?: number
    output_tokens?: number
    outputTokens?: number
    cache_creation_input_tokens?: number
    cacheCreationInputTokens?: number
    cache_read_input_tokens?: number
    cacheReadInputTokens?: number
}

export interface StreamJsonLine {
    type?: string
    subtype?: string
    session_id?: string
    message?: {
        id?: string
        content?: Array<{ type: string } & Record<string, unknown>>
    }
    tool_use_id?: string
    result?: string
    is_error?: boolean
    total_cost_usd?: number
    usage?: ClaudeResultUsage
    modelUsage?: Record<string, ClaudeModelUsage>
    // --include-partial-messages lines: type 'stream_event' carrying the raw
    // Anthropic streaming event; parent_tool_use_id is non-null on subagent
    // streams (their text still arrives via complete assistant lines).
    parent_tool_use_id?: string | null
    event?: {
        type?: string
        delta?: {
            type?: string
            text?: string
            thinking?: string
        }
    }
}

export const extractClaudeCodeUsage = (
    parsed: StreamJsonLine,
    fallbackModel: string | null,
    tStart: number,
    tFirstToken: number | null
): ChatUsage | null => {
    const modelEntries = parsed.modelUsage
        ? Object.entries(parsed.modelUsage)
        : []
    const [firstModel, firstModelUsage] = modelEntries[0] ?? []
    const rawUsage = parsed.usage ?? firstModelUsage
    if (!rawUsage) return null

    const input = toInt(rawUsage.input_tokens ?? rawUsage.inputTokens)
    const output = toInt(rawUsage.output_tokens ?? rawUsage.outputTokens)
    const cacheRead = toInt(
        rawUsage.cache_read_input_tokens ?? rawUsage.cacheReadInputTokens
    )
    const cacheCreation = toInt(
        rawUsage.cache_creation_input_tokens ??
            rawUsage.cacheCreationInputTokens
    )

    return {
        model: firstModel || fallbackModel,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        costUsd:
            typeof parsed.total_cost_usd === 'number'
                ? parsed.total_cost_usd
                : null,
        costSource:
            typeof parsed.total_cost_usd === 'number' ? 'upstream' : 'unknown',
        firstTokenMs: tFirstToken !== null ? tFirstToken - tStart : null,
        totalMs: Date.now() - tStart
    }
}

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
