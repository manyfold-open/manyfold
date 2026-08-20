import type { ChatUsage } from '@manyfold/shared'
import type { EmittedChatEvent } from '../chat-adapter'
import type { RecoveryFs } from './recovery-fs'
import {
    claudeSessionLocateScript,
    parseClaudeJsonlEntries,
    type ClaudeJsonLine,
    type ClaudeJsonlEntry
} from './readers/claude-code-reader'

// Recover a Claude turn from the on-disk session log after the sprite exec
// session was reaped mid-detach (SpritesError reason 'exec_session_gone'). The
// live stream never delivered a terminal result, but the CLI wrote the full
// turn to ~/.claude/projects/*/<sessionId>.jsonl. This reads that log and emits
// ONLY the events the live stream had not already produced, so the turn can
// finish exactly once. Pure and DI-free so the adapter test can drive it with a
// fake RecoveryFs.

const CLAUDE_RECOVERY_PARSER_NAME = 'claude-code-session-jsonl'
const CLAUDE_RECOVERY_PARSER_VERSION = '1'

// stop_reason values that mean the turn actually finished (vs dying while a tool
// call was outstanding). Conservative: anything else — tool_use, null, refusal,
// max_tokens, unknown — is treated as no definitive terminal → result_lost.
const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence'])

export interface TurnDeltaRun {
    kind: 'token' | 'thinking'
    text: string
}

// What the live adapter already emitted this turn, so recovery emits only the
// tail. uuids is the per-line dedup key; apiMessageIds anchors the turn when
// uuid parity between stdout and disk fails; deltaRuns is the streamed-but-
// uncovered partial text of the in-flight block at drop time.
export interface TurnSeenState {
    uuids: Set<string>
    apiMessageIds: Set<string>
    toolCallIds: Set<string>
    deltaRuns: TurnDeltaRun[]
}

export type TurnRecoveryVerdict =
    | {
          outcome: 'recovered'
          events: EmittedChatEvent[]
          usage: ChatUsage
          sourceFile: string
          recoveredLines: number
          lastSourceSeq: number
      }
    | {
          outcome: 'result_lost'
          events: EmittedChatEvent[]
          sourceFile: string | null
          detail: string
          lastSourceSeq: number
      }
    | { outcome: 'failed'; detail: string }

export interface RecoverTurnArgs {
    fs: RecoveryFs
    frameworkSessionRef: string
    promptText: string
    seen: TurnSeenState
    firstSourceSeq: number
    model: string | null
    tStart: number
    tFirstToken: number | null
    now?: () => number
}

export const recoverTurnFromClaudeJsonl = async (
    args: RecoverTurnArgs
): Promise<TurnRecoveryVerdict> => {
    const now = args.now ?? (() => Date.now())
    try {
        const sourceFile = await args.fs.locate(
            claudeSessionLocateScript(args.frameworkSessionRef)
        )
        if (!sourceFile)
            return { outcome: 'failed', detail: 'session file not found' }
        const text = await args.fs.readFile(sourceFile)
        if (text === null)
            return { outcome: 'failed', detail: `read failed: ${sourceFile}` }

        const { entries } = parseClaudeJsonlEntries(text)
        const turn = turnEntries(
            entries,
            args.frameworkSessionRef,
            args.promptText,
            args.seen
        )
        if (!turn)
            return {
                outcome: 'result_lost',
                events: [],
                sourceFile,
                detail: 'turn boundary not found',
                lastSourceSeq: args.firstSourceSeq
            }

        const assistantEntries = turn.filter(
            (e) => role(e.parsed) === 'assistant'
        )
        const usage = synthesizeUsage(
            assistantEntries,
            args.model,
            args.tStart,
            args.tFirstToken,
            now
        )
        const terminal =
            assistantEntries.length > 0 &&
            isTerminalStop(assistantEntries[assistantEntries.length - 1].parsed)

        const unseen = unseenTail(turn, args.seen)
        const emit = emitUnseen(
            unseen,
            args.frameworkSessionRef,
            sourceFile,
            args.firstSourceSeq,
            args.seen.deltaRuns
        )
        if (emit.anomaly)
            return {
                outcome: 'result_lost',
                events: [],
                sourceFile,
                detail: `stream/disk mismatch: ${emit.anomaly}`,
                lastSourceSeq: args.firstSourceSeq
            }

        if (!terminal)
            return {
                outcome: 'result_lost',
                events: emit.events,
                sourceFile,
                detail: 'no terminal stop_reason',
                lastSourceSeq: emit.lastSourceSeq
            }

        return {
            outcome: 'recovered',
            events: emit.events,
            usage,
            sourceFile,
            recoveredLines: unseen.length,
            lastSourceSeq: emit.lastSourceSeq
        }
    } catch (err) {
        return {
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err)
        }
    }
}

// The turn = entries after this turn's user prompt. Restricted to the main chain
// (sidechain/subagent entries excluded) and this session's lines.
const turnEntries = (
    entries: ClaudeJsonlEntry[],
    ref: string,
    promptText: string,
    seen: TurnSeenState
): ClaudeJsonlEntry[] | null => {
    const working = entries.filter(
        (e) =>
            (!e.parsed.sessionId || e.parsed.sessionId === ref) &&
            e.parsed.isSidechain !== true
    )
    const target = promptText.trim()
    // Primary: the LAST user prompt matching this turn's text. LAST because this
    // exec is by definition the newest turn in the file, so a repeated prompt
    // ("continue") still anchors correctly.
    if (target)
        for (let i = working.length - 1; i >= 0; i--) {
            const p = working[i].parsed
            if (
                role(p) === 'user' &&
                !isToolResultOnly(p) &&
                entryPlainText(p).trim() === target
            )
                return working.slice(i + 1)
        }
    // Fallback (uuid parity failed / prompt text didn't match): anchor at the
    // earliest entry the adapter already saw; the dedup cut drops the seen
    // prefix so nothing is double-emitted.
    for (let i = 0; i < working.length; i++) {
        const p = working[i].parsed
        if (
            (p.uuid && seen.uuids.has(p.uuid)) ||
            (role(p) === 'assistant' &&
                !!p.message?.id &&
                seen.apiMessageIds.has(p.message.id))
        )
            return working.slice(i)
    }
    return null
}

// Consumed stdout is a byte-exact prefix of the process's full output, and disk
// entries append in stream order, so the seen uuids form a prefix of the turn.
// Cut after the last uuid we saw; everything after is unseen. uuid is the
// reliable per-line key — message.id is shared across a message's lines, so it
// cannot tell which lines of a split message were already streamed.
const unseenTail = (
    turn: ClaudeJsonlEntry[],
    seen: TurnSeenState
): ClaudeJsonlEntry[] => {
    let lastSeen = -1
    for (let i = 0; i < turn.length; i++) {
        const uuid = turn[i].parsed.uuid
        if (uuid && seen.uuids.has(uuid)) lastSeen = i
    }
    return turn.slice(lastSeen + 1)
}

const emitUnseen = (
    unseen: ClaudeJsonlEntry[],
    ref: string,
    sourceFile: string,
    firstSourceSeq: number,
    deltaRuns: TurnDeltaRun[]
): {
    events: EmittedChatEvent[]
    lastSourceSeq: number
    anomaly: string | null
} => {
    const events: EmittedChatEvent[] = []
    // Copy so a bail-out leaves the caller's state untouched.
    const runs = deltaRuns.map((r) => ({ ...r }))
    let seq = firstSourceSeq
    for (const entry of unseen) {
        const p = entry.parsed
        seq += 1
        events.push({
            type: 'raw_source',
            source: {
                sourceRef: p.sessionId ?? ref,
                sourceFile,
                sourceSeq: seq,
                externalId: p.uuid ?? `${p.type ?? 'event'}-${seq}`,
                parentExternalId: p.parentUuid ?? null,
                rawFormat: 'jsonl',
                rawText: entry.raw,
                parserName: CLAUDE_RECOVERY_PARSER_NAME,
                parserVersion: CLAUDE_RECOVERY_PARSER_VERSION
            }
        })
        const r = role(p)
        if (r === 'assistant') {
            const anomaly = emitAssistantBlocks(p, runs, events)
            if (anomaly)
                return { events: [], lastSourceSeq: firstSourceSeq, anomaly }
        } else if (r === 'user') {
            emitToolResults(p, events)
        }
        // system entries emit raw_source only, matching the live stream path.
    }
    if (runs.length > 0)
        return {
            events: [],
            lastSourceSeq: firstSourceSeq,
            anomaly: 'streamed deltas did not match any recovered block'
        }
    return { events, lastSourceSeq: seq, anomaly: null }
}

const emitAssistantBlocks = (
    p: ClaudeJsonLine,
    runs: TurnDeltaRun[],
    events: EmittedChatEvent[]
): string | null => {
    const items = Array.isArray(p.message?.content)
        ? (p.message!.content as unknown[])
        : []
    for (const item of items) {
        if (!isRecord(item)) continue
        const t = typeof item.type === 'string' ? item.type : ''
        if (t === 'text' && typeof item.text === 'string') {
            const anomaly = emitStreamedText('token', item.text, runs, events)
            if (anomaly) return anomaly
        } else if (t === 'thinking') {
            const thinking =
                typeof item.thinking === 'string'
                    ? item.thinking
                    : typeof item.text === 'string'
                      ? item.text
                      : ''
            const anomaly = emitStreamedText('thinking', thinking, runs, events)
            if (anomaly) return anomaly
        } else if (
            t === 'tool_use' &&
            typeof item.id === 'string' &&
            typeof item.name === 'string'
        ) {
            // A tool_use block cannot carry streamed text; leftover runs here
            // mean the stream and disk disagree on block layout — bail.
            if (runs.length > 0) return 'streamed deltas pending at tool_use'
            events.push({
                type: 'tool_call',
                toolCallId: item.id,
                toolName: item.name,
                args: item.input ?? null
            })
        }
    }
    return null
}

// Emit only the part of a recovered text/thinking block that was not already
// streamed as partial deltas. The head run must equal or prefix the block; any
// other relationship is an alignment failure and bails to result_lost.
const emitStreamedText = (
    kind: 'token' | 'thinking',
    blockText: string,
    runs: TurnDeltaRun[],
    events: EmittedChatEvent[]
): string | null => {
    const head = runs[0]
    if (head) {
        if (head.kind !== kind)
            return `streamed ${head.kind} delta but recovered ${kind} block`
        if (head.text === blockText) {
            runs.shift()
            return null
        }
        if (blockText.startsWith(head.text)) {
            runs.shift()
            const remainder = blockText.slice(head.text.length)
            if (remainder) events.push(textEvent(kind, remainder))
            return null
        }
        return 'streamed delta is not a prefix of the recovered block'
    }
    if (blockText) events.push(textEvent(kind, blockText))
    return null
}

const emitToolResults = (
    p: ClaudeJsonLine,
    events: EmittedChatEvent[]
): void => {
    const items = Array.isArray(p.message?.content)
        ? (p.message!.content as unknown[])
        : []
    for (const item of items) {
        if (!isRecord(item)) continue
        if (item.type === 'tool_result' && typeof item.tool_use_id === 'string')
            events.push({
                type: 'tool_result',
                toolCallId: item.tool_use_id,
                result: item.content ?? item
            })
    }
}

const synthesizeUsage = (
    assistantEntries: ClaudeJsonlEntry[],
    fallbackModel: string | null,
    tStart: number,
    tFirstToken: number | null,
    now: () => number
): ChatUsage => {
    const countedIds = new Set<string>()
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheCreation = 0
    let model: string | null = null
    // One API message spans multiple JSONL lines, each repeating the same usage
    // and message.id, so sum once per message.id. No total_cost_usd on disk →
    // costUsd null / costSource 'unknown' (matches extractClaudeCodeUsage).
    for (const e of assistantEntries) {
        const msg = e.parsed.message
        if (msg?.model) model = msg.model
        const id = msg?.id ?? e.parsed.uuid
        if (!id || countedIds.has(id)) continue
        countedIds.add(id)
        const u = msg?.usage
        if (u) {
            input += toInt(u.input_tokens)
            output += toInt(u.output_tokens)
            cacheRead += toInt(u.cache_read_input_tokens)
            cacheCreation += toInt(u.cache_creation_input_tokens)
        }
    }
    return {
        model: model ?? fallbackModel,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        costUsd: null,
        costSource: 'unknown',
        firstTokenMs: tFirstToken !== null ? tFirstToken - tStart : null,
        totalMs: now() - tStart
    }
}

const textEvent = (
    kind: 'token' | 'thinking',
    text: string
): EmittedChatEvent =>
    kind === 'token' ? { type: 'token', text } : { type: 'thinking', text }

const role = (p: ClaudeJsonLine): string | undefined => p.message?.role

const isTerminalStop = (p: ClaudeJsonLine): boolean =>
    typeof p.message?.stop_reason === 'string' &&
    TERMINAL_STOP_REASONS.has(p.message.stop_reason)

const entryPlainText = (p: ClaudeJsonLine): string => {
    const c = p.message?.content
    if (typeof c === 'string') return c
    if (!Array.isArray(c)) return ''
    let out = ''
    for (const item of c)
        if (isRecord(item) && item.type === 'text' && typeof item.text === 'string')
            out += item.text
    return out
}

const isToolResultOnly = (p: ClaudeJsonLine): boolean => {
    const c = p.message?.content
    if (!Array.isArray(c) || c.length === 0) return false
    return c.every((item) => isRecord(item) && item.type === 'tool_result')
}

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null
