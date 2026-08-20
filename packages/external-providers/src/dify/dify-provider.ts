import { fetch, File, FormData } from 'undici'
import type { ChatError, ChatMessage } from '@manyfold/shared'
import {
    type ConvergeInput,
    type ConvergeOutcome,
    type EmittedEvent,
    type ExternalProvider,
    type InvokeFile,
    type InvokeInput,
    type ProviderLogger,
    type TestConnectionInput,
    type TestConnectionResult
} from '../provider'
import { normalizeProviderEndpoint } from '../endpoint-safety'
import { parseSseStream } from '../sse/sse-parser'
import { withUpstreamCancel } from '../upstream-cancel'

const messageText = (msg: ChatMessage): string => {
    const parts: string[] = []
    for (const block of msg.contentBlocks) {
        if (block.type === 'text') parts.push(block.text)
    }
    return parts.join('\n').trim()
}

const joinUrl = (base: string, path: string): string => {
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${trimmed}${suffix}`
}

const isDifyConversationNotFound = (
    code?: string,
    message?: string
): boolean => {
    const text = `${code ?? ''} ${message ?? ''}`.toLowerCase()
    return (
        text.includes('conversationnotexistserror') ||
        text.includes('conversation_not_exists') ||
        text.includes('conversation not exists') ||
        text.includes('conversation not found') ||
        (text.includes('conversation') && text.includes('not exist'))
    )
}

interface DifyMessageEvent {
    event?: string
    task_id?: string
    conversation_id?: string
    // Names the answer row in the conversation. Carried by every answer-bearing
    // chunk (message / agent_message / agent_thought / message_end /
    // message_replace) but NOT by the workflow_started / node_* chunks, so a
    // chatflow killed before its first answer chunk never reveals one — which
    // is exactly the turn that stays unrecoverable.
    message_id?: string
    answer?: string
    thought?: string
    observation?: string
    tool?: string
    tool_input?: unknown
    metadata?: {
        usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            total_price?: string | number
        }
    }
    message?: string
    code?: string
    status?: number
    reason?: string
    data?: DifyEventData
}

// reasoning_chunk and agent_log carry their payload under `data`, unlike the
// message/agent_thought events which are flat.
interface DifyEventData {
    reasoning?: string
    is_final?: boolean
    id?: string
    label?: string
    status?: string
    error?: string | null
    data?: unknown
}

// Parsed here rather than inside the invoke loop so the id harvest can read
// task_id from the same items the consumer sees, without re-parsing raw SSE.
const parseDifyEvents = async function* (
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal
): AsyncIterable<DifyMessageEvent> {
    for await (const sse of parseSseStream(body, signal)) {
        if (!sse.data) continue
        let payload: DifyMessageEvent
        try {
            payload = JSON.parse(sse.data) as DifyMessageEvent
        } catch {
            continue
        }
        if (!payload.event) payload.event = sse.event
        yield payload
    }
}

// GET /messages row. `status`/`error` are the only failure signal the list API
// exposes; `answer` is the complete answer once generation ends.
interface DifyHistoryMessage {
    id?: string
    answer?: string
    status?: string
    error?: string | null
}

interface DifyUploadResponse {
    id?: string
    mime_type?: string
}

interface DifyFileRef {
    type: string
    transfer_method: 'local_file'
    upload_file_id: string
}

const difyFileType = (contentType: string): string => {
    const mime = contentType.toLowerCase()
    if (mime.startsWith('image/')) return 'image'
    if (mime.startsWith('audio/')) return 'audio'
    if (mime.startsWith('video/')) return 'video'
    return 'document'
}

class DifyProvider implements ExternalProvider {
    readonly kind = 'dify' as const

    async *invoke(
        input: InvokeInput,
        signal: AbortSignal
    ): AsyncIterable<EmittedEvent> {
        // An AbortSignal never replays to a listener registered after the fact,
        // so a turn that was already cancelled before invoke ran would upload,
        // POST and be billed for a task nobody is left to read (#402).
        if (signal.aborted) return
        const { config, binding, session, message } = input
        const remoteRef = binding.remoteRef as {
            appId?: string
            userIdentifier?: string
        }
        const userIdentifier = remoteRef.userIdentifier ?? session.id
        const files = input.files ?? []
        const text = messageText(message)
        if (!text && files.length === 0) {
            yield {
                type: 'error',
                error: {
                    code: 'empty_message',
                    message: 'Dify provider received empty message',
                    retryable: false
                }
            }
            return
        }
        let endpointUrl: string
        try {
            endpointUrl = await normalizeProviderEndpoint(config.endpointUrl)
        } catch (err) {
            yield {
                type: 'error',
                error: {
                    code: 'unsafe_provider_endpoint',
                    message: (err as Error).message,
                    retryable: false
                }
            }
            return
        }
        // Dify scopes an uploaded file to the user that uploaded it, so the
        // upload and the chat-messages call must share one user identifier.
        let uploadedFiles: DifyFileRef[] = []
        if (files.length > 0) {
            const uploaded = await this.uploadFiles(
                endpointUrl,
                config.apiKey,
                userIdentifier,
                files,
                signal
            )
            if (!uploaded.ok) {
                yield { type: 'error', error: uploaded.error }
                return
            }
            uploadedFiles = uploaded.files
        }
        const body = {
            inputs: {},
            // Dify rejects an empty query; a file-only message sends a space.
            query: text || ' ',
            response_mode: 'streaming',
            conversation_id: session.frameworkSessionRef ?? '',
            user: userIdentifier,
            ...(uploadedFiles.length > 0 ? { files: uploadedFiles } : {})
        }
        const url = joinUrl(endpointUrl, 'chat-messages')
        const startedAt = Date.now()
        // The caller's signal never reaches the request or its body: aborting
        // those is what used to destroy the only channel that can still name
        // the upstream task (#402). Until Dify has answered there is no
        // accepted task to name, so an abort in that window still tears the
        // request down outright.
        const upstream = new AbortController()
        let harvesting = false
        const abortBeforeResponse = (): void => {
            if (!harvesting) upstream.abort()
        }
        // The endpoint check and the uploads above are awaited, so the caller
        // can have gone in the meantime — and this listener would never fire.
        if (signal.aborted) return
        signal.addEventListener('abort', abortBeforeResponse, { once: true })
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream'
            },
            body: JSON.stringify(body),
            redirect: 'error',
            signal: upstream.signal
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const staleSessionRef = isDifyConversationNotFound(
                undefined,
                text
            )
            yield {
                type: 'error',
                error: {
                    code: staleSessionRef
                        ? 'dify_session_not_found'
                        : `dify_http_${res.status}`,
                    message:
                        text.slice(0, 512) || `Dify returned ${res.status}`,
                    retryable: staleSessionRef || res.status >= 500
                }
            }
            return
        }
        if (!res.body) {
            yield {
                type: 'error',
                error: {
                    code: 'dify_no_body',
                    message: 'Dify response had no body',
                    retryable: true
                }
            }
            return
        }
        let sentSessionRef = false
        let firstTokenAt: number | null = null
        // Aborting the fetch only stops DELIVERY: Dify keeps executing (and
        // billing) the task server-side. Every stream chunk carries the
        // task_id that names it to the Stop Generate API, so a user cancel
        // best-effort stops the upstream task too — including when the abort
        // lands before the first chunk, which the bounded harvest below waits
        // out on its own lifetime.
        harvesting = true
        const events = withUpstreamCancel<DifyMessageEvent>({
            source: parseDifyEvents(res.body, upstream.signal),
            callerSignal: signal,
            upstream,
            upstreamStarted: true,
            taskIdOf: (payload) => payload.task_id ?? null,
            cancelUpstream: (taskId) => {
                void this.stopTask(
                    endpointUrl,
                    config.apiKey,
                    userIdentifier,
                    taskId,
                    input.logger
                )
            },
            skipped: (reason, windowMs) => {
                input.logger?.warn(
                    `dify upstream_cancel=skipped_no_task_id reason=${reason} windowMs=${windowMs} user=${userIdentifier}`
                )
            }
        })
        let sentTaskId: string | null = null
        let sentUpstreamMessageId: string | null = null
        try {
            for await (const payload of events) {
                if (payload.conversation_id && !sentSessionRef) {
                    sentSessionRef = true
                    yield {
                        type: 'session_ref',
                        frameworkSessionRef: payload.conversation_id
                    }
                }
                // Emitted before the event switch so an `error` chunk (which
                // still carries task_id) surrenders the ref too, and re-emitted
                // when the second half arrives on a later chunk.
                if (
                    (payload.task_id && payload.task_id !== sentTaskId) ||
                    (payload.message_id &&
                        payload.message_id !== sentUpstreamMessageId)
                ) {
                    if (payload.task_id) sentTaskId = payload.task_id
                    if (payload.message_id)
                        sentUpstreamMessageId = payload.message_id
                    yield {
                        type: 'upstream_ref',
                        ...(sentTaskId ? { taskId: sentTaskId } : {}),
                        ...(sentUpstreamMessageId
                            ? { upstreamMessageId: sentUpstreamMessageId }
                            : {})
                    }
                }
                const evt = payload.event
                if (evt === 'message' || evt === 'agent_message') {
                    if (payload.answer) {
                        if (firstTokenAt === null) firstTokenAt = Date.now()
                        yield { type: 'token', text: payload.answer }
                    }
                } else if (evt === 'reasoning_chunk') {
                    // Chatflow LLM nodes in "separated" reasoning mode stream the
                    // chain-of-thought here instead of inline in the answer. The
                    // terminal marker carries an empty string.
                    const reasoning = payload.data?.reasoning
                    if (reasoning) yield { type: 'thinking', text: reasoning }
                } else if (evt === 'message_replace') {
                    // Output moderation runs on a background thread and can
                    // fire mid-stream, more than once. `answer` is always the
                    // whole answer as it should now read, not a delta.
                    yield {
                        type: 'replace',
                        text: payload.answer ?? '',
                        reason: payload.reason ?? 'output_moderation'
                    }
                } else if (evt === 'agent_log') {
                    yield* this.agentLogEvents(payload.data)
                } else if (evt === 'agent_thought') {
                    if (payload.thought)
                        yield { type: 'thinking', text: payload.thought }
                    if (payload.tool && payload.tool_input !== undefined) {
                        yield {
                            type: 'tool_call',
                            toolCallId: `dify_${Date.now()}`,
                            toolName: payload.tool,
                            args: payload.tool_input
                        }
                    }
                    if (payload.observation) {
                        yield {
                            type: 'tool_result',
                            toolCallId: `dify_${Date.now()}`,
                            result: payload.observation
                        }
                    }
                } else if (evt === 'message_end') {
                    const usage = payload.metadata?.usage
                    if (usage) {
                        yield {
                            type: 'usage',
                            usage: {
                                model: input.model ?? 'dify',
                                inputTokens: Number(usage.prompt_tokens ?? 0),
                                outputTokens: Number(
                                    usage.completion_tokens ?? 0
                                ),
                                cacheReadTokens: 0,
                                cacheCreationTokens: 0,
                                costUsd:
                                    usage.total_price !== undefined
                                        ? Number(usage.total_price)
                                        : null,
                                costSource: 'upstream',
                                isFallbackModel: false,
                                firstTokenMs:
                                    firstTokenAt !== null
                                        ? firstTokenAt - startedAt
                                        : null,
                                totalMs: Date.now() - startedAt
                            }
                        }
                    }
                    yield { type: 'done' }
                    return
                } else if (evt === 'error') {
                    const staleSessionRef = isDifyConversationNotFound(
                        payload.code,
                        payload.message
                    )
                    yield {
                        type: 'error',
                        error: {
                            code: staleSessionRef
                                ? 'dify_session_not_found'
                                : (payload.code ?? 'dify_error'),
                            message:
                                payload.message ?? 'Dify reported an error',
                            retryable: staleSessionRef
                        }
                    }
                    return
                }
            }
            // A cancelled turn ends silently: the harvest keeps reading past
            // this point on its own lifetime, and the caller already knows the
            // terminal is cancelled_by_user.
            if (signal.aborted) return
            yield { type: 'done' }
        } catch (err) {
            if (signal.aborted) return
            yield {
                type: 'error',
                error: {
                    code: 'dify_stream_error',
                    message: (err as Error).message ?? 'stream interrupted',
                    retryable: true
                }
            }
        }
    }

    // Ask the conversation-history API what became of a turn whose relay died.
    // Dify has no mid-turn re-attach, but the answer row is durable: once the
    // task finishes, GET /messages returns it with the complete answer, so a
    // deploy-orphaned turn can be delivered in full instead of being reported
    // as a retryable restart while the paid-for answer sits upstream (#670).
    //
    // The row exists from the moment generation starts, with `answer` empty
    // until it completes — so "row present, answer empty, no error" is the
    // still-running signal. That is a read of Dify's behaviour, not a
    // documented status field (the list API reports only normal/error), which
    // is why the caller must bound its own polling rather than trust a
    // terminal here.
    async converge(
        input: ConvergeInput,
        signal: AbortSignal
    ): Promise<ConvergeOutcome> {
        const conversationId = input.session.frameworkSessionRef
        const messageId = input.ref.upstreamMessageId
        // The messages API can only be queried by conversation, and only the
        // message id identifies WHICH answer is this turn's. Without both, a
        // "recovery" would be a guess at the newest row — which is another
        // turn's answer whenever the session was reused.
        if (!conversationId || !messageId)
            return {
                status: 'failed',
                error: {
                    code: 'dify_converge_no_ref',
                    message:
                        'the interrupted Dify turn has no upstream message reference',
                    retryable: true
                }
            }
        const remoteRef = input.binding.remoteRef as {
            userIdentifier?: string
        }
        const user = remoteRef.userIdentifier ?? input.session.id
        const endpointUrl = await normalizeProviderEndpoint(
            input.config.endpointUrl
        )
        const url = new URL(joinUrl(endpointUrl, 'messages'))
        url.searchParams.set('conversation_id', conversationId)
        url.searchParams.set('user', user)
        url.searchParams.set('limit', '100')
        const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${input.config.apiKey}` },
            redirect: 'error',
            signal
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            // 5xx is transient — surfacing it as a terminal would burn the
            // recovery on a blip. The caller counts these and gives up on a
            // streak, so throwing is the way to say "ask again".
            if (res.status >= 500)
                throw new Error(
                    `dify messages returned ${res.status}: ${text.slice(0, 200)}`
                )
            return {
                status: 'failed',
                error: {
                    code: `dify_http_${res.status}`,
                    message:
                        text.slice(0, 512) || `Dify returned ${res.status}`,
                    retryable: true
                }
            }
        }
        const payload = (await res.json().catch(() => null)) as {
            data?: DifyHistoryMessage[]
        } | null
        const row = (payload?.data ?? []).find((m) => m.id === messageId)
        // Not listed yet (Dify writes the row asynchronously on some versions)
        // reads the same as "not finished": keep asking.
        if (!row) return { status: 'running' }
        if (row.status === 'error' || row.error)
            return {
                status: 'failed',
                error: {
                    code: 'dify_upstream_failed',
                    message:
                        row.error ?? 'the Dify task failed after the restart',
                    retryable: true
                }
            }
        if (!row.answer) return { status: 'running' }
        return { status: 'completed', text: row.answer }
    }

    // Dify service API "Stop Generate": POST /chat-messages/{task_id}/stop
    // with the SAME user identifier as the generate call (Dify scopes the
    // task to it). Best-effort: the local turn is already terminalizing as
    // cancelled, so failure here only means the upstream task keeps running.
    private async stopTask(
        endpointUrl: string,
        apiKey: string,
        user: string,
        taskId: string,
        logger?: ProviderLogger
    ): Promise<void> {
        const url = joinUrl(
            endpointUrl,
            `chat-messages/${encodeURIComponent(taskId)}/stop`
        )
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ user }),
                redirect: 'error',
                signal: AbortSignal.timeout(10_000)
            })
            if (!res.ok) {
                const text = await res.text().catch(() => '')
                logger?.warn(
                    `dify upstream stop returned ${res.status} for task=${taskId}: ${text.slice(0, 200)}`
                )
            }
        } catch (err) {
            logger?.warn(
                `dify upstream stop failed for task=${taskId}: ${(err as Error).message}`
            )
        }
    }

    // Agent nodes report each round and each step here while they run, long
    // before any answer token exists.
    private *agentLogEvents(
        data: DifyEventData | undefined
    ): Generator<EmittedEvent> {
        if (!data?.id) return
        if (data.status === 'start') {
            yield {
                type: 'tool_call',
                toolCallId: data.id,
                toolName: data.label ?? 'agent',
                args: data.data ?? {}
            }
            return
        }
        if (data.status === 'success' || data.status === 'error')
            yield {
                type: 'tool_result',
                toolCallId: data.id,
                result: data.error ?? data.data ?? {}
            }
    }

    private async uploadFiles(
        endpointUrl: string,
        apiKey: string,
        user: string,
        files: InvokeFile[],
        signal: AbortSignal
    ): Promise<
        { ok: true; files: DifyFileRef[] } | { ok: false; error: ChatError }
    > {
        const url = joinUrl(endpointUrl, 'files/upload')
        const refs: DifyFileRef[] = []
        for (const file of files) {
            const buffer = await file.read()
            const form = new FormData()
            form.append(
                'file',
                new File([buffer], file.name, { type: file.contentType })
            )
            form.append('user', user)
            const res = await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}` },
                body: form,
                redirect: 'error',
                signal
            })
            if (!res.ok) {
                const text = await res.text().catch(() => '')
                return {
                    ok: false,
                    error: {
                        code: `dify_upload_http_${res.status}`,
                        message:
                            text.slice(0, 512) ||
                            `Dify file upload returned ${res.status}`,
                        retryable: res.status >= 500
                    }
                }
            }
            const payload = (await res.json().catch(() => null)) as
                | DifyUploadResponse
                | null
            if (!payload?.id) {
                return {
                    ok: false,
                    error: {
                        code: 'dify_upload_no_id',
                        message: 'Dify file upload did not return an id',
                        retryable: false
                    }
                }
            }
            refs.push({
                type: difyFileType(file.contentType || payload.mime_type || ''),
                transfer_method: 'local_file',
                upload_file_id: payload.id
            })
        }
        return { ok: true, files: refs }
    }

    async testConnection(
        input: TestConnectionInput
    ): Promise<TestConnectionResult> {
        try {
            const endpointUrl = await normalizeProviderEndpoint(
                input.config.endpointUrl
            )
            const url = joinUrl(endpointUrl, 'parameters')
            const res = await fetch(url, {
                redirect: 'error',
                headers: {
                    Authorization: `Bearer ${input.config.apiKey}`
                }
            })
            if (!res.ok) {
                const text = await res.text().catch(() => '')
                return {
                    ok: false,
                    message: `${res.status} ${text.slice(0, 200)}`
                }
            }
            return { ok: true, message: 'Dify reachable' }
        } catch (err) {
            return {
                ok: false,
                message: (err as Error).message ?? 'connection failed'
            }
        }
    }
}

export const difyProvider = new DifyProvider()
