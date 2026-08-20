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

// Real JSON-RPC server over node:http: the assertion is what the provider
// sends BACK on abort (tasks/cancel), which a mocked transport cannot prove.
interface A2aServer {
    rpcUrl: string
    cancels: Array<{ params: unknown }>
    cancelReceived: Promise<void>
    close: () => Promise<void>
}

const startA2aServer = async (): Promise<A2aServer> => {
    const cancels: A2aServer['cancels'] = []
    let cancelResolve!: () => void
    const cancelReceived = new Promise<void>((resolve) => {
        cancelResolve = resolve
    })
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            const rpc = JSON.parse(raw) as {
                id: string | number
                method: string
                params?: unknown
            }
            if (rpc.method === 'message/stream') {
                res.writeHead(200, {
                    'content-type': 'text/event-stream'
                })
                res.write(
                    `data: ${JSON.stringify({
                        jsonrpc: '2.0',
                        id: rpc.id,
                        result: {
                            kind: 'status-update',
                            taskId: 'task-9',
                            contextId: 'ctx-1',
                            status: { state: 'working' },
                            final: false
                        }
                    })}\n\n`
                )
                // Stay open: the remote task is still working.
                return
            }
            if (rpc.method === 'tasks/cancel') {
                cancels.push({ params: rpc.params })
                res.writeHead(200, {
                    'content-type': 'application/json'
                })
                res.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: rpc.id,
                        result: {
                            kind: 'task',
                            id: 'task-9',
                            contextId: 'ctx-1',
                            status: { state: 'canceled' }
                        }
                    })
                )
                cancelResolve()
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
        rpcUrl: `http://127.0.0.1:${port}/rpc`,
        cancels,
        cancelReceived,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections()
                server.close(() => resolve())
            })
    }
}

const invokeInput = (rpcUrl: string, warns: string[]): InvokeInput => ({
    config: { endpointUrl: rpcUrl, apiKey: '' },
    binding: { remoteRef: { rpcUrl } },
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

test('abort mid-stream cancels the remote A2A task', async () => {
    const server = await startA2aServer()
    try {
        const controller = new AbortController()
        const warns: string[] = []
        const events: EmittedEvent[] = []
        for await (const event of getExternalProvider('a2a').invoke(
            invokeInput(server.rpcUrl, warns),
            controller.signal
        )) {
            events.push(event)
            // The status-update carries both taskId and contextId, so the
            // first observable event proves the task id was captured.
            if (event.type === 'session_ref') controller.abort()
        }
        await server.cancelReceived
        assert.equal(server.cancels.length, 1)
        assert.deepEqual(server.cancels[0].params, { id: 'task-9' })
        assert.deepEqual(warns, [])
        assert.ok(
            !events.some((e) => e.type === 'error'),
            'the aborted stream must end silently, not with an error event'
        )
    } finally {
        await server.close()
    }
})
