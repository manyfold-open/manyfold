import type { ChatUsage } from '@manyfold/shared'
import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'
import type { RecoveryFs } from '@/modules/chat/recovery/recovery-fs'
import { shellEscape } from '@/modules/chat/recovery/recovery-fs'

// Recover an adopted GEMINI-CLI turn from the on-sprite session record. Unlike
// codex's rollout (explicit task_started/task_complete framing) or claude's
// per-message transcript, gemini-cli 0.45.2 writes an append-only JSONL where
// each line is either metadata, a `{$set:{...}}` patch, or a full message
// snapshot `{id,type,content,...}`. The SAME message id is appended multiple
// times as it gains tokens/toolCalls, so the conversation is reconstructed by
// replaying in order and keeping the LAST record per id (the CLI's own loader
// does exactly this). There is no turn-boundary marker: the turn is anchored
// by the triggering user message (its text is the verbatim prompt) and closed
// when its final gemini message carries usage `tokens{}` — gemini-cli records
// usage only after the assistant message completes. Content is written whole
// (not per-text-token), so recovery is per-completed-message burst, same shape
// as claude/codex.
// Measured on a real gemini-cli 0.45.2 2026-07-24: verified against a real
// .jsonl plus the installed ChatRecordingService source.

const GEMINI_SESSION_PARSER_NAME = 'gemini-session-jsonl-turn'
const GEMINI_SESSION_PARSER_VERSION = '1'

export type GeminiTurnVerdict =
    | { outcome: 'failed'; detail: string }
    | {
          outcome: 'result_lost'
          events: EmittedChatEvent[]
          lastSourceSeq: number
          sourceFile: string | null
          hasContent: boolean
          detail: string
      }
    | {
          outcome: 'recovered'
          events: EmittedChatEvent[]
          usage: ChatUsage
          lastSourceSeq: number
          sourceFile: string
          recoveredMessages: number
      }

// Find the session-*.jsonl whose metadata sessionId equals the ref. The
// filename embeds only the first 8 chars of the session id, so match the full
// id in the first (metadata) line — robust against an 8-char collision and
// against the legacy .json name the CLI migrates to .jsonl on resume. The
// pattern is plain text here; it is shell-quoted once, at the use site.
export const geminiSessionLocateScript = (ref: string): string => {
    const pat = `"sessionId":"${ref}"`
    return [
        `for f in $(find "$HOME"/.gemini/tmp -path '*chats/*' -name 'session-*.jsonl' 2>/dev/null); do`,
        `  head -1 "$f" 2>/dev/null | grep -qF ${shellEscape(pat)} && { echo "$f"; break; }`,
        `done`
    ].join('\n')
}

interface GeminiRecord {
    id?: unknown
    type?: unknown
    timestamp?: unknown
    content?: unknown
    displayContent?: unknown
    thoughts?: unknown
    tokens?: unknown
    model?: unknown
    toolCalls?: unknown
    $set?: unknown
    sessionId?: unknown
    startTime?: unknown
}

export interface GeminiMessage {
    id: string
    type: string
    timestamp: string | null
    content: unknown
    thoughts: unknown
    tokens: Record<string, unknown> | null
    model: string | null
    toolCalls: unknown
    // The 1-based line the message's LAST record landed on (for the source
    // cursor / stall detection) and that record's raw JSON (provenance).
    lastLine: number
    raw: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0

// Join gemini `content` (string | array of {text} parts) to plain text.
export const contentText = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    let out = ''
    for (const part of content) {
        if (typeof part === 'string') out += part
        else if (isRecord(part) && typeof part.text === 'string') out += part.text
    }
    return out
}

export const thoughtsText = (thoughts: unknown): string => {
    if (!Array.isArray(thoughts)) return ''
    const chunks: string[] = []
    for (const t of thoughts) {
        if (!isRecord(t)) continue
        const parts: string[] = []
        if (typeof t.subject === 'string' && t.subject) parts.push(t.subject)
        if (typeof t.description === 'string' && t.description)
            parts.push(t.description)
        const joined = parts.join('\n').trim()
        if (joined) chunks.push(joined)
    }
    return chunks.join('\n')
}

const toGeminiMessage = (
    rec: GeminiRecord,
    lastLine: number,
    raw: string
): GeminiMessage => ({
    id: String(rec.id),
    type: String(rec.type),
    timestamp: str(rec.timestamp),
    content: rec.content,
    thoughts: rec.thoughts,
    tokens: isRecord(rec.tokens) ? rec.tokens : null,
    model: str(rec.model),
    toolCalls: rec.toolCalls,
    lastLine,
    raw
})

export interface GeminiSessionJsonlMeta {
    sessionId: string | null
    startTime: string | null
}

// Replay the JSONL and reconstruct the message list (last record per id wins,
// `$set.messages` replaces the list wholesale — mirrors the CLI loader). Also
// shared by the session-import gemini reader, so the 0.45.2 format has one
// authoritative decoder.
export const reconstructGeminiSessionJsonl = (
    text: string
): {
    messages: GeminiMessage[]
    lastLine: number
    meta: GeminiSessionJsonlMeta | null
} => {
    let messages: GeminiMessage[] = []
    const indexById = new Map<string, number>()
    let meta: GeminiSessionJsonlMeta | null = null
    let lineNo = 0
    for (const rawLine of text.split('\n')) {
        lineNo++
        const line = rawLine.trim()
        if (!line) continue
        let rec: unknown
        try {
            rec = JSON.parse(line)
        } catch {
            continue
        }
        if (!isRecord(rec)) continue
        const r = rec as GeminiRecord
        if (isRecord(r.$set)) {
            const set = r.$set
            if (Array.isArray(set.messages)) {
                messages = []
                indexById.clear()
                for (const m of set.messages) {
                    if (!isRecord(m) || typeof m.id !== 'string') continue
                    indexById.set(m.id, messages.length)
                    messages.push(
                        toGeminiMessage(
                            m as GeminiRecord,
                            lineNo,
                            JSON.stringify(m)
                        )
                    )
                }
            }
            continue
        }
        // The first-line metadata record (sessionId, no message id).
        if (typeof r.id !== 'string' && typeof r.sessionId === 'string') {
            meta ??= { sessionId: r.sessionId, startTime: str(r.startTime) }
            continue
        }
        if (typeof r.id === 'string' && typeof r.type === 'string') {
            const existing = indexById.get(r.id)
            const msg = toGeminiMessage(r, lineNo, line)
            if (existing !== undefined) messages[existing] = msg
            else {
                indexById.set(r.id, messages.length)
                messages.push(msg)
            }
        }
    }
    return { messages, lastLine: lineNo, meta }
}

// A turn anchored MUCH earlier than the adopted message is a PREVIOUS turn
// (ours died before recording its user line) — same guard codex uses.
const TURN_ANCHOR_MAX_AGE_BEFORE_MESSAGE_MS = 5 * 60 * 1000

const messageEvents = (
    msg: GeminiMessage,
    sourceRef: string,
    sourceFile: string
): EmittedChatEvent[] => {
    const out: EmittedChatEvent[] = []
    out.push({
        type: 'raw_source',
        source: {
            sourceRef,
            sourceFile,
            sourceSeq: msg.lastLine,
            externalId: msg.id,
            parentExternalId: null,
            rawFormat: 'jsonl',
            rawText: msg.raw,
            parserName: GEMINI_SESSION_PARSER_NAME,
            parserVersion: GEMINI_SESSION_PARSER_VERSION
        }
    })
    const think = thoughtsText(msg.thoughts)
    if (think) out.push({ type: 'thinking', text: think })
    const text = contentText(msg.content)
    if (text) out.push({ type: 'token', text })
    if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
            if (!isRecord(tc)) continue
            const id = str(tc.id) ?? str(tc.toolCallId)
            const name = str(tc.name) ?? str(tc.toolName)
            if (!id || !name) continue
            out.push({
                type: 'tool_call',
                toolCallId: id,
                toolName: name,
                args: tc.args ?? tc.input ?? null
            })
            const result = geminiToolResult(tc.result)
            if (result !== undefined)
                out.push({ type: 'tool_result', toolCallId: id, result })
        }
    }
    return out
}

const geminiToolResult = (result: unknown): unknown => {
    if (result === null || result === undefined) return undefined
    if (!Array.isArray(result)) return result
    const parts: unknown[] = []
    for (const r of result) {
        if (
            isRecord(r) &&
            isRecord(r.functionResponse) &&
            isRecord(r.functionResponse.response)
        )
            parts.push(
                r.functionResponse.response.output ??
                    r.functionResponse.response
            )
        else parts.push(r)
    }
    return parts.length === 1 ? parts[0] : parts
}

const usageFromTokens = (
    tokens: Record<string, unknown> | null,
    model: string | null
): ChatUsage => ({
    model,
    inputTokens: toInt(tokens?.input),
    outputTokens: toInt(tokens?.output),
    cacheReadTokens: toInt(tokens?.cached),
    cacheCreationTokens: 0,
    costUsd: null,
    costSource: 'unknown',
    firstTokenMs: null,
    totalMs: null
})

export const recoverTurnFromGeminiSession = async (args: {
    fs: RecoveryFs
    frameworkSessionRef: string
    promptText: string
    model: string | null
    messageCreatedAt?: Date
}): Promise<GeminiTurnVerdict> => {
    try {
        const sourceFile = await args.fs.locate(
            geminiSessionLocateScript(args.frameworkSessionRef)
        )
        if (!sourceFile)
            return { outcome: 'failed', detail: 'session file not found' }
        const text = await args.fs.readFile(sourceFile)
        if (text === null)
            return { outcome: 'failed', detail: `read failed: ${sourceFile}` }

        const { messages, lastLine } = reconstructGeminiSessionJsonl(text)

        // Anchor on the LAST user message whose text is the prompt we sent.
        // gemini does not wrap the prompt (unlike codex history composition), so
        // it matches verbatim. A session_context synthetic user message never
        // matches the real prompt, so the anchor lands on the true trigger.
        let anchorIdx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]
            if (m.type !== 'user') continue
            if (!args.promptText || contentText(m.content) === args.promptText) {
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
                hasContent: false,
                detail: args.promptText
                    ? 'prompt not found in session'
                    : 'no user message'
            }

        const anchorTs = messages[anchorIdx].timestamp
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
                    hasContent: false,
                    detail: 'anchored user message predates this message'
                }
        }

        const turnMessages = messages.slice(anchorIdx + 1)
        const geminiMessages = turnMessages.filter((m) => m.type === 'gemini')
        const events: EmittedChatEvent[] = []
        for (const m of turnMessages)
            events.push(
                ...messageEvents(m, args.frameworkSessionRef, sourceFile)
            )
        const hasContent = events.some((e) => e.type === 'token')

        // The turn is complete once its final gemini message carries usage
        // tokens — gemini-cli attaches those only after the message finishes.
        const lastGemini =
            geminiMessages.length > 0
                ? geminiMessages[geminiMessages.length - 1]
                : null
        if (lastGemini && lastGemini.tokens) {
            const model = lastGemini.model ?? args.model
            return {
                outcome: 'recovered',
                events,
                usage: usageFromTokens(lastGemini.tokens, model),
                lastSourceSeq: lastLine,
                sourceFile,
                recoveredMessages: turnMessages.length
            }
        }

        return {
            outcome: 'result_lost',
            events,
            lastSourceSeq: lastLine,
            sourceFile,
            hasContent,
            detail: lastGemini ? 'turn not terminal (no usage yet)' : 'no gemini message yet'
        }
    } catch (err) {
        return {
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err)
        }
    }
}
