import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
    getExternalProvider,
    type EmittedEvent,
    type InvokeInput
} from '@manyfold/external-providers'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { DifyChatAdapter } from '../src/modules/chat/adapters/external-api.adapter'
import { TurnFenceLostError } from '../src/modules/chat/turn-fence'

process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = '1'

// #670. Until now the ids that name a turn's work upstream existed only inside
// the upstream-cancel closure, so a relay killed by a deploy took the only way
// of ever asking "did it finish?" with it. These pin that the ids escape the
// provider AS SOON AS the stream reveals them — not at the terminal, which is
// exactly the event a dying instance never reaches.
//
// Real node:http servers, not a mocked fetch (#513): the claim is about which
// wire frame first carries the id, which a stub cannot establish.

const sse = (payload: Record<string, unknown>): string =>
    `data: ${JSON.stringify(payload)}\n\n`

const startServer = async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return {
        port,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections()
                server.close(() => resolve())
            })
    }
}

const invokeInput = (endpoint: string): InvokeInput => ({
    config: { endpointUrl: endpoint, apiKey: 'app-test' },
    binding: { remoteRef: { userIdentifier: 'user-x' } },
    session: { id: 'session-1', frameworkSessionRef: null },
    message: {
        id: 'msg-1',
        sessionId: 'session-1',
        role: 'user',
        contentBlocks: [{ type: 'text', text: 'hi' }],
        createdAt: new Date().toISOString()
    } satisfies ChatMessage,
    history: [],
    model: null,
    modelConfig: null,
    logger: { warn: () => undefined }
})

const collect = async (
    stream: AsyncIterable<EmittedEvent>
): Promise<EmittedEvent[]> => {
    const events: EmittedEvent[] = []
    for await (const event of stream) events.push(event)
    return events
}

test('dify surrenders task and message ids on the first chunk that carries them', async () => {
    const server = await startServer((req, res) => {
        req.resume()
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write(
                sse({
                    event: 'message',
                    task_id: 'task-1',
                    message_id: 'dify-msg-1',
                    conversation_id: 'conv-1',
                    answer: 'partial'
                })
            )
            res.write(
                sse({
                    event: 'message_end',
                    task_id: 'task-1',
                    message_id: 'dify-msg-1',
                    conversation_id: 'conv-1',
                    metadata: {}
                })
            )
            res.end()
        })
    })
    try {
        const events = await collect(
            getExternalProvider('dify').invoke(
                invokeInput(`http://127.0.0.1:${server.port}/v1`),
                new AbortController().signal
            )
        )
        const refs = events.filter((e) => e.type === 'upstream_ref')
        assert.equal(refs.length, 1, 'a stable ref is announced exactly once')
        assert.deepEqual(refs[0], {
            type: 'upstream_ref',
            taskId: 'task-1',
            upstreamMessageId: 'dify-msg-1'
        })
        // Before the answer: a turn killed after the first token but before the
        // terminal is the whole population this recovers.
        assert.ok(
            events.indexOf(refs[0]) <
                events.findIndex((e) => e.type === 'token'),
            'the ref must precede the first token'
        )
    } finally {
        await server.close()
    }
})

// A chatflow announces the task before any answer row exists, then names the
// message on a later chunk. Merging rather than first-write-wins is what makes
// the Dify messages lookup possible at all.
test('dify re-announces when the message id arrives on a later chunk', async () => {
    const server = await startServer((req, res) => {
        req.resume()
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write(
                sse({
                    event: 'workflow_started',
                    task_id: 'task-2',
                    conversation_id: 'conv-2'
                })
            )
            res.write(
                sse({
                    event: 'message',
                    task_id: 'task-2',
                    message_id: 'dify-msg-2',
                    conversation_id: 'conv-2',
                    answer: 'hello'
                })
            )
            res.write(
                sse({
                    event: 'message_end',
                    task_id: 'task-2',
                    message_id: 'dify-msg-2',
                    conversation_id: 'conv-2',
                    metadata: {}
                })
            )
            res.end()
        })
    })
    try {
        const events = await collect(
            getExternalProvider('dify').invoke(
                invokeInput(`http://127.0.0.1:${server.port}/v1`),
                new AbortController().signal
            )
        )
        const refs = events.filter((e) => e.type === 'upstream_ref')
        assert.deepEqual(refs, [
            { type: 'upstream_ref', taskId: 'task-2' },
            {
                type: 'upstream_ref',
                taskId: 'task-2',
                upstreamMessageId: 'dify-msg-2'
            }
        ])
    } finally {
        await server.close()
    }
})

// An error chunk still carries task_id, and Dify's stale-conversation retry
// keys off "no provider progress yet" — so the ref must escape without
// counting as progress. The retry itself is pinned by
// external-api-dify-session-ref-fallback.test.ts; this pins that the ref rides
// alongside the error rather than being swallowed with it.
test('dify surrenders the task id even when the turn errors immediately', async () => {
    const server = await startServer((req, res) => {
        req.resume()
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write(
                sse({
                    event: 'error',
                    task_id: 'task-3',
                    code: 'internal',
                    message: 'boom'
                })
            )
            res.end()
        })
    })
    try {
        const events = await collect(
            getExternalProvider('dify').invoke(
                invokeInput(`http://127.0.0.1:${server.port}/v1`),
                new AbortController().signal
            )
        )
        assert.deepEqual(events[0], {
            type: 'upstream_ref',
            taskId: 'task-3'
        })
        assert.equal(events[1]?.type, 'error')
    } finally {
        await server.close()
    }
})

test('a2a surrenders the task id on the first task-bearing frame', async () => {
    const server = await startServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            const rpc = JSON.parse(raw) as { id: string | number }
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            const frame = (result: unknown): string =>
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`
            res.write(
                frame({
                    kind: 'status-update',
                    taskId: 'task-9',
                    contextId: 'ctx-1',
                    status: { state: 'working' },
                    final: false
                })
            )
            res.write(
                frame({
                    kind: 'status-update',
                    taskId: 'task-9',
                    contextId: 'ctx-1',
                    status: { state: 'completed' },
                    final: true
                })
            )
            res.end()
        })
    })
    try {
        const rpcUrl = `http://127.0.0.1:${server.port}/rpc`
        const input = invokeInput(rpcUrl)
        input.binding = { remoteRef: { rpcUrl } }
        const events = await collect(
            getExternalProvider('a2a').invoke(
                input,
                new AbortController().signal
            )
        )
        const refs = events.filter((e) => e.type === 'upstream_ref')
        assert.deepEqual(
            refs,
            [{ type: 'upstream_ref', taskId: 'task-9' }],
            'announced once, on the first frame, not per frame'
        )
        assert.equal(events[0].type, 'session_ref')
        assert.equal(events[1].type, 'upstream_ref')
    } finally {
        await server.close()
    }
})

// Honest degrade, not an oversight: langflow's NDJSON carries no task or
// message id at all, so there is nothing to announce and nothing to recover
// from later. A test that let a ref appear here would be pinning a fiction.
test('langflow announces no upstream ref because it has none', async () => {
    const server = await startServer((req, res) => {
        req.resume()
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/x-ndjson' })
            res.write(
                `${JSON.stringify({ event: 'token', data: { chunk: 'hi' } })}\n`
            )
            res.write(
                `${JSON.stringify({
                    event: 'end',
                    data: { result: { session_id: 'lf-session-1' } }
                })}\n`
            )
            res.end()
        })
    })
    try {
        const input = invokeInput(`http://127.0.0.1:${server.port}`)
        input.binding = { remoteRef: { flowId: 'flow-1' } }
        const events = await collect(
            getExternalProvider('langflow').invoke(
                input,
                new AbortController().signal
            )
        )
        assert.equal(events.filter((e) => e.type === 'upstream_ref').length, 0)
        assert.ok(events.some((e) => e.type === 'token'))
    } finally {
        await server.close()
    }
})

// The last leg of the same journey, one layer up. An id that has escaped the
// provider is worth nothing until it is DURABLE, and the only instant that
// matters is "before whatever kills this relay arrives" — the next token, the
// terminal, the shutdown handoff, a peer's adoption. So the adapter treats the
// turn pipeline's sink as a barrier and consumes no further provider event
// while a ref write is in flight. It used to fire and forget, which let every
// one of those overtake the write; a peer winning that race read a null ref and
// could only write the retryable `server_restart` this feature exists to avoid.

const nextTurn = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

const settlesWithin = async (
    promise: Promise<void>,
    timeoutMs: number
): Promise<boolean> => {
    let timer!: ReturnType<typeof setTimeout>
    const result = await Promise.race([
        promise.then(() => true),
        new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs)
        })
    ])
    clearTimeout(timer)
    return result
}

// A chatflow: the task id lands on the first frame and the message id only on a
// later one, so the sink is called twice and the serialization is observable.
const difyChatflowServer = async (): Promise<{
    port: number
    close: () => Promise<void>
    stopped: Promise<void>
}> => {
    let stoppedResolve!: () => void
    const stopped = new Promise<void>((resolve) => {
        stoppedResolve = resolve
    })
    const server = await startServer((req, res) => {
        if (req.url?.endsWith('/stop')) {
            req.resume()
            req.on('end', () => {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end('{}')
                stoppedResolve()
            })
            return
        }
        req.resume()
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write(
                sse({
                    event: 'workflow_started',
                    task_id: 'task-5',
                    conversation_id: 'conv-5'
                })
            )
            res.write(
                sse({
                    event: 'message',
                    task_id: 'task-5',
                    message_id: 'dify-msg-5',
                    conversation_id: 'conv-5',
                    answer: 'hello'
                })
            )
            res.write(
                sse({
                    event: 'message_end',
                    task_id: 'task-5',
                    message_id: 'dify-msg-5',
                    conversation_id: 'conv-5',
                    metadata: {}
                })
            )
            res.end()
        })
    })
    return { ...server, stopped }
}

const difyChatAdapter = (endpointUrl: string): DifyChatAdapter =>
    new DifyChatAdapter(
        {
            select: () => ({
                from: () => ({
                    where: () => ({
                        limit: async () => [
                            {
                                id: 'agt_1',
                                userId: 'user_1',
                                extras: {
                                    externalBinding: {
                                        providerId: 'ueap_1',
                                        framework: 'dify',
                                        remoteRef: { userIdentifier: 'user_1' }
                                    }
                                }
                            }
                        ]
                    })
                })
            })
        } as never,
        {
            resolveForUser: async () => ({
                provider: 'dify',
                endpointUrl,
                apiKey: 'test-key',
                metadata: {}
            })
        } as never,
        { updateFrameworkSessionRef: async () => undefined } as never
    )

const adapterCtx = (
    onUpstreamRef: ApiChatAdapterContext['onUpstreamRef'],
    abortSignal = new AbortController().signal
): ApiChatAdapterContext =>
    ({
        userId: 'user_1',
        agentId: 'agt_1',
        runtimeId: null,
        sessionId: 'cts_1',
        messageId: 'assistant-message-1',
        framework: 'dify',
        runtimeKind: 'external',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: null,
        history: [],
        abortSignal,
        onUpstreamRef
    }) as ApiChatAdapterContext

const adapterUserMessage = (): ChatMessage => ({
    id: 'user-message-1',
    sessionId: 'cts_1',
    role: 'user',
    createdAt: '2026-08-14T09:00:00.000Z',
    contentBlocks: [{ type: 'text', text: 'hello' }]
})

test('the dify adapter consumes no further provider event until the ref write lands', async () => {
    const server = await difyChatflowServer()
    try {
        let release!: () => void
        const written = new Promise<void>((resolve) => {
            release = resolve
        })
        const announced: Array<{
            taskId?: string | null
            upstreamMessageId?: string | null
        }> = []
        let firstAnnouncementResolve!: () => void
        const firstAnnouncement = new Promise<void>((resolve) => {
            firstAnnouncementResolve = resolve
        })
        const events: EmittedChatEvent[] = []
        const consumed = (async () => {
            for await (const event of difyChatAdapter(
                `http://127.0.0.1:${server.port}/v1`
            ).sendMessage(
                adapterCtx(async (ref) => {
                    announced.push(ref)
                    firstAnnouncementResolve()
                    await written
                }),
                adapterUserMessage()
            ))
                events.push(event)
        })()

        await firstAnnouncement
        await nextTurn()
        assert.equal(
            announced.length,
            1,
            'the second announcement waits behind the first write'
        )
        assert.deepEqual(
            events.map((e) => e.type),
            [],
            'no provider event may overtake a ref write that has not landed'
        )

        release()
        await consumed

        assert.deepEqual(announced, [
            { taskId: 'task-5', upstreamMessageId: null },
            { taskId: 'task-5', upstreamMessageId: 'dify-msg-5' }
        ])
        assert.ok(
            events.some((e) => e.type === 'token'),
            'and the answer still arrives once the write is done'
        )
    } finally {
        await server.close()
    }
})

// The sink degrades honestly on a failed write and returns; one that THREW
// would land in the adapter's own catch and terminalize a turn whose answer is
// streaming perfectly well as `external_provider_failed`. Losing the recovery
// handle is not a reason to lose the turn too.
test('a throwing ref sink does not fail a turn that is still streaming', async () => {
    const server = await difyChatflowServer()
    try {
        const events: EmittedChatEvent[] = []
        for await (const event of difyChatAdapter(
            `http://127.0.0.1:${server.port}/v1`
        ).sendMessage(
            adapterCtx(() => {
                throw new Error('sink exploded')
            }),
            adapterUserMessage()
        ))
            events.push(event)

        const types = events.map((e) => e.type)
        assert.ok(types.includes('token'))
        assert.ok(types.includes('done'))
        assert.ok(!types.includes('error'), types.join(','))
    } finally {
        await server.close()
    }
})

test('a fenced-out ref sink stops before consuming provider content', async () => {
    const server = await difyChatflowServer()
    try {
        const events: EmittedChatEvent[] = []
        await assert.rejects(async () => {
            for await (const event of difyChatAdapter(
                `http://127.0.0.1:${server.port}/v1`
            ).sendMessage(
                adapterCtx(() => {
                    throw new TurnFenceLostError('assistant-message-1')
                }),
                adapterUserMessage()
            ))
                events.push(event)
        }, TurnFenceLostError)
        assert.deepEqual(events, [])
    } finally {
        await server.close()
    }
})

test('abort releases a turn parked on the ref barrier without consuming another event', async () => {
    const server = await difyChatflowServer()
    const controller = new AbortController()
    try {
        let announcedResolve!: () => void
        const announced = new Promise<void>((resolve) => {
            announcedResolve = resolve
        })
        const events: EmittedChatEvent[] = []
        const consumed = (async () => {
            for await (const event of difyChatAdapter(
                `http://127.0.0.1:${server.port}/v1`
            ).sendMessage(
                adapterCtx(() => {
                    announcedResolve()
                    return new Promise<void>(() => {})
                }, controller.signal),
                adapterUserMessage()
            ))
                events.push(event)
        })()

        await announced
        controller.abort()
        assert.equal(
            await settlesWithin(consumed, 1_000),
            true,
            'cancel must not wait for an unbounded repository write'
        )
        assert.deepEqual(events, [])
        assert.equal(await settlesWithin(server.stopped, 1_000), true)
    } finally {
        await server.close()
    }
})
