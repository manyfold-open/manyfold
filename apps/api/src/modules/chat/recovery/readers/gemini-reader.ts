import type {
    AgentFramework,
    ChatContentBlock
} from '@manyfold/shared'
import type {
    CandidateContext,
    CandidateSession,
    ReaderContext,
    ReaderResult,
    RecoveredMessage,
    SessionReader
} from './types'
import { shellEscape } from '../recovery-fs'
import {
    jsonStringField,
    mtimeIso,
    scanCandidateFiles
} from './candidate-scan'
import {
    geminiSessionLocateScript,
    reconstructGeminiSessionJsonl
} from '../turn-gemini-session-recovery'

const GEMINI_RECOVERY_PARSER_NAME = 'gemini-session-json'
const GEMINI_RECOVERY_JSONL_PARSER_NAME = 'gemini-session-jsonl'
const GEMINI_RECOVERY_PARSER_VERSION = '1'

// gemini-cli ≥0.45 writes append-only session-<ts>-<8char-id>.jsonl (only the
// first 8 chars of the session id are in the filename, so the full id must be
// matched in the metadata line); older CLIs wrote the full id into a
// whole-file session-*.json name. Try the new format first; the caller takes
// the first line of output.
export const geminiReaderLocateScript = (ref: string): string =>
    [
        geminiSessionLocateScript(ref),
        `find "$HOME"/.gemini/tmp -type f -path '*chats/*' -name ${shellEscape(`*${ref}*.json`)} 2>/dev/null | head -1`
    ].join('\n')

export class GeminiCliSessionReader implements SessionReader {
    readonly framework: AgentFramework = 'gemini-cli'

    async readMessages(ctx: ReaderContext): Promise<ReaderResult> {
        const sourceFile = await ctx.fs.locate(
            geminiReaderLocateScript(ctx.frameworkSessionRef)
        )
        if (!sourceFile)
            return {
                sourceFile: null,
                messages: [],
                warnings: [
                    `gemini session file for ${ctx.frameworkSessionRef} not found under ~/.gemini/tmp/`
                ]
            }

        let text: string | null
        try {
            text = await ctx.fs.readFile(sourceFile)
        } catch (err) {
            return {
                sourceFile,
                messages: [],
                warnings: [
                    `failed to read ${sourceFile}: ${(err as Error).message}`
                ]
            }
        }
        if (text === null)
            return {
                sourceFile,
                messages: [],
                warnings: [`failed to read ${sourceFile}`]
            }

        const { messages, warnings } = sourceFile.endsWith('.jsonl')
            ? parseGeminiJsonl(text, sourceFile)
            : parseGeminiJson(text, sourceFile)
        return { sourceFile, messages, warnings }
    }

    async listCandidates(ctx: CandidateContext): Promise<CandidateSession[]> {
        const heads = await scanCandidateFiles(
            ctx.fs,
            `find "$HOME"/.gemini/tmp -type f -path '*chats/*' \\( -name 'session-*.json' -o -name 'session-*.jsonl' \\)`
        )
        const out: CandidateSession[] = []
        for (const head of heads) {
            const summary = head.path.endsWith('.jsonl')
                ? summarizeGeminiJsonl(head.headText)
                : head.truncated
                  ? summarizeGeminiHead(head.headText)
                  : summarizeGemini(head.headText)
            if (summary.sessionRef)
                out.push({
                    sessionRef: summary.sessionRef,
                    sourceFile: head.path,
                    firstUserMessage: summary.firstUserMessage,
                    timestamp: summary.timestamp ?? mtimeIso(head),
                    messageCount:
                        head.truncated && head.path.endsWith('.jsonl')
                            ? head.lineCount
                            : summary.messageCount
                })
        }
        return out
    }
}

// A truncated head of the legacy whole-file JSON format no longer parses;
// pull the identity fields out lexically instead of dropping the candidate.
const summarizeGeminiHead = (
    text: string
): {
    sessionRef: string | null
    firstUserMessage: string | null
    timestamp: string | null
    messageCount: number
} => ({
    sessionRef: jsonStringField(text, 'sessionId'),
    firstUserMessage: null,
    timestamp: jsonStringField(text, 'startTime'),
    messageCount: 0
})

const summarizeGemini = (
    text: string
): {
    sessionRef: string | null
    firstUserMessage: string | null
    timestamp: string | null
    messageCount: number
} => {
    try {
        const parsed = JSON.parse(text) as GeminiSession
        const sessionRef =
            typeof parsed.sessionId === 'string' ? parsed.sessionId : null
        const messages = Array.isArray(parsed.messages) ? parsed.messages : []
        let firstUserMessage: string | null = null
        let messageCount = 0
        for (const msg of messages) {
            if (!isRecord(msg)) continue
            const type = typeof msg.type === 'string' ? msg.type : ''
            if (type !== 'user' && type !== 'gemini') continue
            messageCount++
            if (!firstUserMessage && type === 'user') {
                const t = extractGeminiText(msg.content)
                if (t) firstUserMessage = t.slice(0, 200)
            }
        }
        return {
            sessionRef,
            firstUserMessage,
            timestamp: parsed.startTime ?? null,
            messageCount
        }
    } catch {
        return {
            sessionRef: null,
            firstUserMessage: null,
            timestamp: null,
            messageCount: 0
        }
    }
}

// The CLI opens every 0.45+ session with a synthetic user message carrying the
// workspace context; it is CLI plumbing, not conversation — skip it from both
// import and candidate summaries.
const isSessionContextText = (text: string): boolean =>
    text.startsWith('<session_context>')

const summarizeGeminiJsonl = (
    text: string
): {
    sessionRef: string | null
    firstUserMessage: string | null
    timestamp: string | null
    messageCount: number
} => {
    const { messages, meta } = reconstructGeminiSessionJsonl(text)
    let firstUserMessage: string | null = null
    let messageCount = 0
    for (const m of messages) {
        if (m.type !== 'user' && m.type !== 'gemini') continue
        const t = extractGeminiText(m.content)
        if (m.type === 'user' && isSessionContextText(t)) continue
        messageCount++
        if (!firstUserMessage && m.type === 'user' && t)
            firstUserMessage = t.slice(0, 200)
    }
    return {
        sessionRef: meta?.sessionId ?? null,
        firstUserMessage,
        timestamp: meta?.startTime ?? null,
        messageCount
    }
}

export const parseGeminiJsonl = (
    text: string,
    sourceFile?: string | null
): { messages: RecoveredMessage[]; warnings: string[] } => {
    const { messages: records, meta } = reconstructGeminiSessionJsonl(text)
    if (records.length === 0)
        return {
            messages: [],
            warnings: ['gemini session jsonl has no messages']
        }
    const messages: RecoveredMessage[] = []
    let prevExternalId: string | null = null
    for (const rec of records) {
        if (rec.type !== 'user' && rec.type !== 'gemini') continue
        let raw: Record<string, unknown>
        try {
            raw = JSON.parse(rec.raw) as Record<string, unknown>
        } catch {
            continue
        }
        const role: 'user' | 'assistant' =
            rec.type === 'user' ? 'user' : 'assistant'
        if (role === 'user' && isSessionContextText(extractGeminiText(rec.content)))
            continue
        const blocks = buildGeminiBlocks(raw)
        if (blocks.length === 0) continue
        const message: RecoveredMessage = {
            externalId: rec.id,
            parentExternalId: role === 'assistant' ? prevExternalId : null,
            role,
            contentBlocks: blocks,
            timestamp:
                rec.timestamp ?? meta?.startTime ?? new Date().toISOString(),
            sources: [
                {
                    sourceRef: meta?.sessionId ?? null,
                    sourceFile: sourceFile ?? null,
                    sourceSeq: rec.lastLine,
                    externalId: rec.id,
                    parentExternalId: role === 'assistant' ? prevExternalId : null,
                    rawFormat: 'jsonl',
                    rawText: rec.raw,
                    parserName: GEMINI_RECOVERY_JSONL_PARSER_NAME,
                    parserVersion: GEMINI_RECOVERY_PARSER_VERSION
                }
            ]
        }
        if (role === 'assistant' && rec.model) message.model = rec.model
        messages.push(message)
        prevExternalId = rec.id
    }
    return { messages, warnings: [] }
}

export const parseGeminiJson = (
    text: string,
    sourceFile?: string | null
): { messages: RecoveredMessage[]; warnings: string[] } => {
    let parsed: GeminiSession
    try {
        parsed = JSON.parse(text) as GeminiSession
    } catch (err) {
        return {
            messages: [],
            warnings: [
                `failed to parse gemini session JSON: ${(err as Error).message}`
            ]
        }
    }
    if (!Array.isArray(parsed.messages))
        return {
            messages: [],
            warnings: ['gemini session has no messages array']
        }
    const messages: RecoveredMessage[] = []
    const warnings: string[] = []
    let prevExternalId: string | null = null
    let idx = 0
    for (const msg of parsed.messages) {
        idx++
        if (!isRecord(msg)) continue
        const type = typeof msg.type === 'string' ? msg.type : ''
        if (type !== 'user' && type !== 'gemini') continue
        const role: 'user' | 'assistant' =
            type === 'user' ? 'user' : 'assistant'
        const externalId = typeof msg.id === 'string' ? msg.id : `gemini-${idx}`
        const blocks = buildGeminiBlocks(msg)
        if (blocks.length === 0) continue
        messages.push({
            externalId,
            parentExternalId: role === 'assistant' ? prevExternalId : null,
            role,
            contentBlocks: blocks,
            timestamp:
                typeof msg.timestamp === 'string'
                    ? msg.timestamp
                    : (parsed.startTime ?? new Date().toISOString()),
            sources: [
                {
                    sourceRef:
                        typeof parsed.sessionId === 'string'
                            ? parsed.sessionId
                            : null,
                    sourceFile: sourceFile ?? null,
                    sourceSeq: idx,
                    externalId,
                    parentExternalId:
                        role === 'assistant' ? prevExternalId : null,
                    rawFormat: 'json',
                    rawJson: msg,
                    parserName: GEMINI_RECOVERY_PARSER_NAME,
                    parserVersion: GEMINI_RECOVERY_PARSER_VERSION
                }
            ]
        })
        prevExternalId = externalId
    }
    return { messages, warnings }
}

interface GeminiSession {
    sessionId?: string
    startTime?: string
    lastUpdated?: string
    messages?: unknown[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

const buildGeminiBlocks = (
    msg: Record<string, unknown>
): ChatContentBlock[] => {
    const blocks: ChatContentBlock[] = []

    const thoughts = msg.thoughts
    if (Array.isArray(thoughts)) {
        for (const t of thoughts) {
            if (!isRecord(t)) continue
            const parts: string[] = []
            if (typeof t.subject === 'string' && t.subject)
                parts.push(t.subject)
            if (typeof t.description === 'string' && t.description)
                parts.push(t.description)
            const joined = parts.join('\n').trim()
            if (joined) blocks.push({ type: 'thinking', text: joined })
        }
    }

    const contentText = extractGeminiText(msg.content)
    if (contentText) blocks.push({ type: 'text', text: contentText })

    const toolCalls = msg.toolCalls
    if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
            if (!isRecord(tc)) continue
            const id = typeof tc.id === 'string' ? tc.id : null
            const name = typeof tc.name === 'string' ? tc.name : null
            if (!id || !name) continue
            blocks.push({
                type: 'tool_call',
                toolCallId: id,
                toolName: name,
                args: tc.args ?? null
            })
            const result = extractGeminiToolResult(tc.result)
            if (result !== undefined)
                blocks.push({
                    type: 'tool_result',
                    toolCallId: id,
                    result
                })
        }
    }
    return blocks
}

const extractGeminiText = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const item of content) {
        if (typeof item === 'string') parts.push(item)
        else if (isRecord(item) && typeof item.text === 'string')
            parts.push(item.text)
    }
    return parts.join('').trim() ? parts.join('') : ''
}

const extractGeminiToolResult = (result: unknown): unknown => {
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
