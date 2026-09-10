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

// rollout-<timestamp>-<thread id>.jsonl, found by the thread id substring.
const rolloutLocateScript = (threadId: string): string =>
    `find "$HOME"/.codex/sessions -type f -name ${shellEscape(`*${threadId}*.jsonl`)} 2>/dev/null | head -1`

// `wc -l` of the thread's rollout: its newline-terminated lines, which is the
// sourceSeq a full read assigns to the last complete line — the unit the
// session's runtime-sync cursor is kept in. Exit 2 when there is no file yet.
export const codexRolloutLineCountScript = (threadId: string): string =>
    [
        `f=$(${rolloutLocateScript(threadId)})`,
        'if [ -z "$f" ]; then exit 2; fi',
        'wc -l < "$f"'
    ].join('; ')

export const parseCodexRolloutLineCount = (
    stdout: string | null
): number | null => {
    const match = stdout?.trim().match(/^\d+$/)
    return match ? Number(match[0]) : null
}

export class CodexSessionReader implements SessionReader {
    readonly framework: AgentFramework = 'codex'

    async readMessages(ctx: ReaderContext): Promise<ReaderResult> {
        const sourceFile = await ctx.fs.locate(
            rolloutLocateScript(ctx.frameworkSessionRef)
        )
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
        return {
            sourceFile,
            ...parseCodexJsonl(
                text,
                sourceFile,
                ctx.frameworkSessionRef,
                fallbackModel
            )
        }
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
        if (role === 'user' && isCodexContextualUserMessage(payload)) continue
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
): Pick<
    ReaderResult,
    'messages' | 'warnings' | 'lineCount' | 'openTurnStartSeq'
> => {
    const messages: RecoveredMessage[] = []
    const warnings: string[] = []
    let pending: PendingAssistant | null = null
    // Codex brackets each turn with `task_started` … `task_complete` (or
    // `turn_aborted`) events; a start with no end at EOF is a turn still
    // being written, and everything from it on is reported as unsettled.
    let openTurnStartSeq: number | null = null
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
        if (row.type === 'event_msg' && isRecord(row.payload)) {
            const eventType = stringField(row.payload, 'type')
            if (eventType === 'task_started' || eventType === 'turn_started')
                openTurnStartSeq = lineNo
            else if (
                eventType === 'task_complete' ||
                eventType === 'turn_complete' ||
                eventType === 'turn_aborted'
            )
                openTurnStartSeq = null
            continue
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
            if (role === 'user' && isCodexContextualUserMessage(payload))
                continue
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
    return {
        messages,
        warnings,
        lineCount: (text.match(/\n/g) ?? []).length,
        openTurnStartSeq
    }
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

// Codex opens every thread by writing its own preamble into the rollout as
// user-role messages — `# AGENTS.md instructions for <cwd>`, then
// `<environment_context>` — and appends `<turn_aborted>` after an interrupt.
// They are the model's context, not the user's words, and codex's own UI
// never shows them (core/src/event_mapping.rs, `parse_user_message` returns
// nothing for a contextual message). Read as user messages they reached the
// chat as if the user had typed them.
// Seen on staging [2026-09-10]: the sync that follows a sprite agent's first
// turn appended the AGENTS.md preamble as a user bubble.
//
// Recent codex (0.153 on staging) labels every content item in
// `content_item_kinds` — `user.text` for what the user typed,
// `agents_md.instructions` / `environments.environment_context` for context —
// and its `is_user_authorization_message` reads a message as the user's when
// any kind is `user.*` or one of the placeholders below, treating a missing or
// incomplete list as the user's. Rollouts from before the labels get the
// marker table its display filter uses: any fragment that opens with the
// start marker and closes with the end marker, ASCII case-insensitive.
const USER_AUTHORED_CONTENT_KINDS = new Set([
    '',
    'unknown',
    'images.preparation_error',
    'images.unsupported',
    'audio.unsupported'
])

const CODEX_CONTEXTUAL_USER_MARKERS: ReadonlyArray<readonly [string, string]> =
    [
        ['# agents.md instructions', '</instructions>'],
        ['<user_instructions>', '</user_instructions>'],
        ['<environment_context>', '</environment_context>'],
        ['<turn_aborted>', '</turn_aborted>'],
        ['<user_shell_command>', '</user_shell_command>'],
        ['<subagent_notification>', '</subagent_notification>'],
        ['<codex_internal_context', '</codex_internal_context>'],
        ['<goal_context>', '</goal_context>']
    ]

const isCodexContextualUserMessage = (
    payload: Record<string, unknown>
): boolean => {
    const content = payload.content
    const meta = payload.internal_chat_message_metadata_passthrough
    const kinds = isRecord(meta) ? meta.content_item_kinds : undefined
    if (
        Array.isArray(kinds) &&
        Array.isArray(content) &&
        kinds.length > 0 &&
        kinds.length === content.length &&
        kinds.every((kind) => typeof kind === 'string')
    )
        return !kinds.some(
            (kind) =>
                kind.startsWith('user.') ||
                USER_AUTHORED_CONTENT_KINDS.has(kind)
        )
    return isCodexContextualUserContent(content)
}

const isCodexContextualUserText = (text: string): boolean => {
    const head = text.trimStart().toLowerCase()
    const trimmed = head.trimEnd()
    return CODEX_CONTEXTUAL_USER_MARKERS.some(
        ([open, close]) => head.startsWith(open) && trimmed.endsWith(close)
    )
}

const isCodexContextualUserContent = (content: unknown): boolean => {
    if (typeof content === 'string') return isCodexContextualUserText(content)
    if (!Array.isArray(content)) return false
    return content.some(
        (item) =>
            isRecord(item) &&
            stringField(item, 'type') === 'input_text' &&
            typeof item.text === 'string' &&
            isCodexContextualUserText(item.text)
    )
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
