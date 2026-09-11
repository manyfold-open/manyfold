import type { AgentFramework, ChatContentBlock } from '@manyfold/shared'
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

const PI_RECOVERY_PARSER_NAME = 'pi-session-jsonl'
const PI_RECOVERY_PARSER_VERSION = '1'

// pi keeps one directory per working directory under its agent dir
// (`--<cwd with / → ->--`), which the API cannot compute for a remote runtime,
// so every session file is walked; the filename carries the full session id
// (`<ISO timestamp>_<id>.jsonl`), so a ref locates its file without a read.
const PI_FIND = `find "\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"/sessions -type f -name '*.jsonl'`

const piSessionLocateScript = (sessionRef: string): string =>
    `${PI_FIND.replace(`-name '*.jsonl'`, `-name ${shellEscape(`*_${sessionRef}.jsonl`)}`)} 2>/dev/null | head -1`

export class PiSessionReader implements SessionReader {
    readonly framework: AgentFramework = 'pi'

    async readMessages(ctx: ReaderContext): Promise<ReaderResult> {
        const sourceFile = await ctx.fs.locate(
            piSessionLocateScript(ctx.frameworkSessionRef)
        )
        if (!sourceFile)
            return {
                sourceFile: null,
                messages: [],
                warnings: [
                    `pi session file for session=${ctx.frameworkSessionRef} not found under ~/.pi/agent/sessions/`
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

        return {
            sourceFile,
            ...parsePiJsonl(text, sourceFile, ctx.frameworkSessionRef)
        }
    }

    async listCandidates(ctx: CandidateContext): Promise<CandidateListing> {
        return scanCandidates(ctx.fs, PI_FIND, {
            agentId: ctx.agentId,
            limit: ctx.limit ?? CANDIDATE_SCAN_LIMIT,
            cache: ctx.cache,
            summarize: summarizePiCandidate,
            refFromPath: piRefFromPath
        })
    }
}

// `<timestamp>_<session id>.jsonl`; pi accepts ids of letters, digits, `.`,
// `-` and `_` that start and end alphanumeric — the same charset as the
// UUIDs Manyfold mints.
const PI_SESSION_FILE = /_([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\.jsonl$/
export const piRefFromPath = (path: string): string | null =>
    path.match(PI_SESSION_FILE)?.[1] ?? null

interface PiEntry {
    type?: unknown
    id?: unknown
    parentId?: unknown
    timestamp?: unknown
    version?: unknown
    cwd?: unknown
    message?: unknown
    [key: string]: unknown
}

const summarizePiCandidate = (
    head: CandidateFileHead
): CandidateSession | null => {
    const summary = summarizePiHead(head.headText)
    if (!summary.sessionRef) return null
    const latest = latestPiEntries(candidateTailLines(head))
    return {
        sessionRef: summary.sessionRef,
        sourceFile: head.path,
        firstUserMessage: summary.firstUserMessage,
        lastAssistantMessage: latest.lastAssistantMessage,
        timestamp: summary.timestamp ?? mtimeIso(head),
        lastActiveAt: latest.lastActiveAt ?? mtimeIso(head),
        messageCount: head.truncated ? head.lineCount : summary.messageCount,
        model: latest.model ?? summary.model
    }
}

const summarizePiHead = (
    text: string
): {
    sessionRef: string | null
    firstUserMessage: string | null
    timestamp: string | null
    messageCount: number
    model: string | null
} => {
    let sessionRef: string | null = null
    let firstUserMessage: string | null = null
    let timestamp: string | null = null
    let messageCount = 0
    let model: string | null = null
    for (const raw of text.split('\n')) {
        const entry = parseEntry(raw)
        if (!entry) continue
        if (entry.type === 'session') {
            if (!sessionRef && typeof entry.id === 'string')
                sessionRef = entry.id
            if (!timestamp && typeof entry.timestamp === 'string')
                timestamp = entry.timestamp
            continue
        }
        if (entry.type === 'model_change') {
            model = qualifiedModel(entry.provider, entry.modelId) ?? model
            continue
        }
        const message = messageOf(entry)
        if (!message) continue
        if (message.role !== 'user' && message.role !== 'assistant') continue
        const messageText = contentText(message.content)
        if (!messageText) continue
        messageCount++
        if (!firstUserMessage && message.role === 'user')
            firstUserMessage = messageText.slice(0, 200)
        if (message.role === 'assistant')
            model = qualifiedModel(message.provider, message.model) ?? model
    }
    return { sessionRef, firstUserMessage, timestamp, messageCount, model }
}

const latestPiEntries = (
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
        const entry = parseEntry(lines[i])
        if (!entry) continue
        if (entry.type === 'model_change' && !model) {
            model = qualifiedModel(entry.provider, entry.modelId)
            continue
        }
        const message = messageOf(entry)
        if (!message) continue
        if (message.role !== 'user' && message.role !== 'assistant') continue
        if (!lastActiveAt) lastActiveAt = entryTimestamp(entry, message)
        if (message.role !== 'assistant') continue
        if (!model) model = qualifiedModel(message.provider, message.model)
        if (!lastAssistantMessage)
            lastAssistantMessage = candidateExcerpt(
                contentText(message.content)
            )
    }
    return { lastAssistantMessage, lastActiveAt, model }
}

interface PendingAssistant {
    blocks: ChatContentBlock[]
    timestamp: string
    externalId: string
    parentExternalId: string | null
    model: string | null
    sources: RecoveredRawSource[]
}

// pi's session file is a tree: every entry names its parent, a branch appends
// children to an earlier entry, and the current position is the last entry
// written. The conversation is the path from that leaf back to the root, so
// entries off the path (abandoned branches) are read but not reported.
export const parsePiJsonl = (
    text: string,
    sourceFile?: string | null,
    sourceRef?: string | null
): Pick<ReaderResult, 'messages' | 'warnings' | 'lineCount'> => {
    const warnings: string[] = []
    const lines = text.split('\n')
    const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length
    const byId = new Map<string, { entry: PiEntry; lineNo: number }>()
    let leafId: string | null = null
    let header: PiEntry | null = null
    let lineNo = 0
    for (const raw of lines) {
        lineNo++
        const line = raw.trim()
        if (!line) continue
        let entry: PiEntry
        try {
            entry = JSON.parse(line) as PiEntry
        } catch (err) {
            warnings.push(
                `line ${lineNo}: parse error: ${(err as Error).message}`
            )
            continue
        }
        if (entry.type === 'session') {
            if (lineNo !== 1)
                warnings.push(`line ${lineNo}: unexpected session header`)
            header = entry
            continue
        }
        if (typeof entry.id !== 'string') {
            warnings.push(`line ${lineNo}: entry without id`)
            continue
        }
        byId.set(entry.id, { entry, lineNo })
        leafId = entry.id
    }
    if (!header) warnings.push('missing session header on line 1')
    else if (
        sourceRef &&
        typeof header.id === 'string' &&
        header.id !== sourceRef
    )
        warnings.push(
            `session header id ${header.id} differs from ref ${sourceRef}`
        )

    const path: Array<{ entry: PiEntry; lineNo: number }> = []
    const seen = new Set<string>()
    let cursor: string | null = leafId
    while (cursor) {
        if (seen.has(cursor)) {
            warnings.push(`parent cycle at entry ${cursor}`)
            break
        }
        seen.add(cursor)
        const node = byId.get(cursor)
        if (!node) {
            warnings.push(`entry ${cursor} referenced but not present`)
            break
        }
        path.push(node)
        cursor =
            typeof node.entry.parentId === 'string' ? node.entry.parentId : null
    }
    path.reverse()

    const messages: RecoveredMessage[] = []
    let pending: PendingAssistant | null = null
    let lastUserExternalId: string | null = null
    let currentModel: string | null = null

    const flush = (): void => {
        if (pending && pending.blocks.length > 0)
            messages.push({
                externalId: pending.externalId,
                parentExternalId: pending.parentExternalId,
                role: 'assistant',
                contentBlocks: pending.blocks,
                timestamp: pending.timestamp,
                model: pending.model,
                sources: pending.sources
            })
        pending = null
    }

    for (const { entry, lineNo: entryLine } of path) {
        if (entry.type === 'model_change') {
            currentModel =
                qualifiedModel(entry.provider, entry.modelId) ?? currentModel
            continue
        }
        const message = messageOf(entry)
        if (!message) continue
        const externalId = entry.id as string
        const timestamp = entryTimestamp(entry, message)
        const rawSource: RecoveredRawSource = {
            sourceRef: sourceRef ?? null,
            sourceFile: sourceFile ?? null,
            sourceSeq: entryLine,
            externalId,
            parentExternalId:
                typeof entry.parentId === 'string' ? entry.parentId : null,
            rawFormat: 'jsonl',
            rawText: lines[entryLine - 1].replace(/\r$/, ''),
            parserName: PI_RECOVERY_PARSER_NAME,
            parserVersion: PI_RECOVERY_PARSER_VERSION
        }

        if (message.role === 'user') {
            flush()
            const messageText = contentText(message.content)
            if (!messageText) continue
            messages.push({
                externalId,
                parentExternalId: null,
                role: 'user',
                contentBlocks: [{ type: 'text', text: messageText }],
                timestamp,
                sources: [rawSource]
            })
            lastUserExternalId = externalId
            continue
        }

        if (message.role === 'assistant') {
            flush()
            const model =
                qualifiedModel(message.provider, message.model) ?? currentModel
            const blocks: ChatContentBlock[] = []
            if (Array.isArray(message.content))
                for (const block of message.content) {
                    if (!isRecord(block)) continue
                    if (block.type === 'text' && typeof block.text === 'string')
                        blocks.push({ type: 'text', text: block.text })
                    else if (
                        block.type === 'thinking' &&
                        typeof block.thinking === 'string' &&
                        block.redacted !== true
                    )
                        blocks.push({ type: 'thinking', text: block.thinking })
                    else if (
                        block.type === 'toolCall' &&
                        typeof block.id === 'string'
                    )
                        blocks.push({
                            type: 'tool_call',
                            toolCallId: block.id,
                            toolName:
                                typeof block.name === 'string'
                                    ? block.name
                                    : 'tool',
                            args: block.arguments ?? null
                        })
                }
            pending = {
                blocks,
                timestamp,
                externalId,
                parentExternalId: lastUserExternalId,
                model,
                sources: [rawSource]
            }
            continue
        }

        if (message.role === 'toolResult') {
            if (typeof message.toolCallId !== 'string') continue
            // A result belongs to the assistant message that made the call;
            // pi persists it as its own entry, so it is folded back in.
            pending = pending ?? {
                blocks: [],
                timestamp,
                externalId,
                parentExternalId: lastUserExternalId,
                model: currentModel,
                sources: []
            }
            pending.blocks.push({
                type: 'tool_result',
                toolCallId: message.toolCallId,
                result: {
                    content: message.content ?? null,
                    details: message.details ?? null,
                    isError: message.isError === true
                }
            })
            pending.sources.push({
                ...rawSource,
                externalId: pending.externalId
            })
            continue
        }
        // bashExecution / custom / branchSummary / compactionSummary are pi's
        // own bookkeeping, not conversation.
    }
    flush()

    return { messages, warnings, lineCount }
}

const parseEntry = (raw: string): PiEntry | null => {
    const line = raw.trim()
    if (!line) return null
    try {
        const parsed: unknown = JSON.parse(line)
        return isRecord(parsed) ? (parsed as PiEntry) : null
    } catch {
        return null
    }
}

const messageOf = (entry: PiEntry): Record<string, unknown> | null =>
    entry.type === 'message' && isRecord(entry.message) ? entry.message : null

// The entry timestamp is ISO text; the message's own is Unix milliseconds.
const entryTimestamp = (
    entry: PiEntry,
    message: Record<string, unknown>
): string => {
    if (
        typeof message.timestamp === 'number' &&
        Number.isFinite(message.timestamp)
    )
        return new Date(message.timestamp).toISOString()
    if (typeof entry.timestamp === 'string') return entry.timestamp
    return new Date().toISOString()
}

// User content is a string or text/image blocks; assistant content is blocks.
const contentText = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .map((block) =>
            isRecord(block) &&
            block.type === 'text' &&
            typeof block.text === 'string'
                ? block.text
                : ''
        )
        .filter(Boolean)
        .join('\n')
}

const qualifiedModel = (provider: unknown, model: unknown): string | null => {
    if (typeof model !== 'string' || !model.trim()) return null
    const id = model.trim()
    return typeof provider === 'string' && provider.trim() && !id.includes('/')
        ? `${provider.trim()}/${id}`
        : id
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null
