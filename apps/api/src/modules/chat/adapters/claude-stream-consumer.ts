import type { ChatUsage } from '@manyfold/shared'
import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'
import type { TurnSeenState } from '@/modules/chat/recovery/turn-jsonl-recovery'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import {
    extractClaudeCodeUsage,
    type StreamJsonLine
} from './claude-code-usage'

// The claude stream-json line consumer, extracted from the adapter's
// sendMessage closure so cross-process turn adoption can re-run the SAME
// consumption over an exec re-attach's byte-0 stdout replay. One consumer =
// one exec's stdout: it owns the per-turn parse state (delta coalescing, seen
// tracking for recovery, usage/result capture) and yields the semantic events;
// transport, persistence and error-recovery stay with the caller.

export const CLAUDE_STREAM_PARSER_NAME = 'claude-code-stream-json'
export const CLAUDE_STREAM_PARSER_VERSION = '1'

// Partial-message deltas coalesce until either cap so a fast model stream
// becomes at most ~7 events/sec, keeping stream-event DB writes bounded until
// the broadcaster itself batches. 512 chars ≈ a short paragraph per flush.
const PARTIAL_DELTA_FLUSH_CHARS = 512
const PARTIAL_DELTA_FLUSH_MS = 150

export const redactSecrets = (value: string): string =>
    value
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(
            /\b(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)=\S+/gi,
            '$1=[REDACTED]'
        )
        .replace(/eyJ[A-Za-z0-9._-]+/g, '[REDACTED_JWT]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')

export const parseLine = (line: string): StreamJsonLine | null => {
    try {
        return JSON.parse(line) as StreamJsonLine
    } catch {
        return null
    }
}

export const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null

export const formatClaudeResultError = (parsed: StreamJsonLine): string => {
    const subtype = parsed.subtype ? ` (${parsed.subtype})` : ''
    const detail = parsed.result?.trim()
    if (detail) return `${redactSecrets(detail).slice(0, 512)}${subtype}`
    if (parsed.subtype)
        return `claude returned is_error=true (${parsed.subtype})`
    return 'claude returned is_error=true (no detail; check API logs)'
}

export type ClaudeTerminalErrorMark = { __terminalError: true }

export interface ClaudeStreamConsumer {
    // Consume one trimmed stdout line (rawLine keeps the original bytes for the
    // raw_source cache). Increments the internal source seq per line.
    consume(
        line: string,
        rawLine: string
    ): Generator<EmittedChatEvent | ClaudeTerminalErrorMark>
    // Flush any coalesced-but-unemitted partial delta text.
    flushDeltas(): Generator<EmittedChatEvent>
    readonly seen: TurnSeenState
    readonly sourceSeq: number
    readonly sawResultLine: boolean
    readonly pendingUsage: ChatUsage | null
    readonly errorLast: StreamJsonLine | null
    readonly frameworkSessionRef: string | null
    readonly tFirstToken: number | null
}

export const createClaudeStreamConsumer = (opts: {
    model: string | null
    initialSessionRef: string | null
    tStart: number
}): ClaudeStreamConsumer => {
    let frameworkSessionRef: string | null = opts.initialSessionRef
    let tFirstToken: number | null = null
    let pendingUsage: ChatUsage | null = null
    let sourceSeq = 0
    let sawResultLine = false
    let errorLast: StreamJsonLine | null = null
    // Tracks what the live stream already emitted so a post-reap JSONL
    // recovery can emit only the missing tail exactly once (see #330).
    const seen: TurnSeenState = {
        uuids: new Set<string>(),
        apiMessageIds: new Set<string>(),
        toolCallIds: new Set<string>(),
        deltaRuns: []
    }

    // Contiguous partial-message deltas coalesce into one token/thinking
    // event, flushed on the size/age caps or before any non-delta line, so
    // per-event downstream work (stream-event INSERT, SSE frame) stays
    // bounded no matter how finely the model streams.
    let pendingDelta: {
        kind: 'token' | 'thinking'
        text: string
        startedAt: number
    } | null = null
    let sawTopLevelDeltas = false

    const markFirstToken = (): void => {
        if (tFirstToken === null) tFirstToken = Date.now()
    }

    const flushPendingDelta = function* (): Generator<EmittedChatEvent> {
        if (!pendingDelta) return
        const { kind, text } = pendingDelta
        pendingDelta = null
        // Record what we actually streamed for the in-flight block; recovery
        // uses it to skip the already-shown prefix. Merge consecutive same-
        // kind flushes so one block is one run. Cleared when the block's
        // complete assistant line arrives (below).
        const lastRun = seen.deltaRuns[seen.deltaRuns.length - 1]
        if (lastRun && lastRun.kind === kind) lastRun.text += text
        else seen.deltaRuns.push({ kind, text })
        if (kind === 'token') markFirstToken()
        yield kind === 'token'
            ? { type: 'token', text }
            : { type: 'thinking', text }
    }

    const consumeLine = function* (
        line: string,
        rawLine: string,
        seq: number
    ): Generator<EmittedChatEvent | ClaudeTerminalErrorMark> {
        const parsed = parseLine(line)
        if (!parsed) return
        if (parsed.type === 'stream_event') {
            // Deltas are display-only: complete assistant/result lines stay
            // the durable source, so stream_event lines skip the raw_source
            // cache (each would be its own DB upsert). Subagent streams
            // (parent_tool_use_id set) keep block-level via complete lines.
            if (parsed.parent_tool_use_id != null) return
            const delta =
                parsed.event?.type === 'content_block_delta'
                    ? parsed.event.delta
                    : null
            const kind =
                delta?.type === 'text_delta'
                    ? ('token' as const)
                    : delta?.type === 'thinking_delta'
                      ? ('thinking' as const)
                      : null
            const text = kind === 'token' ? delta?.text : delta?.thinking
            if (!kind || typeof text !== 'string' || text.length === 0) {
                // content_block_stop / message_stop mark a boundary — flush
                // so a trailing fragment is not stuck waiting for the next
                // line.
                yield* flushPendingDelta()
                return
            }
            sawTopLevelDeltas = true
            if (pendingDelta && pendingDelta.kind !== kind)
                yield* flushPendingDelta()
            if (!pendingDelta)
                pendingDelta = { kind, text: '', startedAt: Date.now() }
            pendingDelta.text += text
            if (
                pendingDelta.text.length >= PARTIAL_DELTA_FLUSH_CHARS ||
                Date.now() - pendingDelta.startedAt >= PARTIAL_DELTA_FLUSH_MS
            )
                yield* flushPendingDelta()
            return
        }
        yield* flushPendingDelta()
        const lineUuid = stringValue((parsed as Record<string, unknown>).uuid)
        if (lineUuid) seen.uuids.add(lineUuid)
        yield {
            type: 'raw_source',
            source: {
                sourceRef: parsed.session_id ?? opts.initialSessionRef,
                sourceSeq: seq,
                externalId: lineUuid ?? `${parsed.type ?? 'event'}-${seq}`,
                parentExternalId:
                    stringValue(
                        (parsed as Record<string, unknown>).parentUuid
                    ) ??
                    stringValue(
                        (parsed as Record<string, unknown>).parent_uuid
                    ),
                rawFormat: 'jsonl',
                rawText: rawLine,
                parserName: CLAUDE_STREAM_PARSER_NAME,
                parserVersion: CLAUDE_STREAM_PARSER_VERSION
            }
        }
        if (parsed.session_id && !frameworkSessionRef)
            frameworkSessionRef = parsed.session_id
        if (parsed.type === 'assistant' && parsed.message?.content) {
            // Once top-level deltas streamed this content, re-emitting the
            // complete blocks would duplicate it. Subagent lines
            // (parent_tool_use_id set) never stream deltas here, so they
            // keep emitting whole blocks either way.
            const suppressStreamedText =
                sawTopLevelDeltas && parsed.parent_tool_use_id == null
            if (parsed.parent_tool_use_id == null) {
                // This complete top-level line covers the deltas streamed
                // for it, so recovery of a LATER incomplete block starts
                // from a clean slate. Its message.id anchors turn recovery
                // when uuid parity between stdout and disk fails.
                seen.deltaRuns.length = 0
                const msgId = parsed.message.id
                if (msgId) seen.apiMessageIds.add(msgId)
            }
            for (const block of parsed.message.content) {
                if (
                    block.type === 'text' &&
                    typeof block.text === 'string' &&
                    !suppressStreamedText
                ) {
                    markFirstToken()
                    yield { type: 'token', text: block.text }
                }
                if (
                    block.type === 'thinking' &&
                    typeof block.text === 'string' &&
                    !suppressStreamedText
                )
                    yield { type: 'thinking', text: block.text }
                if (
                    block.type === 'tool_use' &&
                    typeof block.id === 'string' &&
                    typeof block.name === 'string'
                ) {
                    seen.toolCallIds.add(block.id)
                    yield {
                        type: 'tool_call',
                        toolCallId: block.id,
                        toolName: block.name,
                        args: block.input ?? null
                    }
                }
            }
        }
        if (parsed.type === 'user' && parsed.message?.content) {
            for (const block of parsed.message.content) {
                if (
                    block.type === 'tool_result' &&
                    typeof block.tool_use_id === 'string'
                ) {
                    seen.toolCallIds.add(block.tool_use_id)
                    yield {
                        type: 'tool_result',
                        toolCallId: block.tool_use_id,
                        result: block.content ?? block
                    }
                }
            }
        }
        if (parsed.type === 'result') {
            sawResultLine = true
            pendingUsage = extractClaudeCodeUsage(
                parsed,
                opts.model,
                opts.tStart,
                tFirstToken
            )
            if (parsed.is_error) {
                errorLast = parsed
                const message = formatClaudeResultError(parsed)
                const managedChannelFailure =
                    classifyManagedChannelFailureSignal({
                        status: /API Error:\s*503\b/.test(message) ? 503 : null,
                        message
                    })
                yield {
                    type: 'error',
                    ...(managedChannelFailure ? { managedChannelFailure } : {}),
                    error: {
                        code: 'claude_result_error',
                        message,
                        retryable: false
                    }
                }
                yield { __terminalError: true }
            }
        }
    }

    return {
        consume: (line, rawLine) => consumeLine(line, rawLine, ++sourceSeq),
        flushDeltas: () => flushPendingDelta(),
        get seen() {
            return seen
        },
        get sourceSeq() {
            return sourceSeq
        },
        get sawResultLine() {
            return sawResultLine
        },
        get pendingUsage() {
            return pendingUsage
        },
        get errorLast() {
            return errorLast
        },
        get frameworkSessionRef() {
            return frameworkSessionRef
        },
        get tFirstToken() {
            return tFirstToken
        }
    }
}
