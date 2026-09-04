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
    RecoveredRawSource,
    SessionReader
} from './types'
import { shellEscape } from '../recovery-fs'
import {
    candidateExcerpt,
    jsonStringField,
    mtimeIso,
    scanCandidateFiles
} from './candidate-scan'
import {
    listHermesSqliteCandidates,
    readHermesSqliteSession
} from './hermes-sqlite-reader'

const HERMES_JSON_RECOVERY_PARSER_NAME = 'hermes-session-json'
const HERMES_JSON_RECOVERY_PARSER_VERSION = '1'

export class HermesSessionReader implements SessionReader {
    readonly framework: AgentFramework = 'hermes'

    async readMessages(ctx: ReaderContext): Promise<ReaderResult> {
        const sqlite = await readHermesSqliteSession(
            ctx.fs,
            ctx.frameworkSessionRef
        )
        if (sqlite && sqlite.messages.length > 0) return sqlite
        const sqliteWarnings = sqlite?.warnings ?? []

        const pattern = `*${ctx.frameworkSessionRef}*.json`
        const script = `find "$HOME"/.hermes/sessions -type f -name ${shellEscape(pattern)} 2>/dev/null | head -1`
        const sourceFile = await ctx.fs.locate(script)
        if (!sourceFile) {
            if (sqlite) return sqlite
            return {
                sourceFile: null,
                messages: [],
                warnings: [
                    `hermes session ${ctx.frameworkSessionRef} not found in state.db or ~/.hermes/sessions/`
                ]
            }
        }

        let text: string | null
        try {
            text = await ctx.fs.readFile(sourceFile)
        } catch (err) {
            return {
                sourceFile,
                messages: [],
                warnings: [
                    ...sqliteWarnings,
                    `failed to read ${sourceFile}: ${(err as Error).message}`
                ]
            }
        }
        if (text === null)
            return {
                sourceFile,
                messages: [],
                warnings: [...sqliteWarnings, `failed to read ${sourceFile}`]
            }

        const { messages, warnings } = parseHermesJson(
            text,
            sourceFile,
            ctx.frameworkSessionRef
        )
        return {
            sourceFile,
            messages,
            warnings: [...sqliteWarnings, ...warnings]
        }
    }

    async listCandidates(ctx: CandidateContext): Promise<CandidateSession[]> {
        const sqliteCandidates = await listHermesSqliteCandidates(ctx.fs)
        if (sqliteCandidates.length > 0) return sqliteCandidates

        const heads = await scanCandidateFiles(
            ctx.fs,
            `find "$HOME"/.hermes/sessions -type f -name 'session_*.json'`
        )
        const out: CandidateSession[] = []
        for (const head of heads) {
            const summary = head.truncated
                ? summarizeHermesHead(head.headText)
                : summarizeHermes(head.headText)
            const latest = head.truncated
                ? EMPTY_HERMES_LATEST
                : latestHermesJson(head.headText)
            if (summary.sessionRef)
                out.push({
                    sessionRef: summary.sessionRef,
                    sourceFile: head.path,
                    firstUserMessage: summary.firstUserMessage,
                    lastAssistantMessage: latest.lastAssistantMessage,
                    timestamp: summary.timestamp ?? mtimeIso(head),
                    lastActiveAt: latest.lastActiveAt ?? mtimeIso(head),
                    messageCount: summary.messageCount,
                    // The session JSON records no model per message.
                    model: null
                })
        }
        return out
    }
}

// A truncated whole-file session JSON no longer parses, and its messages are
// not line-delimited, so nothing can be read from its end.
const EMPTY_HERMES_LATEST: {
    lastAssistantMessage: string | null
    lastActiveAt: string | null
} = { lastAssistantMessage: null, lastActiveAt: null }

const latestHermesJson = (
    text: string
): { lastAssistantMessage: string | null; lastActiveAt: string | null } => {
    let parsed: HermesSession
    try {
        parsed = JSON.parse(text) as HermesSession
    } catch {
        return EMPTY_HERMES_LATEST
    }
    const list = Array.isArray(parsed.messages) ? parsed.messages : []
    let lastAssistantMessage: string | null = null
    let lastActiveAt: string | null = null
    for (let i = list.length - 1; i >= 0; i--) {
        const raw = list[i]
        if (!isRecord(raw)) continue
        const msg = raw as HermesMessage
        if (msg.role !== 'user' && msg.role !== 'assistant') continue
        if (!lastActiveAt && msg.timestamp) lastActiveAt = msg.timestamp
        if (msg.role !== 'assistant') continue
        if (!lastAssistantMessage)
            lastAssistantMessage = candidateExcerpt(stringContent(msg.content))
        if (lastAssistantMessage && lastActiveAt) break
    }
    return {
        lastAssistantMessage,
        lastActiveAt: lastActiveAt ?? parsed.last_updated ?? null
    }
}

// A truncated head of the whole-file session JSON no longer parses; pull the
// identity fields out lexically instead of dropping the candidate.
const summarizeHermesHead = (
    text: string
): {
    sessionRef: string | null
    firstUserMessage: string | null
    timestamp: string | null
    messageCount: number
} => ({
    sessionRef: jsonStringField(text, 'session_id'),
    firstUserMessage: null,
    timestamp: jsonStringField(text, 'session_start'),
    messageCount: 0
})

interface HermesSession {
    session_id?: string
    session_start?: string
    last_updated?: string
    messages?: unknown[]
}

interface HermesMessage {
    role?: string
    content?: unknown
    tool_calls?: unknown
    tool_call_id?: string
    name?: string
    finish_reason?: string | null
    reasoning?: string | null
    timestamp?: string
}

interface PendingAssistant {
    blocks: ChatContentBlock[]
    timestamp: string
    eventId: string
    parentExternalId: string | null
    sources: RecoveredRawSource[]
}

export const parseHermesJson = (
    text: string,
    sourceFile?: string | null,
    sourceRef?: string | null
): { messages: RecoveredMessage[]; warnings: string[] } => {
    let parsed: HermesSession
    try {
        parsed = JSON.parse(text) as HermesSession
    } catch (err) {
        return {
            messages: [],
            warnings: [
                `failed to parse hermes session JSON: ${(err as Error).message}`
            ]
        }
    }
    const list = Array.isArray(parsed.messages) ? parsed.messages : []
    const messages: RecoveredMessage[] = []
    const warnings: string[] = []
    let pending: PendingAssistant | null = null
    let lastUserExternalId: string | null = null
    let idx = 0
    let lastUserContent: string | null = null

    const flush = (): void => {
        if (pending && pending.blocks.length > 0) {
            messages.push({
                externalId: pending.eventId,
                parentExternalId: pending.parentExternalId,
                role: 'assistant',
                contentBlocks: collapseTextBlocks(pending.blocks),
                timestamp: pending.timestamp,
                sources: pending.sources
            })
        }
        pending = null
    }

    for (const raw of list) {
        idx++
        if (!isRecord(raw)) continue
        const msg = raw as HermesMessage
        const role = msg.role
        const ts =
            msg.timestamp ?? parsed.session_start ?? new Date().toISOString()
        const eventId = `hermes-${idx}`
        const source = hermesJsonSource(
            raw,
            idx,
            sourceRef ?? parsed.session_id ?? null,
            sourceFile,
            eventId,
            null
        )

        if (role === 'user') {
            const content = stringContent(msg.content)
            if (!content) continue
            // hermes sometimes duplicates the user message — dedupe consecutive identical text
            if (content === lastUserContent) continue
            lastUserContent = content
            flush()
            messages.push({
                externalId: eventId,
                parentExternalId: null,
                role: 'user',
                contentBlocks: [{ type: 'text', text: content }],
                timestamp: ts,
                sources: [source]
            })
            lastUserExternalId = eventId
            continue
        }

        if (role === 'assistant') {
            const text = stringContent(msg.content)
            const toolCalls = Array.isArray(msg.tool_calls)
                ? msg.tool_calls
                : []
            if (!text && toolCalls.length === 0) continue
            pending = pending ?? {
                blocks: [],
                timestamp: ts,
                eventId,
                parentExternalId: lastUserExternalId,
                sources: []
            }
            if (text) pending.blocks.push({ type: 'text', text })
            for (const tc of toolCalls) {
                const block = toToolCallBlock(tc)
                if (block) pending.blocks.push(block)
            }
            pending.sources.push({
                ...source,
                externalId: pending.eventId,
                parentExternalId: lastUserExternalId
            })
            continue
        }

        if (role === 'tool') {
            const callId =
                typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
            if (!callId) continue
            const result = stringContent(msg.content) ?? msg.content ?? null
            pending = pending ?? {
                blocks: [],
                timestamp: ts,
                eventId,
                parentExternalId: lastUserExternalId,
                sources: []
            }
            pending.blocks.push({
                type: 'tool_result',
                toolCallId: callId,
                result
            })
            pending.sources.push({
                ...source,
                externalId: pending.eventId,
                parentExternalId: lastUserExternalId
            })
            continue
        }

        if (role === 'system') {
            const content = stringContent(msg.content)
            if (!content) continue
            flush()
            messages.push({
                externalId: eventId,
                parentExternalId: null,
                role: 'system',
                contentBlocks: [{ type: 'text', text: content }],
                timestamp: ts,
                sources: [source]
            })
            continue
        }
    }
    flush()
    return { messages, warnings }
}

const summarizeHermes = (
    text: string
): {
    sessionRef: string | null
    firstUserMessage: string | null
    timestamp: string | null
    messageCount: number
} => {
    try {
        const parsed = JSON.parse(text) as HermesSession
        const sessionRef =
            typeof parsed.session_id === 'string' ? parsed.session_id : null
        const list = Array.isArray(parsed.messages) ? parsed.messages : []
        let firstUserMessage: string | null = null
        let messageCount = 0
        for (const raw of list) {
            if (!isRecord(raw)) continue
            const msg = raw as HermesMessage
            if (msg.role !== 'user' && msg.role !== 'assistant') continue
            messageCount++
            if (!firstUserMessage && msg.role === 'user') {
                const c = stringContent(msg.content)
                if (c) firstUserMessage = c.slice(0, 200)
            }
        }
        return {
            sessionRef,
            firstUserMessage,
            timestamp: parsed.session_start ?? parsed.last_updated ?? null,
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

const stringContent = (content: unknown): string | null => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return null
    const parts: string[] = []
    for (const item of content) {
        if (typeof item === 'string') parts.push(item)
        else if (isRecord(item) && typeof item.text === 'string')
            parts.push(item.text)
    }
    const joined = parts.join('')
    return joined.length > 0 ? joined : null
}

const toToolCallBlock = (raw: unknown): ChatContentBlock | null => {
    if (!isRecord(raw)) return null
    const id = typeof raw.id === 'string' ? raw.id : null
    const fn = isRecord(raw.function) ? raw.function : null
    const name = fn && typeof fn.name === 'string' ? fn.name : null
    if (!id || !name) return null
    let args: unknown = fn?.arguments ?? null
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args)
        } catch {
            // keep as string
        }
    }
    return {
        type: 'tool_call',
        toolCallId: id,
        toolName: name,
        args
    }
}

const hermesJsonSource = (
    rawJson: unknown,
    sourceSeq: number,
    sourceRef: string | null | undefined,
    sourceFile: string | null | undefined,
    externalId: string,
    parentExternalId: string | null
): RecoveredRawSource => ({
    sourceRef: sourceRef ?? null,
    sourceFile: sourceFile ?? null,
    sourceSeq,
    externalId,
    parentExternalId,
    rawFormat: 'json',
    rawJson,
    parserName: HERMES_JSON_RECOVERY_PARSER_NAME,
    parserVersion: HERMES_JSON_RECOVERY_PARSER_VERSION
})

const collapseTextBlocks = (blocks: ChatContentBlock[]): ChatContentBlock[] => {
    const out: ChatContentBlock[] = []
    let buffer = ''
    const flush = (): void => {
        if (buffer) {
            out.push({ type: 'text', text: buffer })
            buffer = ''
        }
    }
    for (const block of blocks) {
        if (block.type === 'text') buffer += block.text
        else {
            flush()
            out.push(block)
        }
    }
    flush()
    return out
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null
