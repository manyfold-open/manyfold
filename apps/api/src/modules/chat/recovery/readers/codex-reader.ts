import type {
    AgentFramework,
    ChatContentBlock
} from '@manyfold/shared'
import type {
    CandidateContext,
    CandidateListing,
    CandidateSession,
    ReaderContext,
    ReaderResult,
    RecoveredMessage,
    RecoveredRawSource,
    SessionReader
} from './types'
import { shellEscape } from '../recovery-fs'
import {
    CANDIDATE_SCAN_LIMIT,
    candidateExcerpt,
    candidateTailLines,
    mtimeIso,
    scanCandidates,
    type CandidateFileHead
} from './candidate-scan'

const CODEX_RECOVERY_PARSER_NAME = 'codex-session-jsonl'
const CODEX_RECOVERY_PARSER_VERSION = '1'

const CODEX_FIND = `find "$HOME"/.codex/sessions -type f -name 'rollout-*.jsonl'`

export class CodexSessionReader implements SessionReader {
    readonly framework: AgentFramework = 'codex'

    async readMessages(ctx: ReaderContext): Promise<ReaderResult> {
        const pattern = `*${ctx.frameworkSessionRef}*.jsonl`
        const script = `find "$HOME"/.codex/sessions -type f -name ${shellEscape(pattern)} 2>/dev/null | head -1`
        const sourceFile = await ctx.fs.locate(script)
        if (!sourceFile)
            return {
                sourceFile: null,
                messages: [],
                warnings: [
                    `codex rollout file for thread=${ctx.frameworkSessionRef} not found under ~/.codex/sessions/`
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

        const fallbackModel = await readCodexConfigModel(ctx)
        const { messages, warnings } = parseCodexJsonl(
            text,
            sourceFile,
            ctx.frameworkSessionRef,
            fallbackModel
        )
        return { sourceFile, messages, warnings }
    }

    async listCandidates(ctx: CandidateContext): Promise<CandidateListing> {
        return scanCandidates(ctx.fs, CODEX_FIND, {
            agentId: ctx.agentId,
            limit: ctx.limit ?? CANDIDATE_SCAN_LIMIT,
            cache: ctx.cache,
            summarize: summarizeCodexCandidate,
            refFromPath: codexRefFromPath
        })
    }
}

// rollout-<timestamp>-<thread id>.jsonl; readMessages locates a thread by the
// same substring.
const ROLLOUT_THREAD_ID =
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
export const codexRefFromPath = (path: string): string | null =>
    path.match(ROLLOUT_THREAD_ID)?.[1] ?? null

const summarizeCodexCandidate = (
    head: CandidateFileHead
): CandidateSession | null => {
    const summary = summarizeCodexJsonl(head.headText)
    if (!summary.sessionRef) return null
    const latest = latestCodexEntries(candidateTailLines(head))
    return {
        sessionRef: summary.sessionRef,
        sourceFile: head.path,
        firstUserMessage: summary.firstUserMessage,
        lastAssistantMessage: latest.lastAssistantMessage,
        timestamp: summary.timestamp ?? mtimeIso(head),
        lastActiveAt: latest.lastActiveAt ?? mtimeIso(head),
        messageCount: head.truncated ? head.lineCount : summary.messageCount,
        // The model is announced near the start of a rollout, so a tail
        // window usually has none; fall back to the head rather than to
        // config.toml, which would cost a second remote read per candidate.
        model:
            latest.model ?? latestCodexEntries(head.headText.split('\n')).model
    }
}

const latestCodexEntries = (
    lines: string[]
): {
    lastAssistantMessage: string | null
    lastActiveAt: string | null
    model: string | null
} => {
    let lastAssistantMessage: string | null = null
    let lastActiveAt: string | null = null
    let model: string | null = null
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        let row: CodexEvent
        try {
            row = JSON.parse(line) as CodexEvent
        } catch {
            continue
        }
        if (!model) model = extractCodexEventModel(row)
        if (row.type !== 'response_item' || !isRecord(row.payload)) continue
        if (!lastActiveAt && row.timestamp) lastActiveAt = row.timestamp
        const payload = row.payload
        if (stringField(payload, 'type') !== 'message') continue
        if (stringField(payload, 'role') !== 'assistant') continue
        if (!lastAssistantMessage)
            lastAssistantMessage = candidateExcerpt(
                extractCodexText(payload.content)
            )
    }
    return { lastAssistantMessage, lastActiveAt, model }
}

const summarizeCodexJsonl = (
    text: string
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
        let row: CodexEvent
        try {
            row = JSON.parse(line) as CodexEvent
        } catch {
            continue
        }
        if (
            row.type === 'session_meta' &&
            isRecord(row.payload) &&
            typeof row.payload.id === 'string' &&
            !sessionRef
        )
            sessionRef = row.payload.id as string
        if (!timestamp && row.timestamp) timestamp = row.timestamp
        if (row.type !== 'response_item' || !isRecord(row.payload)) continue
        const payload = row.payload
        if (stringField(payload, 'type') !== 'message') continue
        const role = stringField(payload, 'role')
        if (role !== 'user' && role !== 'assistant') continue
        const text = extractCodexText(payload.content)
        if (!text) continue
        messageCount++
        if (!firstUserMessage && role === 'user')
            firstUserMessage = text.slice(0, 200)
    }
    return { sessionRef, firstUserMessage, timestamp, messageCount }
}

export const parseCodexJsonl = (
    text: string,
    sourceFile?: string | null,
    sourceRef?: string | null,
    fallbackModel?: string | null
): { messages: RecoveredMessage[]; warnings: string[] } => {
    const messages: RecoveredMessage[] = []
    const warnings: string[] = []
    let pending: PendingAssistant | null = null
    let currentModel = normalizeModel(fallbackModel)

    const flush = (): void => {
        if (pending && pending.blocks.length > 0) {
            messages.push({
                externalId: `codex-asst-${pending.lineNo}`,
                parentExternalId: pending.parentExternalId,
                role: 'assistant',
                contentBlocks: collapseTextBlocks(pending.blocks),
                timestamp: pending.timestamp,
                model: pending.model,
                sources: pending.sources
            })
        }
        pending = null
    }

    let lineNo = 0
    let lastUserExternalId: string | null = null
    for (const raw of text.split('\n')) {
        lineNo++
        const line = raw.trim()
        if (!line) continue
        let row: CodexEvent
        try {
            row = JSON.parse(line) as CodexEvent
        } catch (err) {
            warnings.push(
                `line ${lineNo}: parse error: ${(err as Error).message}`
            )
            continue
        }
        const eventModel = extractCodexEventModel(row)
        if (eventModel) {
            currentModel = eventModel
            if (pending) pending.model = eventModel
        }
        if (row.type !== 'response_item' || !isRecord(row.payload)) continue
        const payload = row.payload
        const itemType = stringField(payload, 'type')
        const ts = row.timestamp ?? new Date().toISOString()
        const rawSource = codexRawSource(
            raw.replace(/\r$/, ''),
            lineNo,
            sourceFile,
            sourceRef,
            row,
            payload
        )

        if (itemType === 'message') {
            const role = stringField(payload, 'role')
            if (role !== 'user' && role !== 'assistant') continue
            const messageText = extractCodexText(payload.content)
            if (!messageText) continue
            if (role === 'user') {
                flush()
                const externalId = `codex-user-${lineNo}`
                messages.push({
                    externalId,
                    parentExternalId: null,
                    role: 'user',
                    contentBlocks: [{ type: 'text', text: messageText }],
                    timestamp: ts,
                    sources: [
                        {
                            ...rawSource,
                            externalId
                        }
                    ]
                })
                lastUserExternalId = externalId
            } else {
                pending = pending ?? {
                    blocks: [],
                    timestamp: ts,
                    lineNo,
                    parentExternalId: lastUserExternalId,
                    model: currentModel,
                    sources: []
                }
                pending.blocks.push({ type: 'text', text: messageText })
                pending.sources.push({
                    ...rawSource,
                    externalId: `codex-asst-${pending.lineNo}`,
                    parentExternalId: lastUserExternalId
                })
            }
            continue
        }

        if (
            itemType === 'function_call' &&
            typeof payload.call_id === 'string'
        ) {
            pending = pending ?? {
                blocks: [],
                timestamp: ts,
                lineNo,
                parentExternalId: lastUserExternalId,
                model: currentModel,
                sources: []
            }
            const args =
                typeof payload.arguments === 'string'
                    ? (safeParseJson(payload.arguments) ?? payload.arguments)
                    : (payload.arguments ?? null)
            pending.blocks.push({
                type: 'tool_call',
                toolCallId: payload.call_id as string,
                toolName:
                    typeof payload.name === 'string'
                        ? payload.name
                        : 'function_call',
                args
            })
            pending.sources.push({
                ...rawSource,
                externalId: `codex-asst-${pending.lineNo}`,
                parentExternalId: lastUserExternalId
            })
            continue
        }

        if (
            itemType === 'function_call_output' &&
            typeof payload.call_id === 'string'
        ) {
            pending = pending ?? {
                blocks: [],
                timestamp: ts,
                lineNo,
                parentExternalId: lastUserExternalId,
                model: currentModel,
                sources: []
            }
            pending.blocks.push({
                type: 'tool_result',
                toolCallId: payload.call_id as string,
                result: payload.output ?? null
            })
            pending.sources.push({
                ...rawSource,
                externalId: `codex-asst-${pending.lineNo}`,
                parentExternalId: lastUserExternalId
            })
            continue
        }

        if (itemType === 'reasoning') {
            const reasoning = extractReasoningText(payload)
            if (reasoning) {
                pending = pending ?? {
                    blocks: [],
                    timestamp: ts,
                    lineNo,
                    parentExternalId: lastUserExternalId,
                    model: currentModel,
                    sources: []
                }
                pending.blocks.push({ type: 'thinking', text: reasoning })
                pending.sources.push({
                    ...rawSource,
                    externalId: `codex-asst-${pending.lineNo}`,
                    parentExternalId: lastUserExternalId
                })
            }
            continue
        }
    }
    flush()
    return { messages, warnings }
}

interface PendingAssistant {
    blocks: ChatContentBlock[]
    timestamp: string
    lineNo: number
    parentExternalId: string | null
    model: string | null
    sources: RecoveredRawSource[]
}

interface CodexEvent {
    timestamp?: string
    type?: string
    payload?: unknown
    model?: unknown
    model_name?: unknown
    turn?: unknown
    usage?: unknown
    response?: unknown
    item?: unknown
}

const readCodexConfigModel = async (
    ctx: ReaderContext
): Promise<string | null> => {
    const script = [
        `codex_home="\${CODEX_HOME:-$HOME/.codex}"`,
        `if [ -f "$codex_home/config.toml" ]; then printf '%s\\n' "$codex_home/config.toml"; elif [ -f "$HOME/.codex/config.toml" ]; then printf '%s\\n' "$HOME/.codex/config.toml"; fi`
    ].join('; ')
    const configPath = await ctx.fs.locate(script)
    if (!configPath) return null
    const text = await ctx.fs.readFile(configPath)
    return text === null ? null : extractCodexConfigModel(text)
}

const extractCodexConfigModel = (text: string): string | null => {
    const match = text.match(
        /^\s*model\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s#]+))/m
    )
    const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? null
    if (!raw) return null
    return normalizeModel(raw.replace(/\\(["'\\])/g, '$1'))
}

const extractCodexEventModel = (row: CodexEvent): string | null => {
    const payload = isRecord(row.payload) ? row.payload : null
    const turn = isRecord(row.turn) ? row.turn : null
    const usage = isRecord(row.usage) ? row.usage : null
    const response = isRecord(row.response) ? row.response : null
    const item = isRecord(row.item) ? row.item : null
    const payloadTurn = payload && isRecord(payload.turn) ? payload.turn : null
    const payloadUsage =
        payload && isRecord(payload.usage) ? payload.usage : null
    const payloadResponse =
        payload && isRecord(payload.response) ? payload.response : null
    const payloadItem = payload && isRecord(payload.item) ? payload.item : null

    return firstModel([
        row.model,
        row.model_name,
        turn?.model,
        turn?.model_name,
        usage?.model,
        usage?.model_name,
        response?.model,
        response?.model_name,
        item?.model,
        item?.model_name,
        payload?.model,
        payload?.model_name,
        payloadTurn?.model,
        payloadTurn?.model_name,
        payloadUsage?.model,
        payloadUsage?.model_name,
        payloadResponse?.model,
        payloadResponse?.model_name,
        payloadItem?.model,
        payloadItem?.model_name
    ])
}

const firstModel = (values: unknown[]): string | null => {
    for (const value of values) {
        const model = normalizeModel(value)
        if (model) return model
    }
    return null
}

const normalizeModel = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const codexRawSource = (
    rawLine: string,
    lineNo: number,
    sourceFile: string | null | undefined,
    sourceRef: string | null | undefined,
    row: CodexEvent,
    payload: Record<string, unknown>
): RecoveredRawSource => ({
    sourceRef:
        sourceRef ??
        (isRecord(row.payload) && typeof row.payload.thread_id === 'string'
            ? row.payload.thread_id
            : null),
    sourceFile: sourceFile ?? null,
    sourceSeq: lineNo,
    externalId:
        stringField(payload, 'id') ??
        stringField(payload, 'call_id') ??
        `codex-${lineNo}`,
    parentExternalId: null,
    rawFormat: 'jsonl',
    rawText: rawLine,
    parserName: CODEX_RECOVERY_PARSER_NAME,
    parserVersion: CODEX_RECOVERY_PARSER_VERSION
})

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

const stringField = (
    obj: Record<string, unknown>,
    key: string
): string | null => {
    const value = obj[key]
    return typeof value === 'string' ? value : null
}

const extractCodexText = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const item of content) {
        if (!isRecord(item)) continue
        const t = stringField(item, 'type')
        if (
            (t === 'input_text' || t === 'output_text' || t === 'text') &&
            typeof item.text === 'string'
        )
            parts.push(item.text)
    }
    return parts.join('').trim() ? parts.join('') : ''
}

const extractReasoningText = (payload: Record<string, unknown>): string => {
    const summary = payload.summary
    if (Array.isArray(summary)) {
        const parts: string[] = []
        for (const item of summary) {
            if (isRecord(item) && typeof item.text === 'string')
                parts.push(item.text)
        }
        if (parts.length > 0) return parts.join('\n')
    }
    const content = payload.content
    if (Array.isArray(content)) {
        const parts: string[] = []
        for (const item of content) {
            if (isRecord(item) && typeof item.text === 'string')
                parts.push(item.text)
        }
        if (parts.length > 0) return parts.join('\n')
    }
    return ''
}

const safeParseJson = (s: string): unknown => {
    try {
        return JSON.parse(s)
    } catch {
        return null
    }
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
        if (block.type === 'text') {
            buffer += block.text
        } else {
            flush()
            out.push(block)
        }
    }
    flush()
    return out
}
