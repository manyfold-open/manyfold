import type { ChatUsage } from '@manyfold/shared'
import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'
import type { RecoveryFs } from '@/modules/chat/recovery/recovery-fs'
import { shellEscape } from '@/modules/chat/recovery/recovery-fs'

// Recover an adopted CODEX turn from the on-sprite rollout file. Unlike the
// claude transcript (anchored by prompt text / seen uuids), a codex rollout
// carries EXPLICIT turn framing: `event_msg:task_started {turn_id}` opens the
// turn and `task_complete` / `turn_aborted` (same turn_id) closes it, and the
// `event_msg` rows mirror the CLI's stdout items verbatim (agent_message /
// agent_reasoning text is byte-identical to what the live relay streamed) —
// so the caller dedups with the same per-kind text cursors used elsewhere.
// Rollout ids (msg_/fc_/call_) do NOT match the stdout item ids (item_N), so
// tool dedup must be count-based, never id-based.

const CODEX_ROLLOUT_PARSER_NAME = 'codex-rollout-turn'
const CODEX_ROLLOUT_PARSER_VERSION = '1'

export type CodexTurnVerdict =
    | { outcome: 'failed'; detail: string }
    | {
          outcome: 'result_lost'
          events: EmittedChatEvent[]
          lastSourceSeq: number
          sourceFile: string | null
          detail: string
      }
    | {
          outcome: 'turn_failed'
          events: EmittedChatEvent[]
          lastSourceSeq: number
          sourceFile: string
          detail: string
      }
    | {
          outcome: 'recovered'
          events: EmittedChatEvent[]
          usage: ChatUsage
          lastSourceSeq: number
          sourceFile: string
          recoveredLines: number
      }

// Same location scheme as CodexSessionReader (session import) — the rollout
// filename embeds the thread id.
export const codexRolloutLocateScript = (ref: string): string =>
    `find "\${CODEX_HOME:-$HOME/.codex}"/sessions "$HOME"/.codex/sessions -type f -name ${shellEscape(`*${ref}*.jsonl`)} 2>/dev/null | head -1`

interface RolloutRow {
    lineNo: number
    raw: string
    type: string
    timestamp: string | null
    payload: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0

const parseRows = (text: string): RolloutRow[] => {
    const rows: RolloutRow[] = []
    let lineNo = 0
    for (const rawLine of text.split('\n')) {
        lineNo++
        const line = rawLine.trim()
        if (!line) continue
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }
        if (!isRecord(parsed) || typeof parsed.type !== 'string') continue
        rows.push({
            lineNo,
            raw: rawLine.replace(/\r$/, ''),
            type: parsed.type,
            timestamp: str(parsed.timestamp),
            payload: isRecord(parsed.payload) ? parsed.payload : {}
        })
    }
    return rows
}

interface TokenTotals {
    input: number
    cached: number
    output: number
}

const tokenTotals = (row: RolloutRow): TokenTotals | null => {
    const info = isRecord(row.payload.info) ? row.payload.info : null
    const total =
        info && isRecord(info.total_token_usage) ? info.total_token_usage : null
    if (!total) return null
    return {
        input: toInt(total.input_tokens),
        cached: toInt(total.cached_input_tokens),
        output:
            toInt(total.output_tokens) + toInt(total.reasoning_output_tokens)
    }
}

const safeParseJson = (s: string): unknown => {
    try {
        return JSON.parse(s)
    } catch {
        return null
    }
}

// Semantic events for one rollout row (rollout shapes, mirrored to the same
// event kinds the live stdout produced), or null for non-semantic rows.
const rowEvents = (
    row: RolloutRow,
    sourceRef: string,
    sourceFile: string
): EmittedChatEvent[] | null => {
    const p = row.payload
    const out: EmittedChatEvent[] = []
    const rawSource = (externalId: string): EmittedChatEvent => ({
        type: 'raw_source',
        source: {
            sourceRef,
            sourceFile,
            sourceSeq: row.lineNo,
            externalId,
            parentExternalId: null,
            rawFormat: 'jsonl',
            rawText: row.raw,
            parserName: CODEX_ROLLOUT_PARSER_NAME,
            parserVersion: CODEX_ROLLOUT_PARSER_VERSION
        }
    })
    if (row.type === 'event_msg') {
        const pt = str(p.type)
        if (pt === 'agent_message' && typeof p.message === 'string') {
            out.push(rawSource(`codex-msg-${row.lineNo}`))
            out.push({ type: 'token', text: p.message })
            return out
        }
        if (pt === 'agent_reasoning' && typeof p.text === 'string') {
            out.push(rawSource(`codex-reasoning-${row.lineNo}`))
            out.push({ type: 'thinking', text: p.text })
            return out
        }
        return null
    }
    if (row.type !== 'response_item') return null
    const itemType = str(p.type)
    const callId = str(p.call_id) ?? str(p.id)
    if (
        (itemType === 'function_call' || itemType === 'custom_tool_call') &&
        callId
    ) {
        out.push(rawSource(callId))
        const rawArgs = p.arguments ?? p.input ?? null
        out.push({
            type: 'tool_call',
            toolCallId: callId,
            toolName: str(p.name) ?? itemType,
            args:
                typeof rawArgs === 'string'
                    ? (safeParseJson(rawArgs) ?? rawArgs)
                    : rawArgs
        })
        return out
    }
    if (
        (itemType === 'function_call_output' ||
            itemType === 'custom_tool_call_output') &&
        callId
    ) {
        out.push(rawSource(callId))
        out.push({
            type: 'tool_result',
            toolCallId: callId,
            result: p.output ?? null
        })
        return out
    }
    return null
}

// The anchored turn must not be MUCH older than the assistant message it is
// recovered into: a turn that died before writing task_started would anchor
// at the PREVIOUS turn, and with an identical repeated prompt the identity
// check alone cannot tell them apart. Sprite clocks are NTP'd; minutes of
// slack tolerate skew while rejecting a stale turn.
const TURN_ANCHOR_MAX_AGE_BEFORE_MESSAGE_MS = 5 * 60 * 1000

export const recoverTurnFromCodexRollout = async (args: {
    fs: RecoveryFs
    frameworkSessionRef: string
    promptText: string
    model: string | null
    messageCreatedAt?: Date
    // Emit semantic events only for rollout lines AFTER this line number —
    // the caller's incremental cursor across re-polls (terminal detection
    // always evaluates the whole file).
    sinceLine: number
}): Promise<CodexTurnVerdict> => {
    try {
        const sourceFile = await args.fs.locate(
            codexRolloutLocateScript(args.frameworkSessionRef)
        )
        if (!sourceFile)
            return { outcome: 'failed', detail: 'rollout file not found' }
        const text = await args.fs.readFile(sourceFile)
        if (text === null)
            return { outcome: 'failed', detail: `read failed: ${sourceFile}` }

        const rows = parseRows(text)
        const lastLine = rows.length ? rows[rows.length - 1].lineNo : 0

        // This exec is by definition the newest turn in the rollout.
        let anchorIdx = -1
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i]
            if (
                row.type === 'event_msg' &&
                str(row.payload.type) === 'task_started'
            ) {
                anchorIdx = i
                break
            }
        }
        if (anchorIdx === -1)
            return {
                outcome: 'result_lost',
                events: [],
                lastSourceSeq: lastLine,
                sourceFile,
                detail: 'turn boundary not found'
            }
        const turnId = str(rows[anchorIdx].payload.turn_id)

        // A turn that predates the adopted assistant message is a PREVIOUS
        // turn (ours died before writing task_started) — never emit it.
        const anchorTs = rows[anchorIdx].timestamp
        if (args.messageCreatedAt && anchorTs) {
            const anchorMs = Date.parse(anchorTs)
            if (
                Number.isFinite(anchorMs) &&
                anchorMs <
                    args.messageCreatedAt.getTime() -
                        TURN_ANCHOR_MAX_AGE_BEFORE_MESSAGE_MS
            )
                return {
                    outcome: 'result_lost',
                    events: [],
                    lastSourceSeq: lastLine,
                    sourceFile,
                    detail: 'anchored turn predates this message'
                }
        }

        // Identity: the turn's user_message must be the prompt we sent —
        // verbatim for resumed turns, or wrapped in <latest_user_message>
        // tags for a history-composed fresh-session prompt. A mismatch means
        // the newest turn in this file is not ours (e.g. a stale ref) —
        // never emit another turn's content.
        if (args.promptText) {
            const um = rows
                .slice(anchorIdx + 1)
                .find(
                    (r) =>
                        r.type === 'event_msg' &&
                        str(r.payload.type) === 'user_message'
                )
            const message =
                um && typeof um.payload.message === 'string'
                    ? um.payload.message
                    : null
            const matches =
                message === null ||
                message === args.promptText ||
                message.includes(
                    `<latest_user_message>\n${args.promptText}\n</latest_user_message>`
                )
            if (!matches)
                return {
                    outcome: 'result_lost',
                    events: [],
                    lastSourceSeq: lastLine,
                    sourceFile,
                    detail: 'turn user_message does not match the prompt'
                }
        }

        const turnRows = rows.slice(anchorIdx + 1)
        let terminal: 'complete' | 'failed' | null = null
        let terminalDetail = ''
        for (const row of turnRows) {
            if (row.type !== 'event_msg') continue
            const pt = str(row.payload.type)
            if (
                (pt === 'task_complete' ||
                    pt === 'turn_aborted' ||
                    pt === 'turn_failed' ||
                    pt === 'task_failed') &&
                (turnId === null || str(row.payload.turn_id) === turnId)
            ) {
                terminal = pt === 'task_complete' ? 'complete' : 'failed'
                terminalDetail = pt ?? ''
                break
            }
        }

        const events: EmittedChatEvent[] = []
        let recoveredLines = 0
        for (const row of turnRows) {
            if (row.lineNo <= args.sinceLine) continue
            const evs = rowEvents(row, args.frameworkSessionRef, sourceFile)
            if (!evs) continue
            recoveredLines++
            events.push(...evs)
        }

        if (terminal === 'failed')
            return {
                outcome: 'turn_failed',
                events,
                lastSourceSeq: lastLine,
                sourceFile,
                detail: terminalDetail
            }
        if (terminal === null)
            return {
                outcome: 'result_lost',
                events,
                lastSourceSeq: lastLine,
                sourceFile,
                detail: 'turn not terminal'
            }

        // Turn usage = cumulative token_count at turn end minus the cumulative
        // total before the turn started (token_count carries session totals).
        let before: TokenTotals = { input: 0, cached: 0, output: 0 }
        for (let i = 0; i < anchorIdx; i++) {
            const t = tokenTotals(rows[i])
            if (t) before = t
        }
        let after: TokenTotals | null = null
        for (const row of turnRows) {
            const t = tokenTotals(row)
            if (t) after = t
        }
        let model = args.model
        for (const row of turnRows) {
            if (row.type === 'turn_context' && str(row.payload.model)) {
                model = str(row.payload.model)
                break
            }
        }
        // No cost data on disk → costUsd null / costSource 'unknown' (same
        // convention as claude transcript recovery).
        const usage: ChatUsage = {
            model,
            inputTokens: after ? Math.max(0, after.input - before.input) : 0,
            outputTokens: after
                ? Math.max(0, after.output - before.output)
                : 0,
            cacheReadTokens: after
                ? Math.max(0, after.cached - before.cached)
                : 0,
            cacheCreationTokens: 0,
            costUsd: null,
            costSource: 'unknown',
            firstTokenMs: null,
            totalMs: null
        }
        return {
            outcome: 'recovered',
            events,
            usage,
            lastSourceSeq: lastLine,
            sourceFile,
            recoveredLines
        }
    } catch (err) {
        return {
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err)
        }
    }
}
