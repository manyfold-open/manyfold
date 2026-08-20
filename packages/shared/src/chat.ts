import type { AgentFramework, AgentRuntime } from './constants'
import type { ChannelProviderName } from './channels'
import type { AgentModelConfig, AgentModelConfigSource } from './model-config'
import type { ChatUsage } from './usage'

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatTextBlock {
    type: 'text'
    text: string
}

export interface ChatToolCallBlock {
    type: 'tool_call'
    toolCallId: string
    toolName: string
    args: unknown
    elapsedMs?: number
}

export interface ChatToolResultBlock {
    type: 'tool_result'
    toolCallId: string
    result: unknown
    elapsedMs?: number
}

export interface ChatThinkingBlock {
    type: 'thinking'
    text: string
}

export interface ChatAttachmentBlock {
    type: 'attachment'
    name: string
    path: string
    rootId: string
    contentType: string
    size: number
}

export interface ChatContextRefBlock {
    type: 'context_ref'
    name: string
    path: string
    rootId: string
    entryType: 'file' | 'dir'
    contentType?: string
    size?: number
}

export interface ChatUploadBlock {
    type: 'upload'
    uploadId: string
    name: string
    contentType: string
    size: number
}

export type ChatContentBlock =
    | ChatTextBlock
    | ChatAttachmentBlock
    | ChatContextRefBlock
    | ChatUploadBlock
    | ChatToolCallBlock
    | ChatToolResultBlock
    | ChatThinkingBlock

export interface ChatMessage {
    id: string
    sessionId: string
    role: ChatRole
    contentBlocks: ChatContentBlock[]
    createdAt: string
    model?: string | null
    usage?: ChatUsage | null
    error?: ChatError | null
}

export interface ChatMessagesPage {
    messages: ChatMessage[]
    hasMore: boolean
    nextBefore: string | null
    inflightAssistantMessageId: string | null
    // Stream-event id that the inflight assistant message's `contentBlocks`
    // in THIS response are the fold of. Pass it as the stream's `lastEventId`
    // and render those blocks, and the turn is delivered from the checkpoint
    // forward instead of replayed from its first event. Only valid paired
    // with the blocks it arrived with. A decimal string because the id is a
    // bigint and JSON numbers are not. Null means no trustworthy pairing —
    // subscribe with `replayMessageId` and take the full replay.
    inflightCheckpointEventId: string | null
    // Session stream boundary from the same snapshot as `messages`. When the
    // page has no inflight replay target, attach after this id so a turn that
    // finishes between page fetch and SSE subscribe cannot be skipped.
    streamCursorEventId: string | null
}

export interface ChatSessionSummary {
    id: string
    agentId: string
    title: string | null
    frameworkSessionRef: string | null
    channel: ChatSessionChannelSummary | null
    createdAt: string
    updatedAt: string
}

export interface ChatSessionChannelSummary {
    id: string
    channelSessionId: string
    provider: ChannelProviderName
    label: string
    displayName: string | null
}

export interface ChatCapabilities {
    streaming: boolean
    toolCalls: boolean
    thinking: boolean
    attachments: boolean
    multiTurn: boolean
}

export const claudeCodePermissionModes = [
    'default',
    'acceptEdits',
    'plan',
    'auto',
    'bypassPermissions',
    'dontAsk'
] as const
export type ClaudeCodePermissionMode =
    (typeof claudeCodePermissionModes)[number]
export const DEFAULT_CLAUDE_CODE_PERMISSION_MODE: ClaudeCodePermissionMode =
    'bypassPermissions'

export const isClaudeCodePermissionMode = (
    value: unknown
): value is ClaudeCodePermissionMode =>
    typeof value === 'string' &&
    claudeCodePermissionModes.includes(value as ClaudeCodePermissionMode)

export const codexPermissionModes = [
    'default',
    'auto-review',
    'full-access'
] as const
export type CodexPermissionMode = (typeof codexPermissionModes)[number]
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'full-access'

export const isCodexPermissionMode = (
    value: unknown
): value is CodexPermissionMode =>
    typeof value === 'string' &&
    codexPermissionModes.includes(value as CodexPermissionMode)

// This table, not the adapter's own getCapabilities(), is what the Web
// renderer gates thinking and tool blocks on, and nothing in production reads
// an adapter's declaration at all — so a row that disagrees with its adapter
// drops blocks the server streamed and persisted, with nothing to say so
// (#677). Both sides are kept honest by
// apps/api/test/chat-capability-contract.test.ts, which asserts every row
// field-for-field against the adapter the registry resolves for that
// framework.
export const chatCapabilitiesByFramework: Record<
    AgentFramework,
    ChatCapabilities
> = {
    'claude-code': {
        streaming: true,
        toolCalls: true,
        thinking: true,
        attachments: true,
        multiTurn: true
    },
    codex: {
        streaming: true,
        toolCalls: true,
        thinking: true,
        attachments: true,
        multiTurn: true
    },
    'gemini-cli': {
        streaming: true,
        toolCalls: true,
        thinking: true,
        attachments: true,
        multiTurn: true
    },
    openclaw: {
        streaming: true,
        toolCalls: true,
        thinking: false,
        attachments: true,
        multiTurn: true
    },
    hermes: {
        streaming: true,
        toolCalls: true,
        thinking: true,
        attachments: true,
        multiTurn: true
    },
    narranexus: {
        streaming: true,
        toolCalls: true,
        thinking: true,
        attachments: true,
        multiTurn: true
    },
    dify: {
        streaming: true,
        toolCalls: false,
        thinking: true,
        attachments: true,
        multiTurn: true
    },
    langflow: {
        streaming: true,
        toolCalls: false,
        thinking: false,
        attachments: false,
        multiTurn: true
    },
    a2a: {
        streaming: true,
        toolCalls: false,
        thinking: false,
        attachments: false,
        multiTurn: true
    }
}

export interface ChatError {
    code: string
    message: string
    retryable: boolean
}

export type ChatStreamEventType =
    | 'token'
    | 'tool_call'
    | 'tool_result'
    | 'thinking'
    | 'replace'
    | 'usage'
    | 'error'
    | 'done'
    | 'suspended'
    | 'turn_status'

interface BaseEvent {
    eventId: string
    messageId: string
    sessionId: string
    seq: number
    createdAt: string
}

export interface ChatTokenEvent extends BaseEvent {
    type: 'token'
    text: string
}

export interface ChatToolCallEvent extends BaseEvent {
    type: 'tool_call'
    toolCallId: string
    toolName: string
    args: unknown
    elapsedMs?: number
}

export interface ChatToolResultEvent extends BaseEvent {
    type: 'tool_result'
    toolCallId: string
    result: unknown
    elapsedMs?: number
}

export interface ChatThinkingEvent extends BaseEvent {
    type: 'thinking'
    text: string
}

// Supersedes every answer token emitted so far this turn. Reasoning and tool
// blocks are untouched — only the answer text is replaced.
export interface ChatReplaceEvent extends BaseEvent {
    type: 'replace'
    text: string
    reason: string
}

export interface ChatUsageEvent extends BaseEvent {
    type: 'usage'
    usage: ChatUsage
}

export interface ChatErrorEvent extends BaseEvent {
    type: 'error'
    error: ChatError
}

export interface ChatDoneEvent extends BaseEvent {
    type: 'done'
    finalMessageId: string
}

export interface ChatSuspendedEvent extends BaseEvent {
    type: 'suspended'
    daemonId: string
    daemonExecRef: string
    reason: string
}

// What the server is doing about a turn whose original execution was
// interrupted. `recovering` = adoption is rebuilding the answer from the
// framework's own record; `resuming` = a re-dialled daemon is picking the
// runner stream back up.
export type ChatTurnStatusPhase = 'recovering' | 'resuming'

// Purely informational (#674). Recovery used to be invisible: an adopted or
// resumed turn went silent for as long as the rebuild took, and the client had
// no way to tell "being recovered" from "hung". This event is NOT terminal —
// only done/error end a turn — and carries no content, so a client that does
// not know the type can ignore it and lose nothing.
export interface ChatTurnStatusEvent extends BaseEvent {
    type: 'turn_status'
    phase: ChatTurnStatusPhase
}

export type ChatStreamEvent =
    | ChatTokenEvent
    | ChatToolCallEvent
    | ChatToolResultEvent
    | ChatThinkingEvent
    | ChatReplaceEvent
    | ChatUsageEvent
    | ChatErrorEvent
    | ChatDoneEvent
    | ChatSuspendedEvent
    | ChatTurnStatusEvent

export interface CreateSessionRequest {
    title?: string
}

export interface CreateMessageAttachmentInput {
    path: string
    rootId?: string
    name?: string
    contentType?: string
    size?: number
}

export interface CreateMessageContextRefInput {
    path: string
    rootId?: string
    name?: string
    entryType?: 'file' | 'dir'
    contentType?: string
    size?: number
}

export interface CreateMessageUploadInput {
    uploadId: string
    name?: string
    contentType?: string
    size?: number
}

export interface ChatUploadResponse {
    id: string
    name: string
    contentType: string
    size: number
}

export interface CreateMessageRequest {
    sessionId: string
    text?: string
    model?: string
    modelConfigSource?: AgentModelConfigSource
    modelConfig?: AgentModelConfig
    saveAsDefault?: boolean
    claudeCodePermissionMode?: ClaudeCodePermissionMode
    codexPermissionMode?: CodexPermissionMode
    attachments?: CreateMessageAttachmentInput[]
    contextRefs?: CreateMessageContextRefInput[]
    uploads?: CreateMessageUploadInput[]
}

export interface RegenerateMessageRequest {
    text?: string
    model?: string
    modelConfigSource?: AgentModelConfigSource
    modelConfig?: AgentModelConfig
    saveAsDefault?: boolean
    codexPermissionMode?: CodexPermissionMode
}

export interface RegenerateMessageResponse {
    userMessage: ChatMessage
    assistantMessageId: string
    deletedMessageIds: string[]
}

export const CHAT_ATTACHMENT_MAX_COUNT = 10
export const CHAT_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024
export const CHAT_UPLOAD_MAX_COUNT = 10
export const CHAT_UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024
export const CHAT_UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024
export const CHAT_UPLOAD_TTL_MS = 60 * 60 * 1000

export const CHAT_ATTACHMENT_ALLOWED_MIME_PREFIXES = ['image/', 'text/']
export const CHAT_ATTACHMENT_ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'application/json',
    'application/xml',
    'application/rtf',
    'application/zip',
    'application/x-yaml',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
])
export const CHAT_ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'rtf', 'csv', 'tsv', 'log',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env',
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs',
    'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'php', 'swift',
    'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'vue', 'svelte',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'avif'
])

export const CHAT_ATTACHMENT_ACCEPT = [
    ...CHAT_ATTACHMENT_ALLOWED_MIME_PREFIXES.map((prefix) => `${prefix}*`),
    ...Array.from(CHAT_ATTACHMENT_ALLOWED_EXTENSIONS, (ext) => `.${ext}`)
].join(',')

export const isAllowedChatAttachment = (file: {
    type?: string
    name?: string
}): boolean => {
    const type = (file.type ?? '').toLowerCase()
    if (type) {
        if (
            CHAT_ATTACHMENT_ALLOWED_MIME_PREFIXES.some((prefix) =>
                type.startsWith(prefix)
            )
        )
            return true
        if (CHAT_ATTACHMENT_ALLOWED_MIME_TYPES.has(type)) return true
    }
    const name = (file.name ?? '').toLowerCase()
    const dot = name.lastIndexOf('.')
    if (dot >= 0 && CHAT_ATTACHMENT_ALLOWED_EXTENSIONS.has(name.slice(dot + 1)))
        return true
    return false
}

export const CHAT_MESSAGE_SOFT_LIMIT = 50
export const HERMES_HISTORY_BUDGET = 30

export interface RuntimeSessionCandidate {
    sessionRef: string
    sourceFile: string
    firstUserMessage: string | null
    timestamp: string | null
    messageCount: number
}

export interface RuntimeSessionViewResponse {
    framework: AgentFramework
    runtime: AgentRuntime
    selectedSessionRef: string | null
    currentSessionRef: string | null
    selectedCloudSessionId: string | null
    sourceFile: string | null
    rawMissingCount: number
    // Populated only when the view was requested with includeRaw; the joined
    // raw transcript can be many MB, so it is opt-in per request.
    rawLocalText: string | null
    parsedLocalMessages: ChatMessage[]
    warnings: string[]
    needsCandidatePick: boolean
    candidates: RuntimeSessionCandidate[]
}

export interface RuntimeSessionRecoverRawResponse {
    framework: AgentFramework
    sourceFile: string | null
    inserted: number
    rawMissingCount: number
    recoveredSourceCount: number
    warnings: string[]
}

export interface RuntimeSessionRebuildParsedResponse {
    session: ChatSessionSummary
    sourceFile: string | null
    rebuiltMessageCount: number
    recoveredSourceCount: number
    warnings: string[]
}

export interface RuntimeSessionRestoreResponse {
    session: ChatSessionSummary
    sourceFile: string | null
    restoredMessageCount: number
    recoveredSourceCount: number
    warnings: string[]
}

export interface ShareChatSessionResult {
    id: string
    sessionId: string
    url: string
    createdAt: string
}

export interface GetChatSessionShareResult {
    share: ShareChatSessionResult | null
}

export interface SharedChatMessage {
    id: string
    role: ChatRole
    contentBlocks: ChatContentBlock[]
    createdAt: string
    model: string | null
}

export interface SharedChatSessionPreview {
    session: {
        title: string | null
        createdAt: string
    }
    agent: {
        name: string
        framework: AgentFramework
    }
    sharedBy: string | null
    sharedAt: string
}

export interface SharedChatMessagesPage {
    messages: SharedChatMessage[]
    hasMore: boolean
    nextBefore: string | null
}
