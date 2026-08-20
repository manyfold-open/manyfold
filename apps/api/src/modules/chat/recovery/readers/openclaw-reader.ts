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
import { mtimeIso, scanCandidateFiles } from './candidate-scan'

const FIND_BASE = `find "$HOME"/.openclaw/agents/*/sessions -type f -name '*.jsonl' ! -name '*.bak-*' ! -name '*.trajectory.jsonl'`
const OPENCLAW_RPC_RECOVERY_PARSER_NAME = 'openclaw-sessions-history'
const OPENCLAW_JSONL_RECOVERY_PARSER_NAME = 'openclaw-session-jsonl'
const OPENCLAW_RECOVERY_PARSER_VERSION = '1'

export class OpenclawSessionReader implements SessionReader {
    readonly framework: AgentFramework = 'openclaw'

    async readMessages(ctx: ReaderContext): Promise<ReaderResult> {
        if (ctx.openclawRpc) {
            const rpcResult = await tryReadViaRpc(ctx)
            if (rpcResult && rpcResult.messages.length > 0) return rpcResult
            const fallback = await readViaFileScan(ctx)
            return {
                ...fallback,
                warnings: [
                    ...(rpcResult?.warnings ?? []),
                    ...fallback.warnings
                ]
            }
        }
        return readViaFileScan(ctx)
    }

    async listCandidates(ctx: CandidateContext): Promise<CandidateSession[]> {
        if (ctx.openclawRpc) {
            const rpcCandidates = await tryListViaRpc(ctx)
            if (rpcCandidates && rpcCandidates.length > 0) return rpcCandidates
        }
        return listViaFileScan(ctx)
    }
}

const tryReadViaRpc = async (
    ctx: ReaderContext
): Promise<ReaderResult | null> => {
    if (!ctx.openclawRpc) return null
    try {
        const payload = await ctx.openclawRpc.call<unknown>(
            'sessions.history',
            { sessionKey: ctx.frameworkSessionRef }
        )
        const { messages, warnings } = parseHistoryResponse(
            payload,
            ctx.frameworkSessionRef,
            `rpc:sessions.history?sessionKey=${ctx.frameworkSessionRef}`
        )
        return {
            sourceFile: `rpc:sessions.history?sessionKey=${ctx.frameworkSessionRef}`,
            messages,
            warnings
        }
    } catch (err) {
        return {
            sourceFile: null,
            messages: [],
            warnings: [
                `sessions.history rpc failed (${(err as Error).message}); falling back to file scan`
            ]
        }
    }
}

const tryListViaRpc = async (
    ctx: CandidateContext
): Promise<CandidateSession[] | null> => {
    if (!ctx.openclawRpc) return null
    try {
        const payload = await ctx.openclawRpc.call<unknown>('sessions.list', {})
        return parseSessionListResponse(payload)
    } catch {
        return null
    }
}

const readViaFileScan = async (ctx: ReaderContext): Promise<ReaderResult> => {
    const script = `${FIND_BASE} -name ${shellEscape(`${ctx.frameworkSessionRef}.jsonl`)} 2>/dev/null | head -1`
    const sourceFile = await ctx.fs.locate(script)
    if (!sourceFile)
        return {
            sourceFile: null,
            messages: [],
            warnings: [
                `openclaw session file ${ctx.frameworkSessionRef}.jsonl not found under ~/.openclaw/agents/*/sessions/`
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
    const { messages, warnings } = parseOpenclawJsonl(
        text,
        sourceFile,
        ctx.frameworkSessionRef
    )
    return { sourceFile, messages, warnings }
}

const listViaFileScan = async (
    ctx: CandidateContext
): Promise<CandidateSession[]> => {
    const heads = await scanCandidateFiles(ctx.fs, FIND_BASE)
    const out: CandidateSession[] = []
    for (const head of heads) {
        const summary = summarizeOpenclawJsonl(head.headText, head.path)
        if (summary.sessionRef)
            out.push({
                sessionRef: summary.sessionRef,
                sourceFile: head.path,
                firstUserMessage: summary.firstUserMessage,
                timestamp: summary.timestamp ?? mtimeIso(head),
                messageCount: head.truncated
                    ? head.lineCount
                    : summary.messageCount
            })
    }
    return out
}

interface OpenclawSessionsHistoryItem {
    role?: string
    content?: unknown
    timestamp?: string
    tool_calls?: unknown
    tool_call_id?: string
    name?: string
}

export const parseHistoryResponse = (
    payload: unknown,
    sourceRef?: string | null,
    sourceFile?: string | null
): { messages: RecoveredMessage[]; warnings: string[] } => {
    const items = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.messages)
          ? (payload.messages as unknown[])
          : []
    const messages: RecoveredMessage[] = []
    const warnings: string[] = []
    let idx = 0
    let pending: {
        blocks: ChatContentBlock[]
        ts: string
        id: string
        sources: RecoveredRawSource[]
    } | null = null
    let lastUserId: string | null = null

    const flush = (): void => {
        if (pending && pending.blocks.length > 0) {
            messages.push({
                externalId: pending.id,
                parentExternalId: lastUserId,
                role: 'assistant',
                contentBlocks: collapseTextBlocks(pending.blocks),
                timestamp: pending.ts,
                sources: pending.sources
            })
        }
        pending = null
    }

    for (const raw of items) {
        idx++
        if (!isRecord(raw)) continue
        const item = raw as OpenclawSessionsHistoryItem
        const ts = item.timestamp ?? new Date().toISOString()
        const eventId = `oc-${idx}`
        const source = openclawJsonSource(
            raw,
            idx,
            sourceRef,
            sourceFile,
            eventId,
            null
        )
        if (item.role === 'user') {
            const text = stringContent(item.content)
            if (!text) continue
            flush()
            messages.push({
                externalId: eventId,
                parentExternalId: null,
                role: 'user',
                contentBlocks: [{ type: 'text', text }],
                timestamp: ts,
                sources: [source]
            })
            lastUserId = eventId
            continue
        }
        if (item.role === 'assistant') {
            const text = stringContent(item.content)
            const toolCalls = Array.isArray(item.tool_calls)
                ? item.tool_calls
                : []
            if (!text && toolCalls.length === 0) continue
            pending = pending ?? { blocks: [], ts, id: eventId, sources: [] }
            if (text) pending.blocks.push({ type: 'text', text })
            for (const tc of toolCalls) {
                const block = toToolCallBlock(tc)
                if (block) pending.blocks.push(block)
            }
            pending.sources.push({
                ...source,
                externalId: pending.id,
                parentExternalId: lastUserId
            })
            continue
        }
        if (item.role === 'tool') {
            if (!item.tool_call_id) continue
            pending = pending ?? { blocks: [], ts, id: eventId, sources: [] }
            pending.blocks.push({
                type: 'tool_result',
                toolCallId: item.tool_call_id,
                result: stringContent(item.content) ?? item.content ?? null
            })
            pending.sources.push({
                ...source,
                externalId: pending.id,
                parentExternalId: lastUserId
            })
            continue
        }
        if (item.role === 'system') {
            const text = stringContent(item.content)
            if (!text) continue
            flush()
            messages.push({
                externalId: eventId,
                parentExternalId: null,
                role: 'system',
                contentBlocks: [{ type: 'text', text }],
                timestamp: ts,
                sources: [source]
            })
            continue
        }
    }
    flush()
    return { messages, warnings }
}

interface OpenclawSessionListItem {
    key?: string
    sessionKey?: string
    peer?: string
    label?: string
    messageCount?: number
    lastActivity?: string
    firstUserMessage?: string
}

const parseSessionListResponse = (payload: unknown): CandidateSession[] => {
    const items = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.sessions)
          ? (payload.sessions as unknown[])
          : isRecord(payload) && Array.isArray(payload.items)
            ? (payload.items as unknown[])
            : []
    const out: CandidateSession[] = []
    for (const raw of items) {
        if (!isRecord(raw)) continue
        const item = raw as OpenclawSessionListItem
        const sessionRef =
            (typeof item.key === 'string' && item.key) ||
            (typeof item.sessionKey === 'string' && item.sessionKey) ||
            null
        if (!sessionRef) continue
        const labelOrPeer =
            (typeof item.label === 'string' && item.label) ||
            (typeof item.peer === 'string' && item.peer) ||
            null
        out.push({
            sessionRef,
            sourceFile: `rpc:sessions.list/${sessionRef}`,
            firstUserMessage:
                (typeof item.firstUserMessage === 'string' &&
                    item.firstUserMessage) ||
                labelOrPeer,
            timestamp:
                typeof item.lastActivity === 'string'
                    ? item.lastActivity
                    : null,
            messageCount:
                typeof item.messageCount === 'number' ? item.messageCount : 0
        })
    }
    out.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
    return out
}

const openclawJsonSource = (
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
    parserName: OPENCLAW_RPC_RECOVERY_PARSER_NAME,
    parserVersion: OPENCLAW_RECOVERY_PARSER_VERSION
})

const openclawJsonlSource = (
    rawText: string,
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
    rawFormat: 'jsonl',
    rawText,
    parserName: OPENCLAW_JSONL_RECOVERY_PARSER_NAME,
    parserVersion: OPENCLAW_RECOVERY_PARSER_VERSION
})

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
    let args: unknown = fn?.arguments ?? raw.arguments ?? null
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args)
        } catch {
            // keep as string
        }
    }
    return { type: 'tool_call', toolCallId: id, toolName: name, args }
}

interface OpenclawEvent {
    type?: string
    id?: string
    parentId?: string | null
    timestamp?: string
    message?: {
        role?: string
        content?: unknown
        toolCallId?: string
        toolName?: string
    }
}

interface PendingAssistant {
    blocks: ChatContentBlock[]
    timestamp: string
    eventId: string
    parentExternalId: string | null
    sources: RecoveredRawSource[]
}

export const parseOpenclawJsonl = (
    text: string,
    sourceFile?: string | null,
    sourceRef?: string | null
): { messages: RecoveredMessage[]; warnings: string[] } => {
    const messages: RecoveredMessage[] = []
    const warnings: string[] = []
    let pending: PendingAssistant | null = null
    let lastUserExternalId: string | null = null
    let lineNo = 0

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

    for (const raw of text.split('\n')) {
        lineNo++
        const line = raw.trim()
        if (!line) continue
        let row: OpenclawEvent
        try {
            row = JSON.parse(line) as OpenclawEvent
        } catch (err) {
            warnings.push(
                `line ${lineNo}: parse error: ${(err as Error).message}`
            )
            continue
        }
        if (row.type !== 'message') continue
        const role = row.message?.role
        const ts = row.timestamp ?? new Date().toISOString()
        const id = row.id ?? `openclaw-${lineNo}`
        const source = openclawJsonlSource(
            raw.replace(/\r$/, ''),
            lineNo,
            sourceRef,
            sourceFile,
            id,
            row.parentId ?? null
        )

        if (role === 'user') {
            flush()
            const blocks = mapOpenclawContent(row.message?.content, role)
            if (blocks.length === 0) continue
            messages.push({
                externalId: id,
                parentExternalId: row.parentId ?? null,
                role: 'user',
                contentBlocks: blocks,
                timestamp: ts,
                sources: [source]
            })
            lastUserExternalId = id
            continue
        }

        if (role === 'assistant') {
            const blocks = mapOpenclawContent(row.message?.content, role)
            if (blocks.length === 0) continue
            pending = pending ?? {
                blocks: [],
                timestamp: ts,
                eventId: id,
                parentExternalId: lastUserExternalId,
                sources: []
            }
            for (const b of blocks) pending.blocks.push(b)
            pending.sources.push({
                ...source,
                externalId: pending.eventId,
                parentExternalId: lastUserExternalId
            })
            continue
        }

        if (role === 'toolResult') {
            const callId =
                typeof row.message?.toolCallId === 'string'
                    ? row.message.toolCallId
                    : ''
            const result = extractText(row.message?.content)
            if (!callId) continue
            pending = pending ?? {
                blocks: [],
                timestamp: ts,
                eventId: id,
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
    }
    flush()
    return { messages, warnings }
}

const summarizeOpenclawJsonl = (
    text: string,
    path: string
): {
    sessionRef: string | null
    firstUserMessage: string | null
    timestamp: string | null
    messageCount: number
} => {
    let sessionRef: string | null = null
    let firstUserMessage: string | null = null
    let timestamp: string | null = null
    let messageCount = 0
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        let row: OpenclawEvent
        try {
            row = JSON.parse(line) as OpenclawEvent
        } catch {
            continue
        }
        if (row.type === 'session' && !sessionRef) {
            const id = (row as { id?: string }).id
            if (typeof id === 'string') sessionRef = id
        }
        if (!timestamp && row.timestamp) timestamp = row.timestamp
        if (row.type !== 'message') continue
        const role = row.message?.role
        if (role !== 'user' && role !== 'assistant') continue
        messageCount++
        if (!firstUserMessage && role === 'user') {
            const text = extractText(row.message?.content)
            if (text) firstUserMessage = text.slice(0, 200)
        }
    }
    if (!sessionRef) {
        const m = path.match(/([0-9a-f-]{36})\.jsonl$/i)
        if (m) sessionRef = m[1]
    }
    return { sessionRef, firstUserMessage, timestamp, messageCount }
}

const mapOpenclawContent = (
    content: unknown,
    role: string
): ChatContentBlock[] => {
    if (typeof content === 'string') {
        const trimmed = content.trim()
        return trimmed ? [{ type: 'text', text: content }] : []
    }
    if (!Array.isArray(content)) return []
    const blocks: ChatContentBlock[] = []
    for (const item of content) {
        if (!isRecord(item)) continue
        const t = stringField(item, 'type')
        if (t === 'text' && typeof item.text === 'string' && item.text)
            blocks.push({ type: 'text', text: item.text })
        else if (
            role === 'assistant' &&
            t === 'toolCall' &&
            typeof item.id === 'string' &&
            typeof item.name === 'string'
        )
            blocks.push({
                type: 'tool_call',
                toolCallId: item.id,
                toolName: item.name,
                args: item.arguments ?? null
            })
    }
    return blocks
}

const extractText = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const item of content) {
        if (isRecord(item) && typeof item.text === 'string')
            parts.push(item.text)
    }
    return parts.join('')
}

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

const stringField = (
    obj: Record<string, unknown>,
    key: string
): string | null => {
    const value = obj[key]
    return typeof value === 'string' ? value : null
}
