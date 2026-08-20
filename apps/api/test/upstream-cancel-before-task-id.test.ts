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
// The real window is 5s; the tests only need it to be a bound they can outlast.
const HARVEST_MS = 400
process.env.MF_UPSTREAM_CANCEL_HARVEST_MS = String(HARVEST_MS)

// The gap these cover (#402): the upstream request has been ACCEPTED — headers
// are on the wire — but the first event carrying the task id has not arrived
// yet. Aborting used to kill the response body with the very same signal the
// abort handler was reading, so the handler found no id, returned, and the
// upstream task kept generating with nothing left that could name it. Every
// pre-existing regression aborts after a token / session_ref, i.e. after the id
// was already captured, so none of them can fail this way.

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 3_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) await delay(10)
    assert.ok(predicate(), label)
}

interface DelayedServer {
    endpoint: string
    cancelBodies: unknown[]
    cancelPaths: string[]
    accepted: Promise<void>
    close: () => Promise<void>
}

// Headers are flushed before any data frame, so the provider's fetch resolves
// and the stream is live while still carrying no task id — the state a stubbed
// body cannot reproduce.
const startDelayedServer = async (opts: {
    kind: 'dify' | 'a2a'
    firstEventAfterMs: number
}): Promise<DelayedServer> => {
    const cancelBodies: unknown[] = []
    const cancelPaths: string[] = []
    let acceptedResolve!: () => void
    const accepted = new Promise<void>((resolve) => {
        acceptedResolve = resolve
    })
    const timers: ReturnType<typeof setTimeout>[] = []
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            const rpc =
                opts.kind === 'a2a' && raw
                    ? (JSON.parse(raw) as {
                          id: string | number
                          method: string
                          params?: unknown
                      })
                    : null
            if (opts.kind === 'a2a' && rpc?.method === 'tasks/cancel') {
                cancelPaths.push(req.url ?? '')
                cancelBodies.push(rpc.params)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: rpc.id,
                        result: {
                            kind: 'task',
                            id: 'task-late',
                            contextId: 'ctx-1',
                            status: { state: 'canceled' }
                        }
                    })
                )
                return
            }
            if (opts.kind === 'dify' && req.url?.endsWith('/stop')) {
                cancelPaths.push(req.url)
                cancelBodies.push(raw ? JSON.parse(raw) : null)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ result: 'success' }))
                return
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            // writeHead alone buffers; flushHeaders is what makes the request
            // "accepted" from the client's point of view with no body yet.
            res.flushHeaders()
            acceptedResolve()
            const first =
                opts.kind === 'dify'
                    ? {
                          event: 'message',
                          task_id: 'task-late',
                          conversation_id: 'conv-1',
                          answer: 'late'
                      }
                    : {
                          jsonrpc: '2.0',
                          id: rpc?.id ?? 1,
                          result: {
                              kind: 'status-update',
                              taskId: 'task-late',
                              contextId: 'ctx-1',
                              status: { state: 'working' },
                              final: false
                          }
                      }
            timers.push(
                setTimeout(() => {
                    if (!res.writableEnded)
                        res.write(`data: ${JSON.stringify(first)}\n\n`)
                }, opts.firstEventAfterMs)
            )
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return {
        endpoint:
            opts.kind === 'dify'
                ? `http://127.0.0.1:${port}/v1`
                : `http://127.0.0.1:${port}/rpc`,
        cancelBodies,
        cancelPaths,
        accepted,
        close: () =>
            new Promise<void>((resolve) => {
                for (const timer of timers) clearTimeout(timer)
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

// Consume the provider until the caller aborts, aborting only once the upstream
// has accepted the request and while nothing has been emitted yet.
const runUntilAbort = async (args: {
    kind: 'dify' | 'a2a'
    input: InvokeInput
    accepted: Promise<void>
}): Promise<{ events: EmittedEvent[]; eventsBeforeAbort: number }> => {
    const controller = new AbortController()
    const events: EmittedEvent[] = []
    let eventsBeforeAbort = -1
    const abort = (async (): Promise<void> => {
        await args.accepted
        // Loopback headers land in well under a millisecond; this margin only
        // has to outlast the fetch promise resolving.
        await delay(100)
        eventsBeforeAbort = events.length
        controller.abort()
    })()
    for await (const event of getExternalProvider(args.kind).invoke(
        args.input,
        controller.signal
    ))
        events.push(event)
    await abort
    return { events, eventsBeforeAbort }
}

const trackUnhandledRejections = (): {
    seen: unknown[]
    stop: () => void
} => {
    const seen: unknown[] = []
    const onRejection = (reason: unknown): void => {
        seen.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    return {
        seen,
        stop: () => process.off('unhandledRejection', onRejection)
    }
}

test('dify sends the upstream stop for an abort that lands before the first event', async () => {
    const server = await startDelayedServer({
        kind: 'dify',
        firstEventAfterMs: 150
    })
    const warns: string[] = []
    try {
        const { events, eventsBeforeAbort } = await runUntilAbort({
            kind: 'dify',
            input: difyInput(server.endpoint, warns),
            accepted: server.accepted
        })
        assert.equal(
            eventsBeforeAbort,
            0,
            'the abort must land before any task-id-bearing event'
        )
        await waitFor(
            () => server.cancelPaths.length === 1,
            'expected the upstream stop once the delayed task id arrived'
        )
        assert.equal(server.cancelPaths[0], '/v1/chat-messages/task-late/stop')
        assert.deepEqual(server.cancelBodies[0], { user: 'user-x' })
        assert.deepEqual(warns, [])
        assert.deepEqual(events, [])
    } finally {
        await server.close()
    }
})

test('dify records a skip when no task id arrives inside the harvest window', async () => {
    const rejections = trackUnhandledRejections()
    const server = await startDelayedServer({
        kind: 'dify',
        firstEventAfterMs: 30_000
    })
    const warns: string[] = []
    try {
        const startedAt = Date.now()
        await runUntilAbort({
            kind: 'dify',
            input: difyInput(server.endpoint, warns),
            accepted: server.accepted
        })
        await waitFor(
            () => warns.length === 1,
            'expected exactly one skip record'
        )
        assert.match(warns[0], /upstream_cancel=skipped_no_task_id/)
        assert.match(warns[0], /reason=harvest_window_elapsed/)
        assert.match(warns[0], new RegExp(`windowMs=${HARVEST_MS}`))
        assert.equal(server.cancelPaths.length, 0)
        assert.ok(
            Date.now() - startedAt < 3_000,
            'the harvest must be bounded, not open-ended'
        )
        await delay(100)
        assert.deepEqual(rejections.seen, [])
    } finally {
        rejections.stop()
        await server.close()
    }
})

test('a2a cancels the remote task for an abort that lands before the first event', async () => {
    const server = await startDelayedServer({
        kind: 'a2a',
        firstEventAfterMs: 150
    })
    const warns: string[] = []
    try {
        const { events, eventsBeforeAbort } = await runUntilAbort({
            kind: 'a2a',
            input: a2aInput(server.endpoint, warns),
            accepted: server.accepted
        })
        assert.equal(
            eventsBeforeAbort,
            0,
            'the abort must land before any task-id-bearing event'
        )
        await waitFor(
            () => server.cancelBodies.length === 1,
            'expected tasks/cancel once the delayed task id arrived'
        )
        assert.deepEqual(server.cancelBodies[0], { id: 'task-late' })
        assert.deepEqual(warns, [])
        assert.deepEqual(events, [])
    } finally {
        await server.close()
    }
})

test('a2a records a skip when no task id arrives inside the harvest window', async () => {
    const rejections = trackUnhandledRejections()
    const server = await startDelayedServer({
        kind: 'a2a',
        firstEventAfterMs: 30_000
    })
    const warns: string[] = []
    try {
        const startedAt = Date.now()
        await runUntilAbort({
            kind: 'a2a',
            input: a2aInput(server.endpoint, warns),
            accepted: server.accepted
        })
        await waitFor(
            () => warns.length === 1,
            'expected exactly one skip record'
        )
        assert.match(warns[0], /upstream_cancel=skipped_no_task_id/)
        assert.match(warns[0], /reason=harvest_window_elapsed/)
        assert.equal(server.cancelBodies.length, 0)
        assert.ok(
            Date.now() - startedAt < 3_000,
            'the harvest must be bounded, not open-ended'
        )
        await delay(100)
        assert.deepEqual(rejections.seen, [])
    } finally {
        rejections.stop()
        await server.close()
    }
})
