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

// Durable transcript halves of the permission events below: the card must
// survive into message history exactly like tool_call/tool_result do.
export interface ChatPermissionRequestBlock {
    type: 'permission_request'
    requestId: string
    toolCallId: string | null
    title: string
    detail: string | null
    options: ChatPermissionOption[]
}

export interface ChatPermissionResolutionBlock {
    type: 'permission_resolution'
    requestId: string
    outcome: ChatPermissionOutcome
    optionId: string | null
}

export type ChatContentBlock =
    | ChatTextBlock
    | ChatAttachmentBlock
    | ChatContextRefBlock
    | ChatUploadBlock
    | ChatToolCallBlock
    | ChatToolResultBlock
    | ChatThinkingBlock
    | ChatPermissionRequestBlock
    | ChatPermissionResolutionBlock

export interface ChatMessage {
    id: string
    sessionId: string
    role: ChatRole
    contentBlocks: ChatContentBlock[]
    createdAt: string
    model?: string | null
    usage?: ChatUsage | null
    error?: ChatError | null
    // Context-window pressure at the end of the turn ({used} of {size}
    // tokens), reported by frameworks that stream it (hermes ACP
    // usage_update). Distinct from `usage`, which is billing.
    contextUsage?: ChatContextUsage | null
}

export interface ChatContextUsage {
    size: number
    used: number
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

// Mirrors hermes's own edit-approval trio (ACP session modes default /
// accept_edits / dont_ask). dontAsk is the default because it is exactly the
// pre-existing behavior: HERMES_YOLO_MODE=1 plus auto-approved permission
// asks — callers that send no mode (channels, A2A, OpenAI-compat,
// automations) keep it byte-for-byte. The ask modes drop YOLO and surface
// session/request_permission as interactive cards in the chat.
export const hermesPermissionModes = [
    'default',
    'acceptEdits',
    'dontAsk'
] as const
export type HermesPermissionMode = (typeof hermesPermissionModes)[number]
export const DEFAULT_HERMES_PERMISSION_MODE: HermesPermissionMode = 'dontAsk'

export const isHermesPermissionMode = (
    value: unknown
): value is HermesPermissionMode =>
    typeof value === 'string' &&
    hermesPermissionModes.includes(value as HermesPermissionMode)

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
    | 'permission_request'
    | 'permission_resolution'

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

// One choice the agent offered on a permission ask, in the agent's own
// vocabulary (ACP PermissionOption). kind is open-ended by design: the UI
// styles the known kinds (allow_* / reject_*) and renders unknown ones as
// plain buttons rather than dropping them.
export interface ChatPermissionOption {
    optionId: string
    name: string
    kind: string
}

export type ChatPermissionOutcome =
    | 'selected'
    | 'timeout'
    | 'cancelled'

// The agent asked the user for permission (hermes ask modes). NOT terminal —
// the turn is blocked on the answer; a request whose turn reaches a terminal
// without a resolution event was never answered (crash, cancel) and renders
// inert.
export interface ChatPermissionRequestEvent extends BaseEvent {
    type: 'permission_request'
    requestId: string
    toolCallId: string | null
    title: string
    detail: string | null
    options: ChatPermissionOption[]
}

export interface ChatPermissionResolutionEvent extends BaseEvent {
    type: 'permission_resolution'
    requestId: string
    outcome: ChatPermissionOutcome
    optionId: string | null
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
    | ChatPermissionRequestEvent
    | ChatPermissionResolutionEvent

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
    hermesPermissionMode?: HermesPermissionMode
    attachments?: CreateMessageAttachmentInput[]
    contextRefs?: CreateMessageContextRefInput[]
    uploads?: CreateMessageUploadInput[]
}

// The user's answer to a permission_request card. optionId must be one the
// request offered; the turn holder validates and 409s otherwise.
export interface AnswerPermissionRequest {
    optionId: string
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

// One row of an agent's session list: the union of what the cloud database
// holds and what the framework left on the runtime, joined on the runtime's
// own session id (chat_sessions.framework_session_ref ↔ sessionRef). A session
// can be on either side or both — a conversation started in the web app before
// its CLI wrote a transcript is cloud-only, one run directly in the terminal is
// local-only, and the usual case is both.
export interface AgentSessionListItem {
    // The runtime's own session id. Null for a cloud session that has not been
    // bound to one yet.
    sessionRef: string | null
    // The cloud chat session id, and what the chat view opens. Null for a
    // transcript that only exists on the runtime.
    cloudSessionId: string | null
    inCloud: boolean
    // Only meaningful when the response's localScan is 'ok'; a scan that never
    // ran cannot tell absence from unknown.
    inLocal: boolean
    // The cloud session's title when there is one, else the first user prompt
    // recovered from the transcript.
    title: string | null
    // Only ever set from a scanned transcript, so the reader can tell "this
    // session has no reply" from "we did not read this session's messages".
    lastAssistantMessage: string | null
    lastActiveAt: string | null
    messageCount: number
    model: string | null
    sourceFile: string | null
}

// Whether the runtime's transcripts could be read at all. A stopped sandbox or
// an offline daemon degrades to the cloud half of the list instead of failing
// the whole panel, and `inLocal` is then unknown rather than false.
export type AgentSessionLocalScan = 'ok' | 'unavailable'

// Lives in the runtime-session family because the bounded runtime scan is the
// expensive thing it exists to do once; it marks cloud presence on top of it.
export interface AgentSessionListResponse {
    framework: AgentFramework
    runtime: AgentRuntime
    localScan: AgentSessionLocalScan
    sessions: AgentSessionListItem[]
    warnings: string[]
}

export interface RuntimeSessionCandidate {
    sessionRef: string
    sourceFile: string
    firstUserMessage: string | null
    // The newest assistant reply, as one collapsed line. Null where the format
    // carries no assistant text the scan can reach.
    lastAssistantMessage: string | null
    // When the session started; falls back to the transcript's mtime.
    timestamp: string | null
    // When the session last produced a message; falls back to the mtime.
    lastActiveAt: string | null
    messageCount: number
    // The model on the newest assistant entry. Null for frameworks whose
    // transcripts do not record one.
    model: string | null
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
    // Only when the server had to pick the session itself. A view of a named
    // sessionRef scans nothing and returns an empty list.
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

// Appending the messages a framework CLI wrote to its own transcript (e.g. a
// terminal TUI that resumed the session) back into an existing cloud session,
// so the chat view reflects them. Idempotent: only the diff against the
// current cloud messages is appended, so it is safe to call on every switch
// back to chat and on session open.
export interface RuntimeSessionSyncResponse {
    appended: number
    recoveredSourceCount: number
    // 'inflight' when a live turn holds the session; 'no-session-ref' /
    // 'unsupported' when there is nothing to read. null when a read ran.
    skipped: 'inflight' | 'no-session-ref' | 'unsupported' | null
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
