import { fetch } from 'undici'
import type { ChatMessage } from '@manyfold/shared'
import {
    type EmittedEvent,
    type ExternalProvider,
    type InvokeInput,
    type TestConnectionInput,
    type TestConnectionResult
} from '../provider'
import { normalizeProviderEndpoint } from '../endpoint-safety'

const iterateJsonLines = async function* (
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal
): AsyncIterable<LangflowEnvelope> {
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    for await (const chunk of body) {
        if (signal.aborted) return
        buffer += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            try {
                yield JSON.parse(line) as LangflowEnvelope
            } catch {
                // ignore non-JSON lines
            }
        }
    }
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail) {
        try {
            yield JSON.parse(tail) as LangflowEnvelope
        } catch {
            // ignore
        }
    }
}

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

interface LangflowEnvelope {
    event?: string
    data?: Record<string, unknown>
}

interface LangflowEndPayload {
    result?: {
        session_id?: string
        outputs?: Array<{
            outputs?: Array<{
                results?: {
                    message?: {
                        text?: string
                        session_id?: string
                    }
                }
                outputs?: Record<string, unknown>
            }>
        }>
    }
    session_id?: string
    outputs?: Array<{
        outputs?: Array<{
            results?: {
                message?: {
                    text?: string
                    session_id?: string
                }
            }
        }>
    }>
}

const extractText = (payload: LangflowEndPayload): string | null => {
    const outputs = payload.result?.outputs ?? payload.outputs
    if (!outputs) return null
    for (const o of outputs) {
        for (const inner of o.outputs ?? []) {
            const text = inner.results?.message?.text
            if (typeof text === 'string' && text.length > 0) return text
        }
    }
    return null
}

const extractSessionId = (payload: LangflowEndPayload): string | null => {
    const fromResult = payload.result?.session_id
    if (typeof fromResult === 'string' && fromResult.length > 0)
        return fromResult
    const top = payload.session_id
    if (typeof top === 'string' && top.length > 0) return top
    const outputs = payload.result?.outputs ?? payload.outputs
    if (outputs) {
        for (const o of outputs) {
            for (const inner of o.outputs ?? []) {
                const sid = inner.results?.message?.session_id
                if (typeof sid === 'string' && sid.length > 0) return sid
            }
        }
    }
    return null
}

class LangflowProvider implements ExternalProvider {
    readonly kind = 'langflow' as const

    async *invoke(
        input: InvokeInput,
        signal: AbortSignal
    ): AsyncIterable<EmittedEvent> {
        const { config, binding, session, message } = input
        const remoteRef = binding.remoteRef as {
            flowId?: string
            tweaks?: Record<string, Record<string, unknown>>
        }
        const flowId = remoteRef.flowId
        if (!flowId) {
            yield {
                type: 'error',
                error: {
                    code: 'missing_flow_id',
                    message: 'Langflow binding has no flowId',
                    retryable: false
                }
            }
            return
        }
        const query = messageText(message)
        if (!query) {
            yield {
                type: 'error',
                error: {
                    code: 'empty_message',
                    message: 'Langflow provider received empty message',
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
        const sessionId = session.frameworkSessionRef ?? session.id
        const body: Record<string, unknown> = {
            input_value: query,
            input_type: 'chat',
            output_type: 'chat',
            session_id: sessionId
        }
        if (remoteRef.tweaks) body.tweaks = remoteRef.tweaks
        const url = `${joinUrl(endpointUrl, `/api/v1/run/${encodeURIComponent(flowId)}`)}?stream=true`
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'x-api-key': config.apiKey,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream'
            },
            body: JSON.stringify(body),
            redirect: 'error',
            signal
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            yield {
                type: 'error',
                error: {
                    code: `langflow_http_${res.status}`,
                    message:
                        text.slice(0, 512) || `Langflow returned ${res.status}`,
                    retryable: res.status >= 500
                }
            }
            return
        }
        if (!res.body) {
            yield {
                type: 'error',
                error: {
                    code: 'langflow_no_body',
                    message: 'Langflow response had no body',
                    retryable: true
                }
            }
            return
        }
        let sentSessionRef = false
        let emittedAnyToken = false
        const startedAt = Date.now()
        try {
            for await (const envelope of iterateJsonLines(res.body, signal)) {
                const event = envelope.event
                const data = envelope.data ?? {}
                if (event === 'token') {
                    const chunk =
                        typeof data.chunk === 'string'
                            ? data.chunk
                            : typeof data.token === 'string'
                              ? data.token
                              : null
                    if (chunk) {
                        emittedAnyToken = true
                        yield { type: 'token', text: chunk }
                    }
                } else if (event === 'add_message') {
                    const sender = data.sender ?? data.sender_name
                    const text =
                        typeof data.text === 'string' ? data.text : null
                    if (sender === 'AI' && text && !emittedAnyToken) {
                        emittedAnyToken = true
                        yield { type: 'token', text }
                    }
                } else if (event === 'end') {
                    const payload = data as LangflowEndPayload
                    if (!sentSessionRef) {
                        const sid = extractSessionId(payload)
                        if (sid) {
                            sentSessionRef = true
                            yield {
                                type: 'session_ref',
                                frameworkSessionRef: sid
                            }
                        }
                    }
                    if (!emittedAnyToken) {
                        const text = extractText(payload)
                        if (text) yield { type: 'token', text }
                    }
                    yield {
                        type: 'usage',
                        usage: {
                            model: input.model ?? 'langflow',
                            inputTokens: 0,
                            outputTokens: 0,
                            cacheReadTokens: 0,
                            cacheCreationTokens: 0,
                            costUsd: null,
                            costSource: 'unknown',
                            isFallbackModel: false,
                            firstTokenMs: null,
                            totalMs: Date.now() - startedAt
                        }
                    }
                    yield { type: 'done' }
                    return
                } else if (event === 'error') {
                    yield {
                        type: 'error',
                        error: {
                            code: 'langflow_error',
                            message:
                                typeof data.message === 'string'
                                    ? data.message
                                    : 'Langflow reported an error',
                            retryable: false
                        }
                    }
                    return
                }
            }
            yield { type: 'done' }
        } catch (err) {
            if (signal.aborted) return
            yield {
                type: 'error',
                error: {
                    code: 'langflow_stream_error',
                    message: (err as Error).message ?? 'stream interrupted',
                    retryable: true
                }
            }
        }
    }

    async testConnection(
        input: TestConnectionInput
    ): Promise<TestConnectionResult> {
        try {
            const endpointUrl = await normalizeProviderEndpoint(
                input.config.endpointUrl
            )
            const url = joinUrl(endpointUrl, '/api/v1/flows/')
            const res = await fetch(url, {
                redirect: 'error',
                headers: {
                    'x-api-key': input.config.apiKey
                }
            })
            if (!res.ok) {
                const text = await res.text().catch(() => '')
                return {
                    ok: false,
                    message: `${res.status} ${text.slice(0, 200)}`
                }
            }
            return { ok: true, message: 'Langflow reachable' }
        } catch (err) {
            return {
                ok: false,
                message: (err as Error).message ?? 'connection failed'
            }
        }
    }
}

export const langflowProvider = new LangflowProvider()
