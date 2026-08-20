import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { SpritesError, type SpritesClient } from '@manyfold/sprites'
import { probeSandboxExec } from '../src/modules/agent-runtimes/provisioning/sandbox-exec-health'

// #439: the create failures on staging were WebSocket UPGRADE failures — the
// exec endpoint answered HTTP 502 after ~36s, before any frame was exchanged.
// These tests drive the probe against a real socket so the classification it
// depends on (transient → quarantine the host, everything else → surface as-is)
// is proven against ws's actual behaviour, not a stub of it.

interface Harness {
    port: number
    upgrades: number
    close: () => Promise<void>
}

// Answers every WebSocket upgrade with a plain HTTP status instead of 101 —
// exactly how the unhealthy staging sprite behaved.
const startRejectingServer = async (
    status: number,
    delayMs = 0
): Promise<Harness> => {
    const harness = { upgrades: 0 } as { upgrades: number }
    const sockets = new Set<Duplex>()
    const server = createServer()
    server.on('upgrade', (_req, socket) => {
        harness.upgrades += 1
        sockets.add(socket)
        socket.on('error', () => {})
        socket.on('close', () => sockets.delete(socket))
        const write = (): void => {
            if (socket.destroyed) return
            socket.write(
                `HTTP/1.1 ${status} Bad Gateway\r\nConnection: close\r\n\r\n`
            )
            socket.destroy()
        }
        if (delayMs > 0) setTimeout(write, delayMs).unref()
        else write()
    })
    return listen(server, harness, sockets)
}

const startExitingServer = async (exitCode: number): Promise<Harness> => {
    const harness = { upgrades: 0 } as { upgrades: number }
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    wss.on('connection', (ws: WebSocket) => {
        harness.upgrades += 1
        ws.on('error', () => {})
        ws.send(Buffer.from([0x03, exitCode]))
    })
    const address = wss.address()
    return {
        port: typeof address === 'object' && address ? address.port : 0,
        get upgrades() {
            return harness.upgrades
        },
        close: () => new Promise<void>((resolve) => wss.close(() => resolve()))
    }
}

const listen = async (
    server: Server,
    harness: { upgrades: number },
    sockets: Set<Duplex>
): Promise<Harness> => {
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    return {
        port: typeof address === 'object' && address ? address.port : 0,
        get upgrades() {
            return harness.upgrades
        },
        // hijacked upgrade sockets are not tracked by server.close()
        close: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy()
                server.close(() => resolve())
            })
    }
}

const clientFor = (port: number): SpritesClient =>
    ({
        wsBaseUrl: `ws://127.0.0.1:${port}`,
        authHeaderForInternalUse: () => ({})
    }) as unknown as SpritesClient

test('a healthy sandbox passes the probe on the first attempt', async () => {
    const server = await startExitingServer(0)
    try {
        const result = await probeSandboxExec({
            client: clientFor(server.port),
            spriteName: 'sbx-healthy'
        })
        assert.deepEqual(result, { ok: true, attempts: 1 })
        assert.equal(server.upgrades, 1, 'a healthy host must be probed once')
    } finally {
        await server.close()
    }
})

test('a handshake 502 marks the host unhealthy after a bounded number of retries', async () => {
    const server = await startRejectingServer(502)
    try {
        const result = await probeSandboxExec({
            client: clientFor(server.port),
            spriteName: 'sbx-unhealthy',
            retryDelayMs: 1
        })
        assert.equal(result.ok, false)
        assert.equal(result.attempts, 2)
        assert.match(
            String(result.detail),
            /exec handshake HTTP 502|exec transport unavailable/
        )
        assert.equal(
            server.upgrades,
            2,
            'the probe must retry a transient handshake failure, and must stop'
        )
    } finally {
        await server.close()
    }
})

// The staging failures took 35.98–36.91s to answer. Waiting that out per
// candidate is most of the cost of the bug, so the probe must give up first and
// still report the host as unhealthy rather than propagating a hang.
test('a hanging exec endpoint fails the probe on the probe timeout, not the platform timeout', async () => {
    const server = await startRejectingServer(502, 5_000)
    try {
        const started = Date.now()
        const result = await probeSandboxExec({
            client: clientFor(server.port),
            spriteName: 'sbx-hanging',
            timeoutMs: 150,
            retryDelayMs: 1
        })
        assert.equal(result.ok, false)
        assert.equal(result.detail, 'exec probe timed out')
        assert.ok(
            Date.now() - started < 4_000,
            'the probe must not wait for the platform to answer'
        )
    } finally {
        await server.close()
    }
})

// Criterion: non-transient failures must fail the create outright. Quarantining
// a host over a revoked account token would take healthy VMs out of rotation and
// send provisioning around a pointless failover loop.
test('an auth failure throws instead of reporting an unhealthy host', async () => {
    const server = await startRejectingServer(401)
    try {
        const err = await probeSandboxExec({
            client: clientFor(server.port),
            spriteName: 'sbx-auth',
            retryDelayMs: 1
        }).then(
            () => null,
            (e: unknown) => e
        )
        assert.ok(err instanceof SpritesError)
        assert.equal(err.code, 'auth')
        assert.equal(server.upgrades, 1, 'auth failures must not be retried')
    } finally {
        await server.close()
    }
})

test('a post-open no-op failure is surfaced without quarantining the endpoint', async () => {
    const server = await startExitingServer(127)
    try {
        const err = await probeSandboxExec({
            client: clientFor(server.port),
            spriteName: 'sbx-broken-shell',
            retryDelayMs: 1
        }).then(
            () => null,
            (e: unknown) => e
        )
        assert.ok(err instanceof SpritesError)
        assert.equal(err.code, 'permanent')
        assert.equal(err.execPhase, 'post_open')
        assert.equal(
            server.upgrades,
            1,
            'the socket opened, so this is not a handshake blip to retry'
        )
    } finally {
        await server.close()
    }
})
