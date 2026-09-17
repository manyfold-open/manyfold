import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { createClient } from '../../src/client'
import { withLiveSprite } from '../live-sprite-harness'
import { runDetachProbe } from '../live/exec-detach-probe'

const mode = process.env.MF_LIVE_SPRITE_FIXTURE
const name = 'nca-probe-detach-owned-local'
const controller = new AbortController()
const counts = { create: 0, delete: 0, body: 0, connections: 0 }
const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/sprites') {
        counts.create++
        if (mode === 'late-create')
            controller.abort(new Error('cancel during create'))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: 'fixture', name, status: 'running' }))
    } else if (req.method === 'DELETE' && req.url === `/sprites/${name}`) {
        counts.delete++
        if (mode === 'delete-timeout') return
        if (mode === 'delete-fails') res.statusCode = 503
        res.end()
    } else if (req.method === 'POST' && req.url?.includes('/exec/')) {
        res.end()
    } else {
        res.statusCode = 404
        res.end()
    }
})
const wss = new WebSocketServer({ server })
wss.on('connection', (socket) => {
    const connection = ++counts.connections
    socket.on('error', () => {})
    if (mode === 'wss-cancel' || connection === 3) {
        controller.abort(new Error('cancel pending probe transport'))
        return
    }
    socket.send(
        JSON.stringify({
            type: 'session_info',
            session_id: `fixture-${connection}`
        })
    )
    if (connection === 2) {
        socket.send(Buffer.concat([Buffer.from([0x01]), Buffer.from('done\n')]))
        socket.send(Buffer.from([0x03, 0]))
    }
})

test(
    'owned local Sprite lifecycle fixture',
    { timeout: mode === 'timeout' ? 50 : 5000, signal: controller.signal },
    async (t) => {
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        assert.ok(address && typeof address === 'object')
        const clientOptions = {
            token: 'local-fixture',
            baseUrl: `http://127.0.0.1:${address.port}`,
            wsBaseUrl: `ws://127.0.0.1:${address.port}`
        }
        const client = createClient({
            ...clientOptions,
            requestTimeoutMs: 1000
        })
        const cleanupClient =
            mode === 'delete-timeout'
                ? createClient({ ...clientOptions, requestTimeoutMs: 50 })
                : client
        if (mode === 'timeout')
            client.createSprite = async () => {
                counts.create++
                return { id: 'fixture', name, status: 'running' }
            }
        const lifecycle = withLiveSprite(
            t,
            {
                createSprite: (input) => client.createSprite(input),
                deleteSprite: (target) => cleanupClient.deleteSprite(target)
            },
            name,
            async (signal) => {
                counts.body++
                if (mode === 'timeout') {
                    console.log('body pending')
                    await new Promise(() => {})
                } else if (mode === 'wss-cancel' || mode === 'exec-cancel') {
                    await runDetachProbe(client, name, signal, async (ms) => {
                        signal.throwIfAborted()
                        if (ms === 3000)
                            await new Promise<void>((_, reject) => {
                                signal.addEventListener(
                                    'abort',
                                    () => reject(signal.reason),
                                    { once: true }
                                )
                            })
                    })
                }
            },
            { wait: async () => {} }
        )
        t.after(
            async () => {
                await lifecycle.catch(() => {})
                // close() waits for the real probe to close its WebSockets; this
                // fixture must not terminate those sockets on the probe's behalf.
                await new Promise<void>((resolve, reject) =>
                    wss.close((error) => (error ? reject(error) : resolve()))
                )
                await new Promise<void>((resolve, reject) => {
                    server.close((error) => (error ? reject(error) : resolve()))
                    server.closeAllConnections()
                })
                console.log(`fixture-counts ${JSON.stringify(counts)}`)
            },
            { timeout: 2000 }
        )
        await lifecycle
    }
)
