import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { SpritesError, execSprite, type SpritesClient } from '@manyfold/sprites'
import type { RuntimeHostRow } from '@manyfold/db'
import { HostBringUpService } from '../src/modules/hosts/bring-up/host-bring-up.service'
import { spritesErrorFacts } from '../src/modules/hosts/providers/sprites.provider'

// #730. A sprite whose exec endpoint 502s the WebSocket UPGRADE fails the
// daemon inspect, and `runner_unavailable` — "no daemon, try later" — is
// exactly the wrong conclusion: the transport that just died is the sprite's
// own exec endpoint, and the caller has to quarantine the host on that fact.
//
// These drive the real HostBringUpService against a real socket, because the
// classification depends on how `ws` actually reports a pre-open failure, not on
// a stub of it: `unexpected-response` (status-carrying) vs `error` (no status).

interface Harness {
    port: number
    upgrades: number
    close: () => Promise<void>
}

// Answers every UPGRADE with a plain HTTP status instead of 101 — how the
// unhealthy staging sprite behaved. The socket is left for the harness to tear
// down: destroying it here races the client's response parse, and the race is
// the difference between a status-carrying handshake failure and a bare
// transport error.
const startRejectingServer = async (status: number): Promise<Harness> => {
    const harness = { upgrades: 0 }
    const sockets = new Set<Duplex>()
    const server = createServer()
    server.on('upgrade', (_req, socket) => {
        harness.upgrades += 1
        sockets.add(socket)
        socket.on('error', () => {})
        socket.on('close', () => sockets.delete(socket))
        if (!socket.destroyed)
            socket.write(
                `HTTP/1.1 ${status} Bad Gateway\r\nContent-Length: 0\r\n\r\n`
            )
    })
    return listen(server, harness, sockets)
}

// Nothing is ever written: the client sees the connection go away before the
// handshake completes, which `ws` reports as an error with no status.
const startHangUpServer = async (): Promise<Harness> => {
    const harness = { upgrades: 0 }
    const sockets = new Set<Duplex>()
    const server = createServer()
    server.on('upgrade', (_req, socket) => {
        harness.upgrades += 1
        socket.on('error', () => {})
        socket.destroy()
    })
    return listen(server, harness, sockets)
}

// A sprite that answers: the socket opens and the command exits.
const startExitingServer = async (
    exitCode: number,
    stdout = ''
): Promise<Harness> => {
    const harness = { upgrades: 0 }
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    wss.on('connection', (ws: WebSocket) => {
        harness.upgrades += 1
        ws.on('error', () => {})
        if (stdout)
            ws.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(stdout)]))
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
        close: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy()
                server.close(() => resolve())
            })
    }
}

// Byte-for-byte what the sprites adapter's bootstrap hands the socket, so the
// classification is proven against the transport the bring-up actually uses.
const spriteExecFor = (port: number) => {
    const client = {
        wsBaseUrl: `ws://127.0.0.1:${port}`,
        authHeaderForInternalUse: () => ({})
    } as unknown as SpritesClient
    return (a: { cmd: string[]; stdin?: string; timeoutMs: number }) =>
        execSprite(client, 'sbx-1', {
            cmd: a.cmd,
            stdin: a.stdin ?? '',
            timeoutMs: a.timeoutMs
        })
}

type ExecFn = ReturnType<typeof spriteExecFor>

const host = {
    id: 'sbx_1',
    userId: 'user-1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sprite-1' },
    name: 'sandbox-001',
    status: 'ready',
    generation: 1,
    workspaceBaseDir: '/home/sprite/.manyfold/workspaces'
} as unknown as RuntimeHostRow

const managerHarness = () => {
    let minted = 0
    let generation = 1
    class TestRunnerManager extends HostBringUpService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    const adapterFor = (exec: ExecFn) => ({
        kind: 'sprites',
        capabilities: { suspend: true, publicService: true },
        power: async () => 'running',
        wake: async () => {},
        describeError: spritesErrorFacts,
        bootstrap: (args: { script: string; stdin?: string; timeoutMs?: number }) =>
            exec({
                cmd: ['bash', '-lc', args.script],
                stdin: args.stdin,
                timeoutMs: args.timeoutMs ?? 60_000
            })
    })
    let adapter: ReturnType<typeof adapterFor> | null = null
    const service = new TestRunnerManager(
        {
            findById: async () => ({ ...host, generation }),
            patch: async () => null,
            bumpGeneration: async () => ++generation
        } as never,
        { findByHostId: async () => null } as never,
        { for: () => adapter } as never,
        { providerForHost: async () => ({ id: 'rtp_1', kind: 'sprites' }) } as never,
        {
            mint: async (a: { name: string }) => {
                minted++
                return {
                    tokenId: 't',
                    plaintext: 'ldt_secret_value',
                    name: a.name,
                    hostId: 'sbx_1',
                    expiresAt: null,
                    createdAt: new Date()
                }
            },
            revoke: async () => 'sbx_1'
        } as never,
        { rpc: async () => ({}), onConnected: () => () => {} } as never,
        { hold: () => ({ settled: Promise.resolve(true), release: async () => {}, detach: () => {} }) } as never
    )
    const resolve = (exec: ExecFn) => {
        adapter = adapterFor(exec)
        return service.ensureHostDaemon({
            agentId: 'agt_1',
            host,
            waitOnlineMs: 50
        })
    }
    return { service, resolve, mintedCount: () => minted }
}

const throwingExec = (err: Error): ExecFn => async () => {
    throw err
}

test('a pre-open handshake 5xx is a classified exec failure, not a missing daemon', async () => {
    const server = await startRejectingServer(502)
    const h = managerHarness()
    try {
        const res = await h.resolve(spriteExecFor(server.port))

        assert.equal(res.handle, null)
        assert.equal(res.fallbackReason, 'sprite_exec_unavailable')
        assert.equal(res.execFailure?.failureClass, 'handshake_5xx')
        assert.equal(res.execFailure?.upstreamStatus, 502)
        // One attempt, then stop: install/register/start would each pay the
        // same handshake against a socket that cannot open.
        assert.equal(server.upgrades, 1)
        assert.equal(h.mintedCount(), 0, 'no token minted for a dead endpoint')
    } finally {
        await server.close()
    }
})

test('a pre-open transport error is classified without inventing a status', async () => {
    const server = await startHangUpServer()
    const h = managerHarness()
    try {
        const res = await h.resolve(spriteExecFor(server.port))

        assert.equal(res.fallbackReason, 'sprite_exec_unavailable')
        assert.equal(res.execFailure?.failureClass, 'transport_error')
        assert.equal(res.execFailure?.upstreamStatus, undefined)
        assert.equal(server.upgrades, 1)
    } finally {
        await server.close()
    }
})

// The real thing takes the full 60s inspect budget, which is not a test. The
// error object is reproduced exactly as execSpriteStream builds it: transient,
// no status, no reason.
test('an inspect that burns its whole budget is classified as a timeout', async () => {
    const h = managerHarness()

    const res = await h.resolve(
        throwingExec(
            new SpritesError(
                'transient',
                'execSpriteStream timed out after 60000ms',
                undefined,
                undefined,
                { execPhase: 'pre_open' }
            )
        )
    )

    assert.equal(res.fallbackReason, 'sprite_exec_unavailable')
    assert.equal(res.execFailure?.failureClass, 'timeout')
    assert.equal(res.execFailure?.upstreamStatus, undefined)
})

// Everything below is the false-positive boundary. Marking a host's exec
// endpoint unhealthy takes it out of the turn path, so it must happen ONLY for
// failures of that endpoint — never for a sprite that answered.

test('a sprite that answers with a non-zero exit is a plain missing daemon', async () => {
    const server = await startExitingServer(127)
    const h = managerHarness()
    try {
        const res = await h.resolve(spriteExecFor(server.port))

        assert.equal(res.handle, null)
        assert.equal(res.fallbackReason, 'runner_unavailable')
        assert.equal(res.execFailure, undefined)
    } finally {
        await server.close()
    }
})

test('an auth rejection never marks the exec endpoint unhealthy', async () => {
    const server = await startRejectingServer(401)
    const h = managerHarness()
    try {
        const res = await h.resolve(spriteExecFor(server.port))

        // A revoked account token is not a sick VM. Quarantining on it would
        // take every healthy sprite on that account out of rotation at once.
        assert.equal(res.fallbackReason, 'runner_unavailable')
        assert.equal(res.execFailure, undefined)
    } finally {
        await server.close()
    }
})

test('a session reaped after its process exited is not an endpoint failure', async () => {
    const h = managerHarness()

    const res = await h.resolve(
        throwingExec(
            new SpritesError(
                'transient',
                'exec session gone',
                undefined,
                undefined,
                { reason: 'exec_session_gone' }
            )
        )
    )

    assert.equal(res.fallbackReason, 'runner_unavailable')
    assert.equal(res.execFailure, undefined)
})

test('a socket that opened and then died is not a pre-open failure', async () => {
    const h = managerHarness()

    const res = await h.resolve(
        throwingExec(
            new SpritesError(
                'transient',
                'execSpriteStream closed without exit code'
            )
        )
    )

    assert.equal(res.fallbackReason, 'runner_unavailable')
    assert.equal(res.execFailure, undefined)
})

test('a command timeout after WebSocket open is not an endpoint failure', async () => {
    const h = managerHarness()

    const res = await h.resolve(
        throwingExec(
            new SpritesError(
                'transient',
                'execSpriteStream timed out after 15000ms',
                undefined,
                undefined,
                { execPhase: 'post_open' }
            )
        )
    )

    assert.equal(res.fallbackReason, 'runner_unavailable')
    assert.equal(res.execFailure, undefined)
})

test('concurrent turns on one host share a single classified failure', async () => {
    const server = await startRejectingServer(502)
    const h = managerHarness()
    try {
        const exec = spriteExecFor(server.port)
        const results = await Promise.all([
            h.resolve(exec),
            h.resolve(exec),
            h.resolve(exec)
        ])

        // The in-process single-flight must carry the classification to every
        // waiter, not just the winner: a waiter that got a bare null would
        // treat the endpoint the winner just proved dead as merely idle.
        for (const res of results) {
            assert.equal(res.fallbackReason, 'sprite_exec_unavailable')
            assert.equal(res.execFailure?.upstreamStatus, 502)
        }
        assert.equal(server.upgrades, 1, 'one probe of a dead endpoint, total')
    } finally {
        await server.close()
    }
})
