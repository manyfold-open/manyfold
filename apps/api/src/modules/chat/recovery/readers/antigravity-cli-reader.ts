import {
    isAntigravityConversationId,
    type AgentFramework,
    type ChatContentBlock
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

const AGY_RECOVERY_PARSER_NAME = 'antigravity-cli-transcript-jsonl'
const AGY_RECOVERY_PARSER_VERSION = '1'

// agy keeps every conversation under its app data dir by id, whatever cwd it
// ran in; a platform turn's view links `brain` back here, so both kinds of
// turn land in the same place. Each conversation logs two line-aligned files:
// transcript.jsonl, whose long fields are truncated and whose tool arguments
// are JSON-encoded strings, and transcript_full.jsonl, which holds them whole
// (agy's own prompt tells the model to read a truncated step's line there).
// Measured on agy 1.2.11 [2026-09-26].
const AGY_BRAIN = '"$HOME"/.gemini/antigravity-cli/brain'
const AGY_LOGS = '.system_generated/logs'
const AGY_FULL = 'transcript_full.jsonl'
const AGY_COMPACT = 'transcript.jsonl'
const AGY_FIND = `find ${AGY_BRAIN} -mindepth 4 -maxdepth 4 -type f -path '*/${AGY_LOGS}/${AGY_FULL}'`

// The full log when it is there, else the compact one. Nothing that is not a
// conversation id agy minted reaches the path.
export const antigravityTranscriptLocateScript = (
    conversationId: string
): string => {
    if (!isAntigravityConversationId(conversationId)) return 'exit 2'
    const dir = `${AGY_BRAIN}/${shellEscape(conversationId)}/${AGY_LOGS}`
    return `for f in ${dir}/${AGY_FULL} ${dir}/${AGY_COMPACT}; do if [ -f "$f" ]; then printf '%s\\n' "$f"; exit 0; fi; done; exit 2`
}

// `wc -l` of that log: the sourceSeq a full read gives its last complete
// record and the unit the session's runtime-sync cursor is kept in. Exit 2
// when there is no log yet.
export const antigravityTranscriptLineCountScript = (
    conversationId: string
): string =>
    [
        `f=$(${antigravityTranscriptLocateScript(conversationId)})`,
        'if [ -z "$f" ]; then exit 2; fi',
        'wc -l < "$f"'
    ].join('; ')

export const parseAntigravityTranscriptLineCount = (
    stdout: string | null
): number | null => {
    const match = stdout?.trim().match(/^\d+$/)
    return match ? Number(match[0]) : null
}

const AGY_TRANSCRIPT_PATH =
    /\/brain\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/i
export const antigravityRefFromPath = (path: string): string | null =>
    path.match(AGY_TRANSCRIPT_PATH)?.[1] ?? null

export class AntigravityCliSessionReader implements SessionReader {
    readonly framework: AgentFramework = 'antigravity-cli'

    async readMessages(ctx: ReaderContext): Promise<ReaderResult> {
        const sourceFile = await ctx.fs.locate(
            antigravityTranscriptLocateScript(ctx.frameworkSessionRef)
        )
        if (!sourceFile)
            return {
                sourceFile: null,
                messages: [],
                transcript: 'missing',
                warnings: [
                    `agy transcript for conversation=${ctx.frameworkSessionRef} not found under ~/.gemini/antigravity-cli/brain/`
                ]
            }
        let text: string | null
        try {
            text = await ctx.fs.readFile(sourceFile)
        } catch (err) {
            return {
                sourceFile,
                messages: [],
                transcript: 'unreadable',
                warnings: [
                    `failed to read ${sourceFile}: ${(err as Error).message}`
                ]
            }
        }
        if (text === null)
            return {
                sourceFile,
                messages: [],
                transcript: 'unreadable',
                warnings: [`failed to read ${sourceFile}`]
            }
        return {
            sourceFile,
            transcript: 'read',
            ...parseAntigravityTranscript(
                text,
                sourceFile,
                ctx.frameworkSessionRef
            )
        }
    }

    async listCandidates(ctx: CandidateContext): Promise<CandidateListing> {
        return scanCandidates(ctx.fs, AGY_FIND, {
            agentId: ctx.agentId,
            limit: ctx.limit ?? CANDIDATE_SCAN_LIMIT,
            cache: ctx.cache,
            summarize: summarizeAntigravityCandidate,
            refFromPath: antigravityRefFromPath
        })
    }
}

export interface AgyRecord {
    step_index?: unknown
    source?: unknown
    type?: unknown
    status?: unknown
    created_at?: unknown
    content?: unknown
    thinking?: unknown
    tool_calls?: unknown
    error?: unknown
    [key: string]: unknown
}

// What the user typed, out of the envelope agy files it in: the request tag,
// then metadata (local time, a settings change) the model is shown too.
export const antigravityUserRequest = (content: unknown): string | null => {
    if (typeof content !== 'string') return null
    const match = content.match(
        /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/
    )
    const text = (match ? match[1] : content).trim()
    return text || null
}

interface PendingCall {
    block: Extract<ChatContentBlock, { type: 'tool_call' }>
    answered: boolean
}

interface PendingAssistant {
    blocks: ChatContentBlock[]
    calls: PendingCall[]
    stepIndex: number
    timestamp: string
    externalId: string
    parentExternalId: string | null
    sources: RecoveredRawSource[]
}

// A planner step's tool results follow it in call order, each as its own
// step written by the model's side (the one kind agy files as GENERIC in
// 1.2.11, among the dozens its step enum names). A result takes the id the
// live stream gave the same step, `agy-<step index>`, so an imported tool
// call matches the one a turn streamed.
const isToolStep = (record: AgyRecord): boolean =>
    record.source === 'MODEL' && record.type !== 'PLANNER_RESPONSE'

export const parseAntigravityTranscript = (
    text: string,
    sourceFile?: string | null,
    sourceRef?: string | null
): Pick<
    ReaderResult,
    'messages' | 'warnings' | 'lineCount' | 'openTurnStartSeq'
> => {
    const warnings: string[] = []
    const lines = text.split('\n')
    const lineCount = text.endsWith('\n') ? lines.length - 1 : lines.length
    // The compact log stores each tool argument JSON-encoded.
    const encodedArgs = !!sourceFile && !sourceFile.endsWith(AGY_FULL)
    const messages: RecoveredMessage[] = []
    let pending: PendingAssistant | null = null
    let lastUserExternalId: string | null = null
    // Where the turn the log ends in began, while it has not ended.
    let turnStartLine: number | null = null
    let turnOpen = false

    const flush = (): void => {
        if (!pending) return
        for (const [i, call] of pending.calls.entries())
            if (!call.answered)
                call.block.toolCallId = `agy-${pending.stepIndex}-${i}`
        if (pending.blocks.length > 0)
            messages.push({
                externalId: pending.externalId,
                parentExternalId: pending.parentExternalId,
                role: 'assistant',
                contentBlocks: pending.blocks,
                timestamp: pending.timestamp,
                model: null,
                sources: pending.sources
            })
        pending = null
    }

    for (const [index, raw] of lines.entries()) {
        const lineNo = index + 1
        const line = raw.trim()
        if (!line) continue
        let record: AgyRecord
        try {
            const parsed: unknown = JSON.parse(line)
            if (!isRecord(parsed)) continue
            record = parsed as AgyRecord
        } catch (err) {
            warnings.push(
                `line ${lineNo}: parse error: ${(err as Error).message}`
            )
            continue
        }
        const stepIndex =
            typeof record.step_index === 'number' ? record.step_index : lineNo
        const timestamp =
            typeof record.created_at === 'string'
                ? record.created_at
                : new Date().toISOString()
        const rawSource = (externalId: string): RecoveredRawSource => ({
            sourceRef: sourceRef ?? null,
            sourceFile: sourceFile ?? null,
            sourceSeq: lineNo,
            externalId,
            parentExternalId: null,
            rawFormat: 'jsonl',
            rawText: raw.replace(/\r$/, ''),
            parserName: AGY_RECOVERY_PARSER_NAME,
            parserVersion: AGY_RECOVERY_PARSER_VERSION
        })

        if (record.type === 'USER_INPUT') {
            flush()
            turnStartLine = lineNo
            turnOpen = true
            const request = antigravityUserRequest(record.content)
            if (!request) continue
            const externalId = `agy-step-${stepIndex}`
            messages.push({
                externalId,
                parentExternalId: null,
                role: 'user',
                contentBlocks: [{ type: 'text', text: request }],
                timestamp,
                sources: [rawSource(externalId)]
            })
            lastUserExternalId = externalId
            continue
        }

        if (record.type === 'PLANNER_RESPONSE') {
            flush()
            const externalId = `agy-step-${stepIndex}`
            const blocks: ChatContentBlock[] = []
            if (typeof record.thinking === 'string' && record.thinking.trim())
                blocks.push({ type: 'thinking', text: record.thinking })
            if (typeof record.content === 'string' && record.content)
                blocks.push({ type: 'text', text: record.content })
            const calls: PendingCall[] = []
            if (Array.isArray(record.tool_calls))
                for (const call of record.tool_calls) {
                    if (!isRecord(call)) continue
                    const block: PendingCall['block'] = {
                        type: 'tool_call',
                        toolCallId: '',
                        toolName:
                            typeof call.name === 'string' ? call.name : 'tool',
                        args: encodedArgs
                            ? decodeArgs(call.args)
                            : (call.args ?? null)
                    }
                    blocks.push(block)
                    calls.push({ block, answered: false })
                }
            // A reply with no call in it is the turn's last word.
            turnOpen = calls.length > 0
            pending = {
                blocks,
                calls,
                stepIndex,
                timestamp,
                externalId,
                parentExternalId: lastUserExternalId,
                sources: [rawSource(externalId)]
            }
            continue
        }

        if (isToolStep(record)) {
            const toolCallId = `agy-${stepIndex}`
            pending = pending ?? {
                blocks: [],
                calls: [],
                stepIndex,
                timestamp,
                externalId: `agy-step-${stepIndex}`,
                parentExternalId: lastUserExternalId,
                sources: []
            }
            const call = pending.calls.find((c) => !c.answered)
            if (call) {
                call.answered = true
                call.block.toolCallId = toolCallId
            } else
                pending.blocks.push({
                    type: 'tool_call',
                    toolCallId,
                    toolName:
                        typeof record.type === 'string'
                            ? record.type.toLowerCase()
                            : 'tool',
                    args: null
                })
            const failed =
                record.status === 'ERROR' ||
                (typeof record.error === 'string' && record.error.length > 0)
            pending.blocks.push({
                type: 'tool_result',
                toolCallId,
                result: {
                    content: record.content ?? null,
                    details: failed ? { error: record.error ?? null } : null,
                    isError: failed
                }
            })
            pending.sources.push(rawSource(pending.externalId))
            turnOpen = true
            continue
        }

        // A failed model call (one per retry) or agy's own notices to the
        // model: bookkeeping, not conversation. An error that ends the turn
        // ends it all the same.
        if (record.type === 'ERROR_MESSAGE') turnOpen = false
    }
    flush()

    return {
        messages,
        warnings,
        lineCount,
        openTurnStartSeq: turnOpen ? turnStartLine : null
    }
}

// transcript.jsonl writes `"CommandLine": "\"echo hi\""`: each argument is
// its JSON text, which the full log stores as the value itself.
const decodeArgs = (args: unknown): unknown => {
    if (!isRecord(args)) return args ?? null
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
        if (typeof value !== 'string') {
            out[key] = value
            continue
        }
        try {
            out[key] = JSON.parse(value)
        } catch {
            out[key] = value
        }
    }
    return out
}

const summarizeAntigravityCandidate = (
    head: CandidateFileHead
): CandidateSession | null => {
    const sessionRef = antigravityRefFromPath(head.path)
    if (!sessionRef) return null
    let firstUserMessage: string | null = null
    let timestamp: string | null = null
    let messageCount = 0
    for (const raw of head.headText.split('\n')) {
        const record = parseRecord(raw)
        if (!record) continue
        if (!timestamp && typeof record.created_at === 'string')
            timestamp = record.created_at
        if (record.type === 'USER_INPUT') {
            const request = antigravityUserRequest(record.content)
            if (!request) continue
            messageCount++
            if (!firstUserMessage) firstUserMessage = request.slice(0, 200)
        } else if (
            record.type === 'PLANNER_RESPONSE' &&
            typeof record.content === 'string' &&
            record.content
        )
            messageCount++
    }
    let lastAssistantMessage: string | null = null
    let lastActiveAt: string | null = null
    const tail = candidateTailLines(head)
    for (let i = tail.length - 1; i >= 0; i--) {
        const record = parseRecord(tail[i])
        if (!record) continue
        if (!lastActiveAt && typeof record.created_at === 'string')
            lastActiveAt = record.created_at
        if (
            record.type === 'PLANNER_RESPONSE' &&
            typeof record.content === 'string' &&
            record.content
        ) {
            lastAssistantMessage = candidateExcerpt(record.content)
            break
        }
    }
    return {
        sessionRef,
        sourceFile: head.path,
        firstUserMessage,
        lastAssistantMessage,
        timestamp: timestamp ?? mtimeIso(head),
        lastActiveAt: lastActiveAt ?? mtimeIso(head),
        messageCount: head.truncated ? head.lineCount : messageCount,
        // agy files no model on its steps.
        model: null
    }
}

const parseRecord = (raw: string): AgyRecord | null => {
    const line = raw.trim()
    if (!line) return null
    try {
        const parsed: unknown = JSON.parse(line)
        return isRecord(parsed) ? (parsed as AgyRecord) : null
    } catch {
        return null
    }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
