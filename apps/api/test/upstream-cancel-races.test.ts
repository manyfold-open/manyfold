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

process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = '1'
// The real window is 5s; these tests only need it to be a bound they outlast.
const HARVEST_MS = 400
process.env.MF_UPSTREAM_CANCEL_HARVEST_MS = String(HARVEST_MS)
// A detached read outlives the consumer, so "nothing was sent upstream" is only
// true once a whole harvest window has passed with the origin still untouched.
const SETTLE_MS = HARVEST_MS + 200

// Two interleavings the pre-existing regressions cannot reach (#402):
//
// 1. The caller is ALREADY aborted when invoke() starts. An AbortSignal never
//    replays to a listener registered afterwards, and A2A's stream is a lazy
//    generator whose request is only sent on the first read — so a turn nobody
//    is listening to still created (and paid for) an upstream task.
// 2. The abort lands while the consumer is parked at an id-bearing yield —
//    awaiting a framework-session write, a content checkpoint or SSE
//    persistence. The helper's pump is suspended at `yield`, so waking it
//    cancels nothing until the consumer asks for the next event, which it may
//    never do.

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 1_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) await delay(10)
    assert.ok(predicate(), label)
}

interface RaceServer {
    endpoint: string
    // Every request the provider made, in order: "no upstream task exists" can
    // only be proved as an absence on a real origin.
    hits: string[]
    stops: unknown[]
    close: () => Promise<void>
}

const startServer = async (kind: 'dify' | 'a2a'): Promise<RaceServer> => {
    const hits: string[] = []
    const stops: unknown[] = []
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            const rpc =
                kind === 'a2a' && raw
                    ? (JSON.parse(raw) as {
                          id: string | number
                          method: string
                          params?: unknown
                      })
                    : null
            hits.push(
                rpc
                    ? `${req.method} ${req.url} ${rpc.method}`
                    : `${req.method} ${req.url}`
            )
            if (rpc?.method === 'tasks/cancel') {
                stops.push(rpc.params)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: rpc.id,
                        result: {
                            kind: 'task',
                            id: 'task-7',
                            contextId: 'ctx-1',
                            status: { state: 'canceled' }
                        }
                    })
                )
                return
            }
            if (kind === 'dify' && req.url?.endsWith('/stop')) {
                stops.push(raw ? JSON.parse(raw) : null)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ result: 'success' }))
                return
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            const first =
                kind === 'dify'
                    ? {
                          event: 'message',
                          task_id: 'task-7',
                          conversation_id: 'ctx-1',
                          answer: 'partial'
                      }
                    : {
                          jsonrpc: '2.0',
                          id: rpc?.id ?? 1,
                          result: {
                              kind: 'status-update',
                              taskId: 'task-7',
                              contextId: 'ctx-1',
                              status: { state: 'working' },
                              final: false
                          }
                      }
            res.write(`data: ${JSON.stringify(first)}\n\n`)
            // Stay open: the upstream task is still generating.
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return {
        endpoint:
            kind === 'dify'
                ? `http://127.0.0.1:${port}/v1`
                : `http://127.0.0.1:${port}/rpc`,
        hits,
        stops,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections()
                server.close(() => resolve())
            })
    }
}

const difyInput = (endpoint: string, warns: string[]): InvokeInput => ({
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
    logger: { warn: (message) => warns.push(message) }
})

const a2aInput = (rpcUrl: string, warns: string[]): InvokeInput => ({
    ...difyInput(rpcUrl, warns),
    config: { endpointUrl: rpcUrl, apiKey: '' },
    binding: { remoteRef: { rpcUrl } }
})

const drain = async (
    kind: 'dify' | 'a2a',
    input: InvokeInput,
    signal: AbortSignal
): Promise<EmittedEvent[]> => {
    const events: EmittedEvent[] = []
    for await (const event of getExternalProvider(kind).invoke(input, signal))
        events.push(event)
    await delay(SETTLE_MS)
    return events
}

// Park the consumer exactly where a real adapter parks: on the first event,
// which the provider can only reach after the helper has read the id-bearing
// payload. Nothing asks for the next event until the abort has been handled.
const parkedAtFirstEvent = async (
    kind: 'dify' | 'a2a',
    input: InvokeInput,
    signal: AbortSignal
): Promise<{
    first: EmittedEvent
    resume: () => Promise<EmittedEvent[]>
}> => {
    const iterator = getExternalProvider(kind)
        .invoke(input, signal)
        [Symbol.asyncIterator]()
    const step = await iterator.next()
    assert.equal(step.done, false, 'expected a first event to park on')
    return {
        first: step.value as EmittedEvent,
        resume: async (): Promise<EmittedEvent[]> => {
            const rest: EmittedEvent[] = []
            for (;;) {
                const next = await iterator.next()
                if (next.done === true) return rest
                rest.push(next.value as EmittedEvent)
            }
        }
    }
}

test('dify creates no upstream task when the caller aborted before invoke', async () => {
    const server = await startServer('dify')
    const warns: string[] = []
    try {
        const controller = new AbortController()
        controller.abort()
        const events = await drain(
            'dify',
            difyInput(server.endpoint, warns),
            controller.signal
        )
        assert.deepEqual(
            server.hits,
            [],
            'an already-cancelled turn must not reach Dify at all'
        )
        assert.deepEqual(events, [])
        assert.deepEqual(warns, [])
    } finally {
        await server.close()
    }
})

test('dify uploads nothing when the caller aborted before invoke', async () => {
    const server = await startServer('dify')
    const warns: string[] = []
    let reads = 0
    try {
        const controller = new AbortController()
        controller.abort()
        const input = difyInput(server.endpoint, warns)
        input.files = [
            {
                name: 'a.txt',
                contentType: 'text/plain',
                size: 1,
                read: async () => {
                    reads += 1
                    return Buffer.from('x')
                }
            }
        ]
        const events = await drain('dify', input, controller.signal)
        assert.equal(reads, 0, 'the upload must not even read the file')
        assert.deepEqual(server.hits, [])
        assert.deepEqual(events, [])
    } finally {
        await server.close()
    }
})

test('a2a creates no upstream task when the caller aborted before invoke', async () => {
    const server = await startServer('a2a')
    const warns: string[] = []
    try {
        const controller = new AbortController()
        controller.abort()
        const events = await drain(
            'a2a',
            a2aInput(server.endpoint, warns),
            controller.signal
        )
        assert.deepEqual(
            server.hits,
            [],
            'the lazy message/stream must never be sent for a cancelled turn'
        )
        assert.deepEqual(events, [])
        assert.deepEqual(warns, [])
    } finally {
        await server.close()
    }
})

test('a2a fetches no agent card when the caller aborted before invoke', async () => {
    const server = await startServer('a2a')
    const warns: string[] = []
    try {
        const controller = new AbortController()
        controller.abort()
        const input = a2aInput(server.endpoint, warns)
        input.binding = { remoteRef: {} }
        const events = await drain('a2a', input, controller.signal)
        assert.deepEqual(server.hits, [])
        assert.deepEqual(
            events,
            [],
            'a cancelled turn ends silently, not as a resolve failure'
        )
    } finally {
        await server.close()
    }
})

test('dify stops the upstream task when the abort lands at an id-bearing yield', async () => {
    const server = await startServer('dify')
    const warns: string[] = []
    try {
        const controller = new AbortController()
        const parked = await parkedAtFirstEvent(
            'dify',
            difyInput(server.endpoint, warns),
            controller.signal
        )
        assert.equal(parked.first.type, 'session_ref')
        controller.abort()
        await waitFor(
            () => server.stops.length === 1,
            'expected the upstream stop while the consumer was still parked'
        )
        assert.deepEqual(server.stops[0], { user: 'user-x' })
        assert.ok(
            server.hits.includes('POST /v1/chat-messages/task-7/stop'),
            `expected the stop path, got ${JSON.stringify(server.hits)}`
        )
        const rest = await parked.resume()
        await delay(150)
        assert.equal(
            server.stops.length,
            1,
            'resuming the consumer must not send a second stop'
        )
        assert.ok(!rest.some((event) => event.type === 'error'))
        assert.deepEqual(warns, [])
    } finally {
        await server.close()
    }
})

test('a2a cancels the remote task when the abort lands at an id-bearing yield', async () => {
    const server = await startServer('a2a')
    const warns: string[] = []
    try {
        const controller = new AbortController()
        const parked = await parkedAtFirstEvent(
            'a2a',
            a2aInput(server.endpoint, warns),
            controller.signal
        )
        assert.equal(parked.first.type, 'session_ref')
        controller.abort()
        await waitFor(
            () => server.stops.length === 1,
            'expected tasks/cancel while the consumer was still parked'
        )
        assert.deepEqual(server.stops[0], { id: 'task-7' })
        const rest = await parked.resume()
        await delay(150)
        assert.equal(
            server.stops.length,
            1,
            'resuming the consumer must not send a second cancel'
        )
        assert.ok(!rest.some((event) => event.type === 'error'))
        assert.deepEqual(warns, [])
    } finally {
        await server.close()
    }
})
