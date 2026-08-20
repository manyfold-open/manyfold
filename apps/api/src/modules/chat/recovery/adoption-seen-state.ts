import type { TurnDeltaRun, TurnSeenState } from './turn-jsonl-recovery'

// Reconstruct what the (dead) live stream already delivered for a turn, from the
// durable record alone, so a fresh instance can run recoverTurnFromClaudeJsonl
// cross-process. The live adapter builds TurnSeenState in memory; after a
// restart that memory is gone, but chat_stream_events (delivered semantic
// events) and chat_message_sources (the raw JSONL lines already cached) hold
// the same information.
//
// Correctness backstop: recoverTurnFromClaudeJsonl's emitStreamedText bails to
// result_lost on any misalignment, so an imperfect reconstruction degrades to a
// retryable error — never to duplicated or dropped user-visible text.

export interface PersistedStreamEvent {
    eventType: string
    payloadJson: unknown
}

export interface PersistedSourceRow {
    rawText: string
    externalId: string | null
    sourceSeq: number
}

const asText = (payload: unknown): string => {
    if (typeof payload !== 'object' || payload === null) return ''
    const text = (payload as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

// The text/thinking already committed to disk as COMPLETE assistant lines — the
// prefix of the streamed text that recovery re-emits from the transcript itself
// (so it must not also come back as a delta run).
const coveredTextByKind = (
    sourceRows: PersistedSourceRow[]
): { token: string; thinking: string } => {
    let token = ''
    let thinking = ''
    for (const row of sourceRows) {
        let parsed: unknown
        try {
            parsed = JSON.parse(row.rawText)
        } catch {
            continue
        }
        if (!isRecord(parsed)) continue
        const message = parsed.message
        if (!isRecord(message) || message.role !== 'assistant') continue
        const content = message.content
        if (!Array.isArray(content)) continue
        for (const item of content) {
            if (!isRecord(item)) continue
            if (item.type === 'text' && typeof item.text === 'string')
                token += item.text
            else if (item.type === 'thinking') {
                if (typeof item.thinking === 'string') thinking += item.thinking
                else if (typeof item.text === 'string') thinking += item.text
            }
        }
    }
    return { token, thinking }
}

// Walk delivered token/thinking events in commit order; the portion of each
// kind beyond what the complete lines already cover is the streamed-but-
// uncovered partial (the in-flight block at drop time). Cross-kind order is
// preserved, consecutive same-kind text coalesced into one run.
const reconstructDeltaRuns = (
    streamEvents: PersistedStreamEvent[],
    covered: { token: string; thinking: string }
): TurnDeltaRun[] => {
    let skipToken = covered.token.length
    let skipThinking = covered.thinking.length
    const runs: TurnDeltaRun[] = []
    const pushRun = (kind: 'token' | 'thinking', text: string): void => {
        if (!text) return
        const last = runs[runs.length - 1]
        if (last && last.kind === kind) last.text += text
        else runs.push({ kind, text })
    }
    for (const ev of streamEvents) {
        if (ev.eventType !== 'token' && ev.eventType !== 'thinking') continue
        const kind = ev.eventType
        const text = asText(ev.payloadJson)
        if (!text) continue
        const skip = kind === 'token' ? skipToken : skipThinking
        if (skip >= text.length) {
            if (kind === 'token') skipToken -= text.length
            else skipThinking -= text.length
            continue
        }
        const remainder = text.slice(skip)
        if (kind === 'token') skipToken = 0
        else skipThinking = 0
        pushRun(kind, remainder)
    }
    return runs
}

export const buildSeenStateFromPersisted = (args: {
    streamEvents: PersistedStreamEvent[]
    sourceRows: PersistedSourceRow[]
}): { seen: TurnSeenState; firstSourceSeq: number } => {
    const uuids = new Set<string>()
    const apiMessageIds = new Set<string>()
    const toolCallIds = new Set<string>()
    let firstSourceSeq = 0
    for (const row of args.sourceRows) {
        if (row.externalId) uuids.add(row.externalId)
        if (row.sourceSeq > firstSourceSeq) firstSourceSeq = row.sourceSeq
        try {
            const parsed = JSON.parse(row.rawText)
            if (isRecord(parsed) && isRecord(parsed.message)) {
                const id = parsed.message.id
                if (typeof id === 'string') apiMessageIds.add(id)
            }
        } catch {
            /* a row that no longer parses just can't contribute an anchor */
        }
    }
    for (const ev of args.streamEvents) {
        if (ev.eventType !== 'tool_call') continue
        const id = isRecord(ev.payloadJson)
            ? (ev.payloadJson as { toolCallId?: unknown }).toolCallId
            : undefined
        if (typeof id === 'string') toolCallIds.add(id)
    }
    const covered = coveredTextByKind(args.sourceRows)
    const deltaRuns = reconstructDeltaRuns(args.streamEvents, covered)
    return {
        seen: { uuids, apiMessageIds, toolCallIds, deltaRuns },
        firstSourceSeq
    }
}
