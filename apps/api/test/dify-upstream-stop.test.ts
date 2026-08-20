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

// A real node:http server, not a mocked fetch: the behavior under test is how
// the abort signal interacts with the live response body and what the provider
// then sends BACK to the origin — a stubbed body cannot fail the way
// production does.
interface DifyServer {
    endpoint: string
    stopRequests: Array<{
        path: string
        authorization: string | undefined
        body: unknown
    }>
    stopReceived: Promise<void>
    close: () => Promise<void>
}

const startDifyServer = async (opts?: {
    stopStatus?: number
    completeTurn?: boolean
}): Promise<DifyServer> => {
    const stopRequests: DifyServer['stopRequests'] = []
    let stopResolve!: () => void
    const stopReceived = new Promise<void>((resolve) => {
        stopResolve = resolve
    })
    const sse = (payload: Record<string, unknown>): string =>
        `data: ${JSON.stringify(payload)}\n\n`
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            if (req.method === 'POST' && req.url === '/v1/chat-messages') {
                res.writeHead(200, {
                    'content-type': 'text/event-stream'
                })
                // writeHead alone flushes nothing; the first write() is what
                // actually puts the status line + frame on the wire.
                res.write(
                    sse({
                        event: 'message',
                        task_id: 'task-1',
                        conversation_id: 'conv-1',
                        answer: 'partial'
                    })
                )
                if (opts?.completeTurn) {
                    res.write(
                        sse({
                            event: 'message_end',
                            task_id: 'task-1',
                            conversation_id: 'conv-1',
                            metadata: {}
                        })
                    )
                    res.end()
                }
                // Otherwise stay open: the upstream task is still generating.
                return
            }
            if (req.method === 'POST' && req.url?.endsWith('/stop')) {
                stopRequests.push({
                    path: req.url,
                    authorization: req.headers.authorization,
                    body: raw ? JSON.parse(raw) : null
                })
                res.writeHead(opts?.stopStatus ?? 200, {
                    'content-type': 'application/json'
                })
                res.end(JSON.stringify({ result: 'success' }))
                stopResolve()
                return
            }
            res.writeHead(404)
            res.end()
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return {
        endpoint: `http://127.0.0.1:${port}/v1`,
        stopRequests,
        stopReceived,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections()
                server.close(() => resolve())
            })
    }
}

const invokeInput = (endpoint: string, warns: string[]): InvokeInput => ({
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

const waitFor = async (
    predicate: () => boolean,
    label: string
): Promise<void> => {
    const deadline = Date.now() + 2_000
    while (!predicate() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(predicate(), label)
}

// The core #402 gap-1 regression: without the stop call, aborting the fetch
// leaves the Dify task running (and billing) server-side with no receiver.
test('abort mid-stream stops the upstream Dify task', async () => {
    const server = await startDifyServer()
    try {
        const controller = new AbortController()
        const warns: string[] = []
        const events: EmittedEvent[] = []
        for await (const event of getExternalProvider('dify').invoke(
            invokeInput(server.endpoint, warns),
            controller.signal
        )) {
            events.push(event)
            if (event.type === 'token') controller.abort()
        }
        await server.stopReceived
        assert.equal(server.stopRequests.length, 1)
        const stop = server.stopRequests[0]
        assert.equal(stop.path, '/v1/chat-messages/task-1/stop')
        assert.equal(stop.authorization, 'Bearer app-test')
        assert.deepEqual(stop.body, { user: 'user-x' })
        assert.deepEqual(warns, [])
        assert.ok(
            events.some((e) => e.type === 'token'),
            'expected the partial answer to be delivered before the abort'
        )
    } finally {
        await server.close()
    }
})

test('a completed turn never sends an upstream stop', async () => {
    const server = await startDifyServer({ completeTurn: true })
    try {
        const controller = new AbortController()
        const warns: string[] = []
        const events: EmittedEvent[] = []
        for await (const event of getExternalProvider('dify').invoke(
            invokeInput(server.endpoint, warns),
            controller.signal
        ))
            events.push(event)
        assert.equal(events.at(-1)?.type, 'done')
        // An abort arriving after the terminal must not resurrect a stop call:
        // the listener was removed when the stream finished.
        controller.abort()
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(server.stopRequests.length, 0)
    } finally {
        await server.close()
    }
})

test('a failed upstream stop only warns and never breaks local terminalization', async () => {
    const server = await startDifyServer({ stopStatus: 500 })
    try {
        const controller = new AbortController()
        const warns: string[] = []
        const events: EmittedEvent[] = []
        for await (const event of getExternalProvider('dify').invoke(
            invokeInput(server.endpoint, warns),
            controller.signal
        )) {
            events.push(event)
            if (event.type === 'token') controller.abort()
        }
        await server.stopReceived
        await waitFor(() => warns.length === 1, 'expected exactly one warning')
        assert.match(warns[0], /dify upstream stop returned 500/)
        assert.ok(
            !events.some((e) => e.type === 'error'),
            'the aborted stream must end silently, not with an error event'
        )
    } finally {
        await server.close()
    }
})
