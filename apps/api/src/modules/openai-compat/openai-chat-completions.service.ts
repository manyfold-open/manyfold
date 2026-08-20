import {
    CHAT_UPLOAD_MAX_FILE_BYTES,
    ChatUsage,
    CreateMessageAttachmentInput,
    CreateMessageUploadInput
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import { HttpException, Injectable } from '@nestjs/common'
import type { AuthPrincipal } from '@/modules/auth/auth-principal'
import { ChatService, type ChatTurnObserver } from '@/modules/chat/chat.service'
import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'
import { ChatApiFileService } from '@/modules/chat/api-files/chat-api-file.service'
import {
    FileSourceError,
    resolveFileInput,
    type FileInput
} from './openai-file-source'

const OPENAI_OBJECT_CHAT_COMPLETION = 'chat.completion'
const OPENAI_OBJECT_CHAT_COMPLETION_CHUNK = 'chat.completion.chunk'

export interface OpenAiChatCompletionPreparedTurn {
    id: string
    created: number
    agentId: string
    sessionId: string
    prompt: string
    stream: boolean
    includeUsage: boolean
    attachments: CreateMessageAttachmentInput[]
    uploads: CreateMessageUploadInput[]
}

export interface OpenAiChatCompletionChunk {
    id: string
    object: typeof OPENAI_OBJECT_CHAT_COMPLETION_CHUNK
    created: number
    model: string
    choices: Array<{
        index: number
        delta: Record<string, unknown>
        finish_reason: string | null
    }>
    usage?: OpenAiUsage | null
}

export interface OpenAiChatCompletionResponse {
    id: string
    object: typeof OPENAI_OBJECT_CHAT_COMPLETION
    created: number
    model: string
    choices: Array<{
        index: number
        message: {
            role: 'assistant'
            content: string
            reasoning_content?: string
        }
        finish_reason: string
    }>
    usage: OpenAiUsage | null
    metadata: {
        // public field names are intentionally brand-neutral; do not add a prefix
        session_id: string
        assistant_message_id: string
    }
}

export interface OpenAiUsage {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
}

interface ParsedOpenAiRequest {
    agentId: string
    prompt: string
    files: FileInput[]
    stream: boolean
    includeUsage: boolean
    sessionId: string | null
}

interface OpenAiMessage {
    role?: unknown
    content?: unknown
    tool_calls?: unknown
    function_call?: unknown
}

interface TurnState {
    observe: ChatTurnObserver
    done: Promise<TurnOutcome>
    text: () => string
    reasoning: () => string
    replacement: () => string | null
    usage: () => ChatUsage | null
}

export type OpenAiDelta = { channel: 'content' | 'reasoning'; text: string }

interface TurnOutcome {
    error: OpenAiCompatError | null
}

@Injectable()
export class OpenAiChatCompletionsService {
    constructor(
        private readonly chat: ChatService,
        private readonly apiFiles: ChatApiFileService
    ) {}

    async prepare(
        user: AuthPrincipal,
        body: unknown
    ): Promise<OpenAiChatCompletionPreparedTurn> {
        const parsed = parseOpenAiRequest(body)
        const session =
            parsed.sessionId === null
                ? await this.chat.createSession(user.userId, parsed.agentId)
                : await this.chat.subscribeStream(
                      user.userId,
                      parsed.agentId,
                      parsed.sessionId
                  )

        // Resolve + ingest files HERE (before any streaming headers) so a file
        // error surfaces as a normal HTTP 4xx instead of a mid-stream SSE event.
        let attachments: CreateMessageAttachmentInput[] = []
        let uploads: CreateMessageUploadInput[] = []
        if (parsed.files.length > 0) {
            const resolved = await Promise.all(
                parsed.files.map((file) =>
                    resolveFileInput(file, CHAT_UPLOAD_MAX_FILE_BYTES).catch(
                        (err: unknown) => {
                            if (err instanceof FileSourceError)
                                throw new OpenAiCompatError(
                                    400,
                                    err.message,
                                    'invalid_request_error',
                                    'invalid_file'
                                )
                            throw err
                        }
                    )
                )
            )
            const ingested = await this.apiFiles.ingest({
                userId: user.userId,
                agentId: parsed.agentId,
                sessionId: session.id,
                files: resolved
            })
            attachments = ingested.attachments
            uploads = ingested.uploads
        }

        return {
            id: `chatcmpl_${randomUUID()}`,
            created: Math.floor(Date.now() / 1000),
            agentId: parsed.agentId,
            sessionId: session.id,
            prompt: parsed.prompt,
            stream: parsed.stream,
            includeUsage: parsed.includeUsage,
            attachments,
            uploads
        }
    }

    createTurnState(): TurnState {
        let doneResolve!: (outcome: TurnOutcome) => void
        let settled = false
        let text = ''
        let reasoning = ''
        let replacement: string | null = null
        let usage: ChatUsage | null = null
        const done = new Promise<TurnOutcome>((resolve) => {
            doneResolve = resolve
        })
        const settle = (outcome: TurnOutcome): void => {
            if (settled) return
            settled = true
            doneResolve(outcome)
        }

        return {
            observe: (event): void => {
                // Output moderation supersedes the answer streamed so far. The
                // wire cannot take deltas back, so only this accumulator can be
                // made correct — see buildDoneChunk's content_filter reason.
                if (event.type === 'replace') {
                    text = event.text
                    replacement = event.text
                    return
                }
                // Same mapper the streaming path uses, so a client that
                // concatenates deltas ends up with exactly these two strings.
                const delta = openAiDeltaForEvent(event)
                if (delta) {
                    if (delta.channel === 'reasoning') reasoning += delta.text
                    else text += delta.text
                    return
                }
                if (event.type === 'usage') {
                    usage = event.usage
                    return
                }
                if (event.type === 'error') {
                    settle({
                        error: new OpenAiCompatError(
                            502,
                            event.error.message,
                            'api_error',
                            event.error.code
                        )
                    })
                    return
                }
                if (event.type === 'done') settle({ error: null })
            },
            done,
            text: () => text,
            reasoning: () => reasoning,
            replacement: () => replacement,
            usage: () => usage
        }
    }

    async startTurn(
        user: AuthPrincipal,
        turn: OpenAiChatCompletionPreparedTurn,
        observer: ChatTurnObserver
    ): Promise<{ userMessageId: string; assistantMessageId: string }> {
        const sent = await this.chat.sendMessage(
            user.userId,
            turn.agentId,
            turn.sessionId,
            turn.prompt,
            turn.attachments,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            observer,
            [],
            turn.uploads
        )
        return {
            userMessageId: sent.userMessage.id,
            assistantMessageId: sent.assistantMessageId
        }
    }

    buildRoleChunk(
        turn: OpenAiChatCompletionPreparedTurn
    ): OpenAiChatCompletionChunk {
        return buildChunk(turn, { role: 'assistant' }, null)
    }

    buildDeltaChunk(
        turn: OpenAiChatCompletionPreparedTurn,
        delta: OpenAiDelta
    ): OpenAiChatCompletionChunk {
        return buildChunk(
            turn,
            delta.channel === 'reasoning'
                ? { reasoning_content: delta.text }
                : { content: delta.text },
            null
        )
    }

    // A moderated turn ends on content_filter: the answer the caller already
    // received was superseded, and only that reason says so on the wire.
    buildDoneChunk(
        turn: OpenAiChatCompletionPreparedTurn,
        replaced = false
    ): OpenAiChatCompletionChunk {
        return buildChunk(turn, {}, replaced ? 'content_filter' : 'stop')
    }

    buildUsageChunk(
        turn: OpenAiChatCompletionPreparedTurn,
        usage: ChatUsage | null
    ): OpenAiChatCompletionChunk {
        return {
            id: turn.id,
            object: OPENAI_OBJECT_CHAT_COMPLETION_CHUNK,
            created: turn.created,
            model: turn.agentId,
            choices: [],
            usage: usage ? toOpenAiUsage(usage) : null
        }
    }

    buildFinalResponse(input: {
        turn: OpenAiChatCompletionPreparedTurn
        assistantMessageId: string
        text: string
        reasoning: string
        replaced: boolean
        usage: ChatUsage | null
    }): OpenAiChatCompletionResponse {
        return {
            id: input.turn.id,
            object: OPENAI_OBJECT_CHAT_COMPLETION,
            created: input.turn.created,
            model: input.turn.agentId,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: input.text,
                        ...(input.reasoning
                            ? { reasoning_content: input.reasoning }
                            : {})
                    },
                    finish_reason: input.replaced ? 'content_filter' : 'stop'
                }
            ],
            usage: input.usage ? toOpenAiUsage(input.usage) : null,
            metadata: {
                session_id: input.turn.sessionId,
                assistant_message_id: input.assistantMessageId
            }
        }
    }
}

export class OpenAiCompatError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly type: string,
        readonly code: string
    ) {
        super(message)
        this.name = 'OpenAiCompatError'
    }
}

export const openAiErrorBody = (
    error: OpenAiCompatError
): {
    error: {
        message: string
        type: string
        code: string
    }
} => ({
    error: {
        message: error.message,
        type: error.type,
        code: error.code
    }
})

export const toOpenAiCompatError = (err: unknown): OpenAiCompatError => {
    if (err instanceof OpenAiCompatError) return err
    if (err instanceof HttpException) {
        const status = err.getStatus()
        const body = err.getResponse()
        const message =
            typeof body === 'string'
                ? body
                : Array.isArray((body as { message?: unknown }).message)
                  ? ((body as { message: string[] }).message[0] ?? err.message)
                  : String(
                        (body as { message?: unknown }).message ?? err.message
                    )
        const bodyCode =
            typeof body === 'object' &&
            body !== null &&
            typeof (body as { code?: unknown }).code === 'string'
                ? (body as { code: string }).code
                : null
        return new OpenAiCompatError(
            status,
            message,
            typeForStatus(status),
            bodyCode ?? defaultCodeForStatus(status)
        )
    }
    return new OpenAiCompatError(
        500,
        'Internal server error',
        'api_error',
        'internal_error'
    )
}

// Reasoning rides its own channel (the de-facto `reasoning_content` convention)
// so `content` stays the answer the caller asked for.
export const openAiDeltaForEvent = (
    event: EmittedChatEvent
): OpenAiDelta | null => {
    if (event.type === 'token') return { channel: 'content', text: event.text }
    if (event.type === 'thinking')
        return { channel: 'reasoning', text: event.text }
    if (event.type === 'tool_call')
        return {
            channel: 'content',
            text: formatTaggedContent(
                `tool_call:${event.toolName}`,
                stableJson(event.args)
            )
        }
    if (event.type === 'tool_result')
        return {
            channel: 'content',
            text: formatTaggedContent(
                `tool_result:${event.toolCallId}`,
                stableJson(event.result)
            )
        }
    return null
}

export const parseOpenAiRequest = (body: unknown): ParsedOpenAiRequest => {
    if (!isRecord(body))
        throw new OpenAiCompatError(
            400,
            'Request body must be a JSON object',
            'invalid_request_error',
            'invalid_request'
        )

    const model = normalizeString(body.model)
    if (!model)
        throw new OpenAiCompatError(
            400,
            'model is required and must be a Manyfold agent id',
            'invalid_request_error',
            'missing_model'
        )

    const messages = body.messages
    if (!Array.isArray(messages) || messages.length === 0)
        throw new OpenAiCompatError(
            400,
            'messages must be a non-empty array',
            'invalid_request_error',
            'invalid_messages'
        )

    rejectToolFields(body)
    validateNumberField(body, 'temperature')
    validateNumberField(body, 'top_p')
    validateNumberField(body, 'max_tokens')

    const stream = body.stream === undefined ? false : body.stream
    if (typeof stream !== 'boolean')
        throw new OpenAiCompatError(
            400,
            'stream must be a boolean when provided',
            'invalid_request_error',
            'invalid_stream'
        )

    const metadata =
        body.metadata === undefined || body.metadata === null
            ? {}
            : isRecord(body.metadata)
              ? body.metadata
              : null
    if (metadata === null)
        throw new OpenAiCompatError(
            400,
            'metadata must be an object when provided',
            'invalid_request_error',
            'invalid_metadata'
        )

    const streamOptions =
        body.stream_options === undefined || body.stream_options === null
            ? {}
            : isRecord(body.stream_options)
              ? body.stream_options
              : null
    if (streamOptions === null)
        throw new OpenAiCompatError(
            400,
            'stream_options must be an object when provided',
            'invalid_request_error',
            'invalid_stream_options'
        )

    const prompt = promptFromMessages(messages as OpenAiMessage[])
    const files = fileInputsFromMessages(messages as OpenAiMessage[])
    if (!prompt && files.length === 0)
        throw new OpenAiCompatError(
            400,
            'messages must contain at least one text or file content item',
            'invalid_request_error',
            'empty_messages'
        )

    return {
        agentId: model,
        prompt,
        files,
        stream,
        includeUsage: streamOptions.include_usage === true,
        sessionId: normalizeString(metadata.session_id)
    }
}

// Files attach to the latest user turn only. Earlier messages' file parts were
// already sent on prior turns; they are skipped here (and by contentToText).
const fileInputsFromMessages = (messages: OpenAiMessage[]): FileInput[] => {
    let lastUser: OpenAiMessage | null = null
    for (const message of messages)
        if (isRecord(message) && normalizeString(message.role) === 'user')
            lastUser = message
    if (!lastUser || !Array.isArray(lastUser.content)) return []
    const inputs: FileInput[] = []
    for (const part of lastUser.content) {
        if (!isRecord(part)) continue
        if (part.type === 'image_url') {
            const url = isRecord(part.image_url)
                ? normalizeString(part.image_url.url)
                : null
            if (url) inputs.push(toFileInput(url))
        } else if (part.type === 'file') {
            const file = isRecord(part.file) ? part.file : null
            const data = file ? normalizeString(file.file_data) : null
            if (data)
                inputs.push({
                    ...toFileInput(data),
                    filename:
                        (file && normalizeString(file.filename)) || undefined
                })
        }
    }
    return inputs
}

const toFileInput = (url: string): FileInput =>
    url.startsWith('data:')
        ? { kind: 'data', value: url }
        : { kind: 'url', value: url }

const promptFromMessages = (messages: OpenAiMessage[]): string => {
    const blocks: string[] = []
    for (const message of messages) {
        if (!isRecord(message))
            throw new OpenAiCompatError(
                400,
                'each message must be an object',
                'invalid_request_error',
                'invalid_message'
            )
        if (
            message.tool_calls !== undefined ||
            message.function_call !== undefined
        )
            throw new OpenAiCompatError(
                400,
                'tool calls are not supported by this endpoint',
                'invalid_request_error',
                'unsupported_tool_calls'
            )
        const role = normalizeString(message.role)
        if (!role)
            throw new OpenAiCompatError(
                400,
                'message role is required',
                'invalid_request_error',
                'missing_message_role'
            )
        if (!['system', 'developer', 'user', 'assistant'].includes(role))
            throw new OpenAiCompatError(
                400,
                `message role '${role}' is not supported`,
                'invalid_request_error',
                'unsupported_message_role'
            )
        const content = contentToText(message.content)
        if (!content) continue
        blocks.push(`${roleLabel(role)}:\n${content}`)
    }
    return blocks.join('\n\n').trim()
}

const contentToText = (content: unknown): string => {
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content))
        throw new OpenAiCompatError(
            400,
            'message content must be a string or an array of text parts',
            'invalid_request_error',
            'unsupported_message_content'
        )
    const textParts: string[] = []
    for (const part of content) {
        if (!isRecord(part))
            throw unsupportedContentError()
        // image_url/file parts are handled by fileInputsFromMessages; skip them
        // here (in every message) so replayed multimodal history doesn't error.
        if (part.type === 'image_url' || part.type === 'file') continue
        if (part.type !== 'text' || typeof part.text !== 'string')
            throw unsupportedContentError()
        const text = part.text.trim()
        if (text) textParts.push(text)
    }
    return textParts.join('\n').trim()
}

const unsupportedContentError = (): OpenAiCompatError =>
    new OpenAiCompatError(
        400,
        'unsupported message content part',
        'invalid_request_error',
        'unsupported_message_content'
    )

const rejectToolFields = (body: Record<string, unknown>): void => {
    if (Array.isArray(body.tools) && body.tools.length > 0)
        throw unsupportedToolsError()
    if (Array.isArray(body.functions) && body.functions.length > 0)
        throw unsupportedToolsError()
    if (body.tool_choice !== undefined && body.tool_choice !== 'none')
        throw unsupportedToolsError()
    if (body.function_call !== undefined && body.function_call !== 'none')
        throw unsupportedToolsError()
}

const unsupportedToolsError = (): OpenAiCompatError =>
    new OpenAiCompatError(
        400,
        'tool calling is not supported by this endpoint',
        'invalid_request_error',
        'unsupported_tools'
    )

const validateNumberField = (
    body: Record<string, unknown>,
    key: string
): void => {
    if (body[key] === undefined || body[key] === null) return
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key]))
        throw new OpenAiCompatError(
            400,
            `${key} must be a finite number when provided`,
            'invalid_request_error',
            `invalid_${key}`
        )
}

const buildChunk = (
    turn: OpenAiChatCompletionPreparedTurn,
    delta: Record<string, unknown>,
    finishReason: string | null
): OpenAiChatCompletionChunk => ({
    id: turn.id,
    object: OPENAI_OBJECT_CHAT_COMPLETION_CHUNK,
    created: turn.created,
    model: turn.agentId,
    choices: [
        {
            index: 0,
            delta,
            finish_reason: finishReason
        }
    ]
})

const toOpenAiUsage = (usage: ChatUsage): OpenAiUsage => ({
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens
})

const roleLabel = (role: string): string => {
    if (role === 'system') return 'System'
    if (role === 'developer') return 'Developer'
    if (role === 'assistant') return 'Assistant'
    return 'User'
}

const formatTaggedContent = (label: string, text: string): string => {
    const trimmed = text.trim()
    if (!trimmed) return ''
    return `\n\n[${label}]\n${trimmed}`
}

const normalizeString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)

const stableJson = (value: unknown): string => {
    if (value === undefined) return 'undefined'
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`
}

const typeForStatus = (status: number): string => {
    if (status === 401) return 'authentication_error'
    if (status === 429) return 'rate_limit_error'
    return 'invalid_request_error'
}

const defaultCodeForStatus = (status: number): string => {
    if (status === 401) return 'invalid_api_key'
    if (status === 403) return 'permission_denied'
    if (status === 404) return 'agent_not_found'
    if (status === 429) return 'rate_limit_exceeded'
    if (status >= 500) return 'internal_error'
    return 'bad_request'
}
