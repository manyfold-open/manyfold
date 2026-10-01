import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { A2aStreamEvent, Task } from '@manyfold/a2a'
import {
    getExternalProvider,
    type EmittedEvent,
    type InvokeInput
} from '@manyfold/external-providers'

process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = '1'

const invokeInput = (rpcUrl: string): InvokeInput => ({
    config: { endpointUrl: rpcUrl, apiKey: '' },
    binding: { remoteRef: { rpcUrl } },
    session: { id: 'session', frameworkSessionRef: null },
    message: {
        id: 'message',
        sessionId: 'session',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hi' }],
        createdAt: new Date().toISOString()
    },
    history: [],
    model: null,
    modelConfig: null
})

test('live and recovered A2A responses agree on cancellation and required input', async (t) => {
    for (const state of [
        'canceled',
        'input-required',
        'auth-required'
    ] as const) {
        for (const snapshot of [false, true]) {
            await t.test(
                `${state} via ${snapshot ? 'task snapshot' : 'status update'}`,
                async () => {
                    const task: Task = {
                        kind: 'task',
                        id: 'task',
                        contextId: 'context',
                        status: {
                            state,
                            message: {
                                kind: 'message',
                                messageId: 'question',
                                role: 'agent',
                                parts: [
                                    { kind: 'text', text: 'Please confirm' }
                                ]
                            }
                        },
                        artifacts: snapshot
                            ? [
                                  {
                                      artifactId: 'a',
                                      parts: [{ kind: 'text', text: 'Draft' }]
                                  }
                              ]
                            : []
                    }
                    const event: A2aStreamEvent = snapshot
                        ? task
                        : {
                              kind: 'status-update',
                              taskId: task.id,
                              contextId: task.contextId,
                              status: task.status,
                              final: true
                          }
                    const server = http.createServer((req, res) => {
                        let raw = ''
                        req.on('data', (chunk) => {
                            raw += chunk
                        })
                        req.on('end', () => {
                            const rpc = JSON.parse(raw)
                            if (rpc.method === 'tasks/get') {
                                res.setHeader(
                                    'content-type',
                                    'application/json'
                                )
                                res.end(
                                    JSON.stringify({
                                        jsonrpc: '2.0',
                                        id: rpc.id,
                                        result: task
                                    })
                                )
                            } else {
                                res.setHeader(
                                    'content-type',
                                    'text/event-stream'
                                )
                                res.end(
                                    `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: event })}\n\n`
                                )
                            }
                        })
                    })
                    server.listen(0, '127.0.0.1')
                    await once(server, 'listening')
                    try {
                        const input = invokeInput(
                            `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`
                        )
                        const provider = getExternalProvider('a2a')
                        const events: EmittedEvent[] = []
                        for await (const result of provider.invoke(
                            input,
                            AbortSignal.timeout(3000)
                        ))
                            events.push(result)
                        const recovered = await provider.converge!(
                            {
                                ...input,
                                ref: { taskId: 'task', upstreamMessageId: null }
                            },
                            AbortSignal.timeout(3000)
                        )
                        if (state === 'canceled') {
                            assert.deepEqual(events.at(-1), {
                                type: 'error',
                                error: {
                                    code: 'a2a_upstream_cancelled',
                                    message: 'Please confirm',
                                    retryable: true
                                }
                            })
                            assert.ok(
                                !events.some((result) => result.type === 'done')
                            )
                            assert.deepEqual(recovered, { status: 'cancelled' })
                        } else {
                            const expected = snapshot
                                ? 'Draft\nPlease confirm'
                                : 'Please confirm'
                            assert.equal(
                                events
                                    .filter((result) => result.type === 'token')
                                    .map((result) => result.text)
                                    .join(''),
                                expected
                            )
                            assert.equal(events.at(-1)?.type, 'done')
                            assert.deepEqual(recovered, {
                                status: 'completed',
                                text: expected
                            })
                        }
                    } finally {
                        server.closeAllConnections()
                        await new Promise<void>((resolve) =>
                            server.close(() => resolve())
                        )
                    }
                }
            )
        }
    }
})

for (const status of [401, 403, 429, 503]) {
    test(`the provider preserves HTTP ${status} and its retryability`, async () => {
        const server = http.createServer((req, res) => {
            req.resume()
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'request refused' }))
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        try {
            const events: EmittedEvent[] = []
            for await (const event of getExternalProvider('a2a').invoke(
                invokeInput(
                    `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`
                ),
                AbortSignal.timeout(3000)
            ))
                events.push(event)
            assert.deepEqual(events, [
                {
                    type: 'error',
                    error: {
                        code: `a2a_http_${status}`,
                        message: `A2A server returned HTTP ${status}: request refused`,
                        retryable: status === 429 || status >= 500
                    }
                }
            ])
        } finally {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    })
}

// ---- a stream that ends before its task does (2026-10-01) ----
//
// A Manyfold peer ends message/stream at its blocking cap with a non-final
// `working` and keeps the task running. The provider used to read that end as
// the answer and close the turn with the partial text.

type RpcHandler = (rpc: { id: unknown; method: string; params: unknown }) =>
    | { stream: A2aStreamEvent[] }
    | { result: unknown }
    | { error: { code: number; message: string } }

const startA2aServer = async (handle: RpcHandler) => {
    const calls: Array<{ method: string; params: unknown }> = []
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            const rpc = JSON.parse(raw)
            calls.push({ method: rpc.method, params: rpc.params })
            const answer = handle(rpc)
            if ('stream' in answer) {
                res.setHeader('content-type', 'text/event-stream')
                res.end(
                    answer.stream
                        .map(
                            (event) =>
                                `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: event })}\n\n`
                        )
                        .join('')
                )
                return
            }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...answer }))
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return {
        calls,
        rpcUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`,
        close: async () => {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    }
}

const handedOverStream: A2aStreamEvent[] = [
    {
        kind: 'status-update',
        taskId: 'task',
        contextId: 'context',
        status: { state: 'working' },
        final: false
    },
    {
        kind: 'artifact-update',
        taskId: 'task',
        contextId: 'context',
        artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'part' }] },
        append: true,
        lastChunk: false
    },
    {
        kind: 'status-update',
        taskId: 'task',
        contextId: 'context',
        status: { state: 'working' },
        final: false
    }
]

const taskIn = (
    state: Task['status']['state'],
    text?: string,
    message?: string
): Task => ({
    kind: 'task',
    id: 'task',
    contextId: 'context',
    status: {
        state,
        ...(message
            ? {
                  message: {
                      kind: 'message',
                      messageId: 'status',
                      role: 'agent',
                      parts: [{ kind: 'text', text: message }]
                  }
              }
            : {})
    },
    artifacts: text ? [{ artifactId: 'a', parts: [{ kind: 'text', text }] }] : []
})

const collect = async (
    rpcUrl: string,
    signal: AbortSignal
): Promise<EmittedEvent[]> => {
    const events: EmittedEvent[] = []
    for await (const event of getExternalProvider('a2a').invoke(
        { ...invokeInput(rpcUrl), followPollMs: 10 },
        signal
    ))
        events.push(event)
    return events
}

const tokensOf = (events: EmittedEvent[]): string =>
    events
        .filter((event) => event.type === 'token')
        .map((event) => (event as { text: string }).text)
        .join('')

test('a stream that ends before its task is followed through tasks/get to the answer', async () => {
    let polls = 0
    const server = await startA2aServer((rpc) => {
        if (rpc.method === 'message/stream') return { stream: handedOverStream }
        polls++
        return {
            result:
                polls < 2
                    ? taskIn('working')
                    : taskIn('completed', 'part of the long answer')
        }
    })
    try {
        const events = await collect(server.rpcUrl, AbortSignal.timeout(5000))
        assert.equal(tokensOf(events), 'part of the long answer')
        assert.equal(events.at(-1)?.type, 'done')
        assert.ok(
            server.calls.filter((call) => call.method === 'tasks/get').length >=
                2
        )
    } finally {
        await server.close()
    }
})

test('a followed task that fails ends the turn with its failure', async () => {
    const server = await startA2aServer((rpc) =>
        rpc.method === 'message/stream'
            ? { stream: handedOverStream }
            : {
                  result: taskIn(
                      'failed',
                      undefined,
                      'delegated turn exceeded 7200s (detached cap)'
                  )
              }
    )
    try {
        const events = await collect(server.rpcUrl, AbortSignal.timeout(5000))
        assert.deepEqual(events.at(-1), {
            type: 'error',
            error: {
                code: 'a2a_failed',
                message: 'delegated turn exceeded 7200s (detached cap)',
                retryable: false
            }
        })
        assert.equal(
            events.some((event) => event.type === 'done'),
            false
        )
    } finally {
        await server.close()
    }
})

test('a cancel while following is forwarded to the remote task', async () => {
    const controller = new AbortController()
    const server = await startA2aServer((rpc) => {
        if (rpc.method === 'message/stream') return { stream: handedOverStream }
        if (rpc.method === 'tasks/get') {
            setImmediate(() => controller.abort())
            return { result: taskIn('working') }
        }
        return { result: taskIn('canceled') }
    })
    try {
        const events = await collect(server.rpcUrl, controller.signal)
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.deepEqual(
            server.calls
                .filter((call) => call.method === 'tasks/cancel')
                .map((call) => call.params),
            [{ id: 'task' }]
        )
        assert.equal(
            events.some(
                (event) => event.type === 'done' || event.type === 'error'
            ),
            false
        )
    } finally {
        await server.close()
    }
})

test('a remote that cannot be asked about its task keeps what it streamed', async () => {
    const server = await startA2aServer((rpc) =>
        rpc.method === 'message/stream'
            ? { stream: handedOverStream }
            : { error: { code: -32601, message: 'method not found: tasks/get' } }
    )
    try {
        const events = await collect(server.rpcUrl, AbortSignal.timeout(5000))
        assert.equal(tokensOf(events), 'part')
        assert.equal(events.at(-1)?.type, 'done')
    } finally {
        await server.close()
    }
})
