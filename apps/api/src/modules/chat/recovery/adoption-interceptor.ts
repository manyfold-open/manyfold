import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'

// Suppress the already-delivered prefix when an adopted turn's stream is
// re-consumed from the top: recovery re-reads a source (claude transcript,
// codex rollout, gemini session file) whose head the dead relay already
// delivered, and the durable chat_stream_events log says exactly what of it
// reached the client. Text aligns as a per-kind prefix (delta coalescing
// boundaries may differ between runs — only the concatenation is stable);
// tool events dedup by id multiset or ordered count; any misalignment is
// reported as a mismatch so the caller stops emitting instead of guessing.

export interface DeliveredBaseline {
    token: string
    thinking: string
    toolCalls: Map<string, number>
    toolResults: Map<string, number>
    usageDelivered: boolean
}

export const deliveredBaselineFromStreamEvents = (
    events: Array<{ eventType: string; payloadJson: unknown }>
): DeliveredBaseline => {
    const baseline: DeliveredBaseline = {
        token: '',
        thinking: '',
        toolCalls: new Map(),
        toolResults: new Map(),
        usageDelivered: false
    }
    const inc = (map: Map<string, number>, id: string): void => {
        map.set(id, (map.get(id) ?? 0) + 1)
    }
    for (const ev of events) {
        const p = (ev.payloadJson ?? {}) as Record<string, unknown>
        if (ev.eventType === 'token' && typeof p.text === 'string')
            baseline.token += p.text
        else if (ev.eventType === 'thinking' && typeof p.text === 'string')
            baseline.thinking += p.text
        else if (
            ev.eventType === 'tool_call' &&
            typeof p.toolCallId === 'string'
        )
            inc(baseline.toolCalls, p.toolCallId)
        else if (
            ev.eventType === 'tool_result' &&
            typeof p.toolCallId === 'string'
        )
            inc(baseline.toolResults, p.toolCallId)
        else if (ev.eventType === 'usage') baseline.usageDelivered = true
    }
    return baseline
}

export interface AdoptionInterceptor {
    // Filter one consumer event against the delivered baseline: returns the
    // events to actually emit (the undelivered excess), or a mismatch
    // description when the replay's text disagrees with what was delivered —
    // the caller must stop emitting and fall back.
    intercept(ev: EmittedChatEvent): {
        events: EmittedChatEvent[]
        mismatch?: string
    }
    // True once every delivered byte has been matched by the replay.
    aligned(): boolean
}

export const createAdoptionInterceptor = (
    baseline: DeliveredBaseline,
    // 'id': dedup tool events by their id multiset (the re-read stream carries
    // the SAME ids the relay delivered). 'count': skip the first N tool events
    // per kind in order (codex rollout recovery — rollout ids fc_/call_ never
    // match the delivered stdout item_N ids, but both streams are block-level
    // and order-preserving).
    opts: { toolDedup?: 'id' | 'count' } = {}
): AdoptionInterceptor => {
    let tokenRemaining = baseline.token
    let thinkingRemaining = baseline.thinking
    const toolDedupMode = opts.toolDedup ?? 'id'
    const sumOf = (map: Map<string, number>): number => {
        let n = 0
        for (const v of map.values()) n += v
        return n
    }
    let toolCallsToSkip = sumOf(baseline.toolCalls)
    let toolResultsToSkip = sumOf(baseline.toolResults)
    const toolCalls = new Map(baseline.toolCalls)
    const toolResults = new Map(baseline.toolResults)
    let usageRemaining = baseline.usageDelivered

    const alignText = (
        kind: 'token' | 'thinking',
        text: string
    ): { events: EmittedChatEvent[]; mismatch?: string } => {
        const remaining = kind === 'token' ? tokenRemaining : thinkingRemaining
        if (remaining.length === 0)
            return { events: [{ type: kind, text }] }
        const overlap = Math.min(text.length, remaining.length)
        if (text.slice(0, overlap) !== remaining.slice(0, overlap))
            return {
                events: [],
                mismatch: `${kind} replay diverged from the delivered stream (at ${
                    (kind === 'token' ? baseline.token : baseline.thinking)
                        .length - remaining.length
                } of ${(kind === 'token' ? baseline.token : baseline.thinking).length} delivered chars; expected ${JSON.stringify(
                    remaining.slice(0, 40)
                )} got ${JSON.stringify(text.slice(0, 40))})`
            }
        const rest = remaining.slice(overlap)
        if (kind === 'token') tokenRemaining = rest
        else thinkingRemaining = rest
        const excess = text.slice(overlap)
        return { events: excess ? [{ type: kind, text: excess }] : [] }
    }

    const dedupTool = (
        map: Map<string, number>,
        id: string
    ): boolean => {
        const count = map.get(id) ?? 0
        if (count <= 0) return false
        if (count === 1) map.delete(id)
        else map.set(id, count - 1)
        return true
    }
    const dedupToolCall = (id: string): boolean => {
        if (toolDedupMode === 'id') return dedupTool(toolCalls, id)
        if (toolCallsToSkip <= 0) return false
        toolCallsToSkip -= 1
        return true
    }
    const dedupToolResult = (id: string): boolean => {
        if (toolDedupMode === 'id') return dedupTool(toolResults, id)
        if (toolResultsToSkip <= 0) return false
        toolResultsToSkip -= 1
        return true
    }

    return {
        intercept: (ev) => {
            if (ev.type === 'token' || ev.type === 'thinking')
                return alignText(ev.type, ev.text)
            if (ev.type === 'tool_call')
                return dedupToolCall(ev.toolCallId)
                    ? { events: [] }
                    : { events: [ev] }
            if (ev.type === 'tool_result')
                return dedupToolResult(ev.toolCallId)
                    ? { events: [] }
                    : { events: [ev] }
            if (ev.type === 'usage') {
                if (usageRemaining) {
                    usageRemaining = false
                    return { events: [] }
                }
                return { events: [ev] }
            }
            return { events: [ev] }
        },
        aligned: () =>
            tokenRemaining.length === 0 &&
            thinkingRemaining.length === 0 &&
            (toolDedupMode === 'id'
                ? toolCalls.size === 0 && toolResults.size === 0
                : toolCallsToSkip === 0 && toolResultsToSkip === 0)
    }
}
