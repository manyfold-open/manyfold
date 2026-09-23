import assert from 'node:assert/strict'
import { after } from 'node:test'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'

const stateDir = await mkdtemp(join(tmpdir(), 'mf-ws-lifecycle-'))
const previousConfigDir = process.env.MF_CONFIG_DIR
process.env.MF_CONFIG_DIR = stateDir
const { DaemonWsClient } = await import('../src/daemon/ws-client')
after(async () => {
    if (previousConfigDir === undefined) delete process.env.MF_CONFIG_DIR
    else process.env.MF_CONFIG_DIR = previousConfigDir
    await rm(stateDir, { recursive: true, force: true })
})

type Client = InstanceType<typeof DaemonWsClient>
const internals = (client: Client) =>
    client as unknown as {
        ws: WebSocket | null
        pingTimer: ReturnType<typeof setInterval> | null
        reconnectTimer: ReturnType<typeof setTimeout> | null
        gcTimer: ReturnType<typeof setInterval> | null
        scheduleReconnect(): void
        connect(): void
        backoffMs: number
    }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'socket lifecycle did not settle')
        await delay(10)
    }
}

const withServer = async (
    run: (url: string, sockets: WebSocket[]) => Promise<void>
) => {
    const server = createServer()
    const wss = new WebSocketServer({ server })
    const sockets: WebSocket[] = []
    wss.on('connection', (socket) => sockets.push(socket))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    try {
        await run(`http://127.0.0.1:${address.port}`, sockets)
    } finally {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

const options = (apiUrl: string) => ({
    apiUrl,
    token: 'synthetic-daemon-token',
    daemonUuid: 'fixture-lifecycle',
    cliVersion: '0.0.0-test'
})

test('repeated start keeps one dial and one buffer sweep', async () => {
    await withServer(async (url, sockets) => {
        const client = new DaemonWsClient(options(url))
        client.start()
        const socket = internals(client).ws
        const gc = internals(client).gcTimer
        try {
            client.start()
            assert.equal(internals(client).ws, socket)
            assert.equal(internals(client).gcTimer, gc)
            await until(() => socket?.readyState === WebSocket.OPEN)
            assert.equal(sockets.length, 1)
        } finally {
            client.stop()
            socket?.terminate()
            if (gc) clearInterval(gc)
        }
    })
})

test('late events from an old socket cannot close or dispatch on its successor', async () => {
    await withServer(async (url, sockets) => {
        let disconnected = 0
        let welcome = 0
        let rpc = 0
        const client = new DaemonWsClient({
            ...options(url),
            onDisconnected: () => {
                disconnected++
            },
            onWelcome: () => {
                welcome++
            },
            handleRpc: async () => {
                rpc++
                return { ok: true }
            }
        })
        let originalPing: ReturnType<typeof setInterval> | null = null
        client.start()
        try {
            await until(
                () =>
                    sockets.length === 1 &&
                    internals(client).ws?.readyState === WebSocket.OPEN
            )
            const old = internals(client).ws!
            sockets[0].close()
            await until(
                () =>
                    sockets.length === 2 &&
                    internals(client).ws?.readyState === WebSocket.OPEN
            )
            const current = internals(client).ws!
            const ping = internals(client).pingTimer
            originalPing = ping
            const disconnects = disconnected
            old.emit('open')
            old.emit(
                'message',
                Buffer.from(
                    JSON.stringify({
                        type: 'welcome',
                        daemonId: 'old',
                        runtimeIds: []
                    })
                )
            )
            old.emit(
                'message',
                Buffer.from(
                    JSON.stringify({
                        type: 'push',
                        refId: 'old-ref',
                        method: 'exec.start',
                        payload: {}
                    })
                )
            )
            old.emit('close', 1000, Buffer.from('late close'))
            await delay(20)
            assert.equal(internals(client).ws, current)
            assert.equal(current.readyState, WebSocket.OPEN)
            assert.equal(internals(client).pingTimer, ping)
            assert.equal(internals(client).reconnectTimer, null)
            assert.equal(disconnected, disconnects)
            assert.equal(welcome, 0)
            assert.equal(rpc, 0)

            const acks: Array<Record<string, unknown>> = []
            sockets[1].on('message', (data) => {
                const frame = JSON.parse(String(data))
                if (frame.type === 'ack') acks.push(frame)
            })
            sockets[1].send(
                JSON.stringify({
                    type: 'push',
                    refId: 'current-ref',
                    method: 'exec.start',
                    payload: {}
                })
            )
            await until(() => acks.length > 0)
            assert.equal(acks[0].refId, 'current-ref')
            assert.equal(rpc, 1)
        } finally {
            client.stop()
            if (originalPing) clearInterval(originalPing)
        }
    })
})

test('reconnect scheduling is single-flight and stop retires a pending retry', async () => {
    await withServer(async (url, sockets) => {
        const client = new DaemonWsClient(options(url))
        const timers = new Set<ReturnType<typeof setTimeout>>()
        client.start()
        try {
            await until(
                () =>
                    sockets.length === 1 &&
                    internals(client).ws?.readyState === WebSocket.OPEN
            )
            sockets[0].close()
            await until(() => internals(client).reconnectTimer !== null)
            const timer = internals(client).reconnectTimer
            if (timer) timers.add(timer)
            internals(client).scheduleReconnect()
            if (internals(client).reconnectTimer)
                timers.add(internals(client).reconnectTimer!)
            internals(client).scheduleReconnect()
            if (internals(client).reconnectTimer)
                timers.add(internals(client).reconnectTimer!)
            assert.equal(internals(client).reconnectTimer, timer)
            client.stop()
            assert.equal(internals(client).reconnectTimer, null)
            await delay(1100)
            assert.equal(sockets.length, 1)
        } finally {
            client.stop()
            for (const timer of timers) clearTimeout(timer)
        }
    })
})

test('completion from an old connection cannot remove a new RPC cancel handler', async () => {
    await withServer(async (url, sockets) => {
        let calls = 0
        let oldCancelled = 0
        let newCancelled = 0
        let finishOld: (() => void) | undefined
        let finishNew: (() => void) | undefined
        const connectionChecks: Array<() => boolean> = []
        const client = new DaemonWsClient({
            ...options(url),
            handleRpc: async (_method, _payload, ctx) => {
                const old = ++calls === 1
                assert(ctx.isCurrentConnection)
                connectionChecks.push(ctx.isCurrentConnection)
                ctx.onCancel(() => {
                    if (old) oldCancelled++
                    else newCancelled++
                })
                await new Promise<void>((resolve) => {
                    if (old) finishOld = resolve
                    else finishNew = resolve
                })
                return { ok: true }
            }
        })
        const request = JSON.stringify({
            type: 'push',
            refId: 'same-ref',
            method: 'fs.stat',
            payload: {}
        })
        client.start()
        try {
            await until(
                () =>
                    sockets.length === 1 &&
                    internals(client).ws?.readyState === WebSocket.OPEN
            )
            sockets[0].send(request)
            await until(() => finishOld !== undefined)
            assert.equal(connectionChecks[0](), true)
            sockets[0].close()
            await until(
                () =>
                    sockets.length === 2 &&
                    internals(client).ws?.readyState === WebSocket.OPEN
            )
            sockets[1].send(request)
            await until(() => finishNew !== undefined)
            assert.equal(connectionChecks[0](), false)
            assert.equal(connectionChecks[1](), true)
            finishOld!()
            await delay(20)
            sockets[1].send(
                JSON.stringify({ type: 'cancel', refId: 'same-ref' })
            )
            await until(() => newCancelled === 1)
            assert.equal(oldCancelled, 0)
        } finally {
            finishOld?.()
            finishNew?.()
            await delay(10)
            client.stop()
            assert(connectionChecks.every((check) => !check()))
        }
    })
})

// Each close is answered by dialing again at once, so the delay the client
// scheduled is read from its log instead of waited out.
const redialNow = async (
    client: Client,
    sockets: WebSocket[],
    count: number
) => {
    await until(() => internals(client).reconnectTimer !== null)
    const timer = internals(client).reconnectTimer
    if (timer) clearTimeout(timer)
    internals(client).reconnectTimer = null
    internals(client).connect()
    await until(() => sockets.length === count)
}

const lastDelay = (logs: string[]): string | undefined =>
    logs.filter((line) => line.startsWith('reconnecting in ')).at(-1)

test('a refusal after the upgrade backs off in minutes and says why', async () => {
    await withServer(async (url, sockets) => {
        const logs: string[] = []
        const client = new DaemonWsClient({
            ...options(url),
            log: (line) => logs.push(line)
        })
        client.start()
        try {
            await until(() => sockets.length === 1)
            sockets[0].close(4403, 'daemon revoked')
            await until(() => internals(client).reconnectTimer !== null)
            assert.ok(
                logs.some((line) =>
                    line.startsWith(
                        'the API refused this daemon: this machine was revoked'
                    )
                )
            )
            assert.equal(lastDelay(logs), 'reconnecting in 60000ms')

            await redialNow(client, sockets, 2)
            sockets[1].close(4406, 'daemon CLI 0.34.0 or newer required')
            await until(() => internals(client).reconnectTimer !== null)
            assert.equal(lastDelay(logs), 'reconnecting in 120000ms')
            assert.ok(logs.some((line) => line.includes('run mf update')))
        } finally {
            client.stop()
        }
    })
})

test('the backoff resets when the server takes the hello, not on open', async () => {
    await withServer(async (url, sockets) => {
        const logs: string[] = []
        const client = new DaemonWsClient({
            ...options(url),
            log: (line) => logs.push(line)
        })
        client.start()
        try {
            await until(() => sockets.length === 1)
            sockets[0].close(4000, 'pong timeout')
            await until(() => internals(client).reconnectTimer !== null)
            assert.equal(lastDelay(logs), 'reconnecting in 1000ms')

            // Opened, then closed without a welcome: that is not a
            // connection, so the next attempt waits longer.
            await redialNow(client, sockets, 2)
            sockets[1].close(4000, 'pong timeout')
            await until(() => internals(client).reconnectTimer !== null)
            assert.equal(lastDelay(logs), 'reconnecting in 2000ms')

            await redialNow(client, sockets, 3)
            sockets[2].send(
                JSON.stringify({
                    type: 'welcome',
                    daemonId: 'ldh_fixture',
                    serverTime: new Date().toISOString(),
                    runtimeIds: []
                })
            )
            await until(() => internals(client).backoffMs === 1000)
            sockets[2].close(1012, 'service restart')
            await until(() => internals(client).reconnectTimer !== null)
            assert.equal(lastDelay(logs), 'reconnecting in 1000ms')
        } finally {
            client.stop()
        }
    })
})
