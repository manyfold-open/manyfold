import { guardedFetch, type UrlGuardOptions } from './url-guard'
import { parseSseStream } from './sse'
import { A2aError, A2aErrorCode, A2aTransportError } from './errors'
import {
    A2aMethod,
    type A2aStreamEvent,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type Message,
    type MessageSendParams,
    type Task,
    type TaskIdParams,
    type TaskQueryParams
} from './types'

export interface A2aClientOptions extends UrlGuardOptions {
    endpointUrl: string
    bearer?: string
}

let requestCounter = 0

export const nextRequestId = (): string => {
    requestCounter += 1
    return `req-${requestCounter}`
}

export const buildJsonRpcRequest = <P>(
    method: string,
    params: P,
    id: string | number = nextRequestId()
): JsonRpcRequest<P> => ({
    jsonrpc: '2.0',
    id,
    method,
    params
})

export const parseJsonRpcResult = <R>(raw: string): R => {
    let parsed: JsonRpcResponse<R>
    try {
        parsed = JSON.parse(raw) as JsonRpcResponse<R>
    } catch {
        throw new A2aError(
            A2aErrorCode.internalError,
            'invalid JSON-RPC response from A2A server'
        )
    }
    if (!parsed || typeof parsed !== 'object')
        throw new A2aError(A2aErrorCode.invalidAgentResponse, 'invalid JSON-RPC response from A2A server')
    if (parsed.error) {
        if (typeof parsed.error !== 'object' ||
            typeof parsed.error.code !== 'number' ||
            typeof parsed.error.message !== 'string')
            throw new A2aError(A2aErrorCode.invalidAgentResponse, 'invalid JSON-RPC error from A2A server')
        throw A2aError.fromJsonRpc(parsed.error)
    }
    if (parsed.result === undefined)
        throw new A2aError(
            A2aErrorCode.internalError,
            'A2A response missing result'
        )
    return parsed.result
}

const transportError = (
    status: number,
    body: string,
    retryAfter: string | null
): A2aTransportError => {
    let detail = body.trim()
    try {
        const data = JSON.parse(body)
        detail = typeof data?.error === 'string'
            ? data.error
            : typeof data?.error?.message === 'string'
              ? data.error.message
              : typeof data?.message === 'string'
                ? data.message
                : ''
    } catch {
        // Plain-text proxy errors still carry useful diagnostics.
    }
    return new A2aTransportError(status, detail.slice(0, 200), retryAfter)
}

export class A2aClient {
    private readonly endpointUrl: string
    private readonly bearer?: string
    private readonly guard: UrlGuardOptions

    constructor(opts: A2aClientOptions) {
        this.endpointUrl = opts.endpointUrl
        this.bearer = opts.bearer
        this.guard = {
            allowPrivate: opts.allowPrivate,
            allowHttp: opts.allowHttp
        }
    }

    private headers(accept: string): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: accept
        }
        if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`
        return headers
    }

    private async rpc<R>(
        method: string,
        params: unknown,
        signal?: AbortSignal
    ): Promise<R> {
        const body = buildJsonRpcRequest(method, params)
        const res = await guardedFetch(
            this.endpointUrl,
            {
                method: 'POST',
                headers: this.headers('application/json'),
                body: JSON.stringify(body),
                signal
            },
            this.guard
        )
        const text = await res.text()
        if (!res.ok)
            throw transportError(res.status, text, res.headers.get('retry-after'))
        return parseJsonRpcResult<R>(text)
    }

    private async *rpcStream(
        method: string,
        params: unknown,
        signal: AbortSignal
    ): AsyncIterable<A2aStreamEvent> {
        const body = buildJsonRpcRequest(method, params)
        const res = await guardedFetch(
            this.endpointUrl,
            {
                method: 'POST',
                headers: this.headers('text/event-stream'),
                body: JSON.stringify(body),
                signal
            },
            this.guard
        )
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw transportError(res.status, text, res.headers.get('retry-after'))
        }
        if (!res.body)
            throw new A2aError(
                A2aErrorCode.internalError,
                'A2A stream response had no body'
            )
        for await (const sse of parseSseStream(res.body, signal)) {
            if (!sse.data) continue
            yield parseJsonRpcResult<A2aStreamEvent>(sse.data)
        }
    }

    async sendMessage(
        params: MessageSendParams,
        signal?: AbortSignal
    ): Promise<Task | Message> {
        return this.rpc<Task | Message>(A2aMethod.messageSend, params, signal)
    }

    sendStreamingMessage(
        params: MessageSendParams,
        signal: AbortSignal
    ): AsyncIterable<A2aStreamEvent> {
        return this.rpcStream(A2aMethod.messageStream, params, signal)
    }

    async getTask(params: TaskQueryParams, signal?: AbortSignal): Promise<Task> {
        return this.rpc<Task>(A2aMethod.tasksGet, params, signal)
    }

    async cancelTask(params: TaskIdParams, signal?: AbortSignal): Promise<Task> {
        return this.rpc<Task>(A2aMethod.tasksCancel, params, signal)
    }

    resubscribe(
        params: TaskIdParams,
        signal: AbortSignal
    ): AsyncIterable<A2aStreamEvent> {
        return this.rpcStream(A2aMethod.tasksResubscribe, params, signal)
    }
}
