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
