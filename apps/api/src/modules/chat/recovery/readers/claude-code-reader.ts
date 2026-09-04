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
    candidateExcerpt,
    candidateTailLines,
    mtimeIso,
    scanCandidateFiles
} from './candidate-scan'

const CLAUDE_RECOVERY_PARSER_NAME = 'claude-code-session-jsonl'
const CLAUDE_RECOVERY_PARSER_VERSION = '1'

const CLAUDE_FIND = `find "$HOME"/.claude/projects -type f -name '*.jsonl'`

// The transcript filename is the sessionId, so try the cheap filename match
// first; the content grep (fixed-string, not a pattern — the ref must never be
// interpreted as a regex) stays as fallback for resumed/forked transcripts
// whose file is named after a different sessionId. Shared with the live-turn
// recovery path (turn-jsonl-recovery).
export const claudeSessionLocateScript = (ref: string): string => {
    const pattern = `"sessionId":"${ref}"`
    return [
        `f=$(find "$HOME"/.claude/projects -type f -name ${shellEscape(`${ref}.jsonl`)} 2>/dev/null | head -1)`,
        `if [ -n "$f" ]; then echo "$f"; exit 0; fi`,
        `grep -l -F ${shellEscape(pattern)} "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1`
    ].join('\n')
}

export class ClaudeCodeSessionReader implements SessionReader {
    readonly framework: AgentFramework = 'claude-code'

    async readMessages(ctx: ReaderContext): Promise<ReaderResult> {
        const sourceFile = await ctx.fs.locate(
            claudeSessionLocateScript(ctx.frameworkSessionRef)
        )
        if (!sourceFile)
            return {
                sourceFile: null,
                messages: [],
                warnings: [
                    `claude session file containing sessionId=${ctx.frameworkSessionRef} not found under ~/.claude/projects/`
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

        const { messages, warnings } = parseClaudeJsonl(
            text,
            ctx.frameworkSessionRef,
            sourceFile
        )
        return { sourceFile, messages, warnings }
    }

    async listCandidates(ctx: CandidateContext): Promise<CandidateSession[]> {
        const heads = await scanCandidateFiles(ctx.fs, CLAUDE_FIND)
        const out: CandidateSession[] = []
        for (const head of heads) {
            const summary = summarizeClaudeJsonl(head.headText)
            const latest = latestClaudeEntries(candidateTailLines(head))
            if (summary.sessionRef)
                out.push({
                    sessionRef: summary.sessionRef,
                    sourceFile: head.path,
                    firstUserMessage: summary.firstUserMessage,
                    lastAssistantMessage: latest.lastAssistantMessage,
                    timestamp: summary.timestamp ?? mtimeIso(head),
                    lastActiveAt: latest.lastActiveAt ?? mtimeIso(head),
                    messageCount: head.truncated
                        ? head.lineCount
                        : summary.messageCount,
                    model: latest.model
                })
        }
        return out
    }
}

// Read backwards over whatever window the scan produced: the newest reply, when
// it landed, and the model that wrote it.
const latestClaudeEntries = (
    lines: string[]
): {
    lastAssistantMessage: string | null
    lastActiveAt: string | null
    model: string | null
} => {
    let lastAssistantMessage: string | null = null
    let lastActiveAt: string | null = null
    let model: string | null = null
    const { entries } = parseClaudeJsonlEntries(lines.join('\n'))
    for (let i = entries.length - 1; i >= 0; i--) {
        const { parsed } = entries[i]
        if (!parsed.type || !KEEP_TYPES.has(parsed.type)) continue
        const role = parsed.message?.role
        if (role !== 'user' && role !== 'assistant' && role !== 'system')
            continue
        const blocks = mapClaudeContent(parsed.message?.content)
        if (blocks.length === 0) continue
        if (!lastActiveAt && parsed.timestamp) lastActiveAt = parsed.timestamp
        if (role !== 'assistant') continue
        if (!model && typeof parsed.message?.model === 'string')
            model = parsed.message.model
        if (!lastAssistantMessage) {
            const textBlock = blocks.find((b) => b.type === 'text')
            if (textBlock && textBlock.type === 'text')
                lastAssistantMessage = candidateExcerpt(textBlock.text)
        }
        if (lastAssistantMessage && model && lastActiveAt) break
    }
    return { lastAssistantMessage, lastActiveAt, model }
}

const summarizeClaudeJsonl = (
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
    const { entries } = parseClaudeJsonlEntries(text)
    for (const { parsed } of entries) {
        if (!sessionRef && parsed.sessionId) sessionRef = parsed.sessionId
        if (!parsed.type || !KEEP_TYPES.has(parsed.type)) continue
        const role = parsed.message?.role
        if (role !== 'user' && role !== 'assistant' && role !== 'system')
            continue
        const blocks = mapClaudeContent(parsed.message?.content)
        if (blocks.length === 0) continue
        messageCount++
        if (!timestamp && parsed.timestamp) timestamp = parsed.timestamp
        if (!firstUserMessage && role === 'user') {
            const textBlock = blocks.find((b) => b.type === 'text')
            if (textBlock && textBlock.type === 'text')
                firstUserMessage = textBlock.text.slice(0, 200)
        }
    }
    return { sessionRef, firstUserMessage, timestamp, messageCount }
}

export const parseClaudeJsonl = (
    text: string,
    expectedSessionId?: string,
    sourceFile?: string | null
): { messages: RecoveredMessage[]; warnings: string[] } => {
    const messages: RecoveredMessage[] = []
    const { entries, warnings } = parseClaudeJsonlEntries(text)
    let pendingAssistant: RecoveredMessage | null = null
    let lastUserExternalId: string | null = null

    const flushAssistant = (): void => {
        if (pendingAssistant && pendingAssistant.contentBlocks.length > 0) {
            pendingAssistant.contentBlocks = collapseTextBlocks(
                pendingAssistant.contentBlocks
            )
            messages.push(pendingAssistant)
        }
        pendingAssistant = null
    }

    for (const { lineNo, raw, parsed } of entries) {
        if (
            expectedSessionId &&
            parsed.sessionId &&
            parsed.sessionId !== expectedSessionId
        )
            continue
        if (!parsed.uuid || !parsed.type || !KEEP_TYPES.has(parsed.type))
            continue
        const role = parsed.message?.role
        if (role !== 'user' && role !== 'assistant' && role !== 'system')
            continue
        const blocks = mapClaudeContent(parsed.message?.content)
        if (blocks.length === 0) continue

        const rawSource = claudeRawSource(parsed, raw, lineNo, sourceFile)
        if (role === 'system') {
            flushAssistant()
            messages.push({
                externalId: parsed.uuid,
                parentExternalId: parsed.parentUuid ?? null,
                role,
                contentBlocks: blocks,
                timestamp: parsed.timestamp ?? new Date().toISOString(),
                sources: [rawSource]
            })
            continue
        }

        const isToolResultOnly = blocks.every(
            (block) => block.type === 'tool_result'
        )
        if (role === 'user' && !isToolResultOnly) {
            flushAssistant()
            messages.push({
                externalId: parsed.uuid,
                parentExternalId: parsed.parentUuid ?? null,
                role,
                contentBlocks: blocks,
                timestamp: parsed.timestamp ?? new Date().toISOString(),
                sources: [rawSource]
            })
            lastUserExternalId = parsed.uuid
            continue
        }

        pendingAssistant = pendingAssistant ?? {
            externalId: role === 'assistant' ? parsed.uuid : `claude-${lineNo}`,
            parentExternalId: lastUserExternalId,
            role: 'assistant',
            contentBlocks: [],
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            sources: []
        }
        pendingAssistant.contentBlocks.push(...blocks)
        pendingAssistant.sources.push({
            ...rawSource,
            externalId: pendingAssistant.externalId,
            parentExternalId: lastUserExternalId
        })
    }
    flushAssistant()
    return { messages, warnings }
}

// Per-assistant on-disk usage (raw Anthropic message.usage). Snake_case only —
// that is what the CLI writes to the transcript.
export interface ClaudeJsonlUsage {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
}

export interface ClaudeJsonLine {
    uuid?: string
    parentUuid?: string | null
    sessionId?: string
    type?: string
    timestamp?: string
    // Subagent/sidechain entries; recovery excludes these from turn/terminal
    // reasoning so a subagent that outlived the main chain can't fake a result.
    isSidechain?: boolean
    message?: {
        role?: string
        content?: unknown
        // Present on assistant entries; the on-disk equivalents of the
        // stream-json result line, used by live-turn recovery.
        id?: string
        model?: string
        stop_reason?: string | null
        usage?: ClaudeJsonlUsage
    }
}

export interface ClaudeJsonlEntry {
    lineNo: number
    // Trailing \r stripped, matching the rawText persisted for recovered rows.
    raw: string
    parsed: ClaudeJsonLine
}

// Line-split + JSON.parse only, no filtering — the shared low-level pass that
// both the message-grouping parser and live-turn recovery build on. lineNo is
// the 1-based index in the split (blank lines counted), matching sourceSeq.
export const parseClaudeJsonlEntries = (
    text: string
): { entries: ClaudeJsonlEntry[]; warnings: string[] } => {
    const entries: ClaudeJsonlEntry[] = []
    const warnings: string[] = []
    let lineNo = 0
    for (const raw of text.split('\n')) {
        lineNo++
        const line = raw.trim()
        if (!line) continue
        let parsed: ClaudeJsonLine
        try {
            parsed = JSON.parse(line) as ClaudeJsonLine
        } catch (err) {
            warnings.push(
                `line ${lineNo}: parse error: ${(err as Error).message}`
            )
            continue
        }
        entries.push({ lineNo, raw: raw.replace(/\r$/, ''), parsed })
    }
    return { entries, warnings }
}

const KEEP_TYPES = new Set(['user', 'assistant', 'system'])

const claudeRawSource = (
    row: ClaudeJsonLine,
    rawLine: string,
    lineNo: number,
    sourceFile?: string | null
) => ({
    sourceRef: row.sessionId ?? null,
    sourceFile: sourceFile ?? null,
    sourceSeq: lineNo,
    externalId: row.uuid ?? `claude-${lineNo}`,
    parentExternalId: row.parentUuid ?? null,
    rawFormat: 'jsonl' as const,
    rawText: rawLine,
    parserName: CLAUDE_RECOVERY_PARSER_NAME,
    parserVersion: CLAUDE_RECOVERY_PARSER_VERSION
})

const mapClaudeContent = (content: unknown): ChatContentBlock[] => {
    if (typeof content === 'string') {
        const trimmed = content.trim()
        return trimmed ? [{ type: 'text', text: content }] : []
    }
    if (!Array.isArray(content)) return []
    const blocks: ChatContentBlock[] = []
    for (const item of content) {
        if (!isRecord(item)) continue
        const t = typeof item.type === 'string' ? item.type : ''
        if (t === 'text' && typeof item.text === 'string' && item.text) {
            blocks.push({ type: 'text', text: item.text })
            continue
        }
        if (t === 'thinking' && typeof item.text === 'string' && item.text) {
            blocks.push({ type: 'thinking', text: item.text })
            continue
        }
        if (
            t === 'tool_use' &&
            typeof item.id === 'string' &&
            typeof item.name === 'string'
        ) {
            blocks.push({
                type: 'tool_call',
                toolCallId: item.id,
                toolName: item.name,
                args: item.input ?? null
            })
            continue
        }
        if (t === 'tool_result' && typeof item.tool_use_id === 'string') {
            blocks.push({
                type: 'tool_result',
                toolCallId: item.tool_use_id,
                result: item.content ?? null
            })
            continue
        }
    }
    return blocks
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
