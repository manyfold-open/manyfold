import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { execSpriteStream } from '../src/exec-stream'
import { SpritesError } from '../src/errors'
import type { SpritesClient } from '../src/client'

const startServer = async (
    onConn: (ws: WebSocket, req: IncomingMessage) => void
): Promise<{ port: number; close: () => Promise<void> }> => {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    wss.on('connection', (ws, req) => {
        ws.on('message', () => {})
        ws.on('error', () => {})
        onConn(ws, req)
    })
    const address = wss.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
        port,
        close: () => new Promise<void>((resolve) => wss.close(() => resolve()))
    }
}

// A server that completes the WebSocket handshake then never reads or pongs —
// simulates a connection that is open at the TCP layer but unresponsive. This
// is more reliable than trying to suppress ws's automatic pong on an accepted
// connection.
const startDeafServer = async (
    greeting?: Buffer
): Promise<{
    port: number
    close: () => Promise<void>
}> => {
    const server = createServer()
    const sockets = new Set<{ destroy: () => void }>()
    server.on('upgrade', (req, socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        const key = req.headers['sec-websocket-key'] ?? ''
        const accept = createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64')
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        )
        if (greeting) socket.write(greeting)
        socket.on('data', () => {}) // swallow client frames (incl. pings); never pong
        socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
        port,
        close: () =>
            new Promise<void>((resolve) => {
                // the deaf socket never completes the close handshake, so
                // destroy the hijacked upgrade socket(s) before closing
                for (const socket of sockets) socket.destroy()
                server.close(() => resolve())
            })
    }
}

interface KillCall {
    spriteName: string
    sessionId: string
}

const fakeClient = (port: number, kills?: KillCall[]): SpritesClient =>
    ({
        wsBaseUrl: `ws://127.0.0.1:${port}`,
        authHeaderForInternalUse: () => ({}),
        killExecSession: async (spriteName: string, sessionId: string) => {
            kills?.push({ spriteName, sessionId })
        }
    }) as unknown as SpritesClient

const exitFrame = (code: number): Buffer => Buffer.from([0x03, code])

const sessionInfoText = (sessionId: string): string =>
    JSON.stringify({ type: 'session_info', session_id: sessionId })

// Hand-built server→client text frame (FIN + opcode 0x1, unmasked, len < 126)
// for the deaf server, which writes to the raw upgrade socket.
const rawTextFrame = (payload: string): Buffer => {
    const data = Buffer.from(payload, 'utf8')
    return Buffer.concat([Buffer.from([0x81, data.length]), data])
}

const safeSend = (ws: WebSocket, frame: Buffer): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame)
}

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

// Captured at module load, so it survives a mock.timers.enable() and can still
// yield REAL time for real socket I/O while the faked clock stands still.
const realSetTimeout = globalThis.setTimeout
const realDelay = (ms: number): Promise<void> =>
    new Promise((resolve) => realSetTimeout(resolve, ms))

const drain = async (it: AsyncIterable<string>): Promise<void> => {
    try {
        for await (const chunk of it) void chunk
    } catch {
        // stream fails on timeout/liveness; the result promise carries the error
    }
}

interface LogEvent {
    level: 'debug' | 'info' | 'warn' | 'error'
    msg: string
    meta?: Record<string, unknown>
}

const makeLogger = (): {
    logger: {
        debug: (m: string, meta?: Record<string, unknown>) => void
        info: (m: string, meta?: Record<string, unknown>) => void
        warn: (m: string, meta?: Record<string, unknown>) => void
        error: (m: string, meta?: Record<string, unknown>) => void
    }
    events: LogEvent[]
} => {
    const events: LogEvent[] = []
    const at =
        (level: LogEvent['level']) =>
        (msg: string, meta?: Record<string, unknown>): void => {
            events.push({ level, msg, meta })
        }
    return {
        logger: {
            debug: at('debug'),
            info: at('info'),
            warn: at('warn'),
            error: at('error')
        },
        events
    }
}

const rejectionOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
        () => {
            throw new Error('expected rejection')
        },
        (err) => err
    )

// The only liveness test that asserts a timeout does NOT fire, which makes it
// the only one where a slow machine can produce a wrong answer rather than a
// late one. It used to sit in real time for 500ms with a 120ms window and hope
// no scheduling gap exceeded it; under `pnpm test` at the repo root (16 suites
// in parallel) a single stall past the window killed the connection and the
// assertion flipped. Reproduced deterministically with one 200ms synchronous
// block: `connection lost (no response for 120ms)`.
//
// So the liveness clock is faked here and advanced only by this test. A starved
// event loop can no longer expire a window the process never got to observe:
// while the loop is blocked no ticks happen either, and the queued pong is
// processed before the next one. Verified: 1200ms of real time with zero ticks
// does not fire the window, and a 500ms mid-loop stall is a no-op.
//
// Real socket I/O is deliberately NOT faked — the pings below are real frames
// answered by the real server's auto-pong, so this still exercises the actual
// keepalive -> pong -> armLiveness path rather than a mocked stand-in. Ticking
// 40ms at a time against a 200ms window leaves four consecutive round trips of
// slack, where the old shape had none.
test('liveness: a quiet but ponging connection survives past the liveness window and resolves on exit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    let conn: WebSocket | null = null
    const server = await startServer((ws) => {
        conn = ws // default auto-pong is on; send no data
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 10_000,
            keepAliveMs: 40,
            livenessTimeoutMs: 200
        })
        void drain(handle.stdout)
        // Observed rather than awaited: the point is that it stays unsettled.
        let failure: Error | null = null
        void handle.result.catch((err: Error) => {
            failure = err
        })
        const observedFailure = (): Error | null => failure
        for (let i = 0; i < 40 && !conn; i += 1) await realDelay(5)
        assert.ok(conn, 'expected a connection')

        // 600ms of keepalive cycles against a 200ms window: without the pong
        // re-arming it, the third tick would already have killed the socket.
        for (let i = 0; i < 15; i += 1) {
            t.mock.timers.tick(40)
            await realDelay(5)
        }
        assert.equal(
            failure,
            null,
            `pongs failed to keep the connection alive: ${observedFailure()?.message}`
        )

        safeSend(conn, exitFrame(0))
        const result = await handle.result
        assert.equal(result.exitCode, 0)
    } finally {
        await server.close()
    }
})

test('liveness: a connection that stops responding fails with the connection-lost message', async () => {
    const server = await startDeafServer()
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 10_000,
            keepAliveMs: 40,
            livenessTimeoutMs: 120
        })
        void drain(handle.stdout)
        await assert.rejects(
            handle.result,
            /connection lost \(no response for 120ms\)/
        )
    } finally {
        await server.close()
    }
})

test('liveness: the absolute backstop still fires when it is the shorter bound', async () => {
    const server = await startServer(() => {
        // ponging, no data
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 150,
            keepAliveMs: 40,
            livenessTimeoutMs: 10_000
        })
        void drain(handle.stdout)
        await assert.rejects(handle.result, (err: unknown) => {
            assert.ok(err instanceof SpritesError)
            assert.match(err.message, /timed out after 150ms/)
            assert.equal(err.execPhase, 'post_open')
            return true
        })
    } finally {
        await server.close()
    }
})

test('liveness: pongs do not extend life when keepalive options are unset (back-compat)', async () => {
    const server = await startServer(() => {
        // ponging, no data, but liveness is off
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 200
        })
        await assert.rejects(handle.result, /timed out after 200ms/)
    } finally {
        await server.close()
    }
})

test('liveness: the client sends ping frames on the keepAlive interval', async () => {
    let pings = 0
    const server = await startServer((ws) => {
        ws.on('ping', () => {
            pings += 1
        })
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 10_000,
            keepAliveMs: 40,
            livenessTimeoutMs: 10_000
        })
        handle.result.catch(() => {}) // abort() below rejects result; swallow it
        void drain(handle.stdout)
        await delay(250)
        handle.abort()
        assert.ok(pings >= 3, `expected >=3 client pings, got ${pings}`)
    } finally {
        await server.close()
    }
})

test('detach: the exec URL carries max_run_after_disconnect only when the option is set', async () => {
    const urls: string[] = []
    const server = await startServer((ws, req) => {
        urls.push(req.url ?? '')
        safeSend(ws, exitFrame(0))
    })
    try {
        await execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000,
            maxRunAfterDisconnectSeconds: 300
        }).result
        await execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000
        }).result
        assert.match(urls[0], /max_run_after_disconnect=300s/)
        assert.doesNotMatch(urls[1], /max_run_after_disconnect/)
    } finally {
        await server.close()
    }
})

test('detach: abort() kills the remote session when the option is set', async () => {
    const kills: KillCall[] = []
    const server = await startServer((ws) => {
        ws.send(sessionInfoText('sess-1'))
    })
    try {
        const handle = execSpriteStream(
            fakeClient(server.port, kills),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 10_000,
                maxRunAfterDisconnectSeconds: 600
            }
        )
        handle.result.catch(() => {})
        void drain(handle.stdout)
        await delay(100) // let session_info arrive
        handle.abort()
        await delay(20) // kill is fire-and-forget
        assert.deepEqual(kills, [{ spriteName: 'sprite', sessionId: 'sess-1' }])
    } finally {
        await server.close()
    }
})

test('detach: timeoutMs expiry kills the remote session when the option is set', async () => {
    const kills: KillCall[] = []
    const server = await startServer((ws) => {
        ws.send(sessionInfoText('sess-2')) // then stay silent past the timeout
    })
    try {
        const handle = execSpriteStream(
            fakeClient(server.port, kills),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 150,
                maxRunAfterDisconnectSeconds: 600
            }
        )
        void drain(handle.stdout)
        await assert.rejects(handle.result, /timed out after 150ms/)
        await delay(20)
        assert.deepEqual(kills, [{ spriteName: 'sprite', sessionId: 'sess-2' }])
    } finally {
        await server.close()
    }
})

test('detach: a liveness failure does not kill — the detach window must let the process survive', async () => {
    const kills: KillCall[] = []
    const server = await startDeafServer(
        rawTextFrame(sessionInfoText('sess-3'))
    )
    try {
        const handle = execSpriteStream(
            fakeClient(server.port, kills),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 10_000,
                keepAliveMs: 40,
                livenessTimeoutMs: 120,
                maxRunAfterDisconnectSeconds: 600
            }
        )
        void drain(handle.stdout)
        await assert.rejects(handle.result, /connection lost/)
        await delay(20)
        assert.equal(kills.length, 0)
    } finally {
        await server.close()
    }
})

test('detach: a server-initiated close without exit does not kill', async () => {
    const kills: KillCall[] = []
    const server = await startServer((ws) => {
        ws.send(sessionInfoText('sess-4'))
        setTimeout(() => ws.close(1000, 'gone'), 50)
    })
    try {
        const handle = execSpriteStream(
            fakeClient(server.port, kills),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 5_000,
                maxRunAfterDisconnectSeconds: 600
            }
        )
        void drain(handle.stdout)
        await assert.rejects(handle.result, /closed without exit code/)
        await delay(20)
        assert.equal(kills.length, 0)
    } finally {
        await server.close()
    }
})

test('detach: abort before session_info skips the kill but still rejects as aborted', async () => {
    const kills: KillCall[] = []
    const server = await startServer(() => {
        // never send session_info
    })
    try {
        const handle = execSpriteStream(
            fakeClient(server.port, kills),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 5_000,
                maxRunAfterDisconnectSeconds: 600
            }
        )
        void drain(handle.stdout)
        handle.abort()
        await assert.rejects(handle.result, /aborted/)
        await delay(20)
        assert.equal(kills.length, 0)
    } finally {
        await server.close()
    }
})

test('detach: abort after a received exit does not kill (settled guard)', async () => {
    const kills: KillCall[] = []
    const server = await startServer((ws) => {
        ws.send(sessionInfoText('sess-5'))
        safeSend(ws, exitFrame(0))
    })
    try {
        const handle = execSpriteStream(
            fakeClient(server.port, kills),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 5_000,
                maxRunAfterDisconnectSeconds: 600
            }
        )
        const result = await handle.result
        assert.equal(result.exitCode, 0)
        handle.abort()
        await delay(20)
        assert.equal(kills.length, 0)
    } finally {
        await server.close()
    }
})

test('detach: abort never kills when the option is unset (back-compat)', async () => {
    const kills: KillCall[] = []
    const server = await startServer((ws) => {
        ws.send(sessionInfoText('sess-6'))
    })
    try {
        const handle = execSpriteStream(
            fakeClient(server.port, kills),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 5_000
            }
        )
        handle.result.catch(() => {})
        void drain(handle.stdout)
        await delay(100)
        handle.abort()
        await delay(20)
        assert.equal(kills.length, 0)
    } finally {
        await server.close()
    }
})

const stdoutFrame = (payload: Buffer | string): Buffer => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    return Buffer.concat([Buffer.from([0x01]), data])
}

test('capture tail: result buffers stay bounded while the stream keeps full fidelity', async () => {
    const piece = 'x'.repeat(4096)
    const pieces = 16 // 64KB total
    const server = await startServer((ws) => {
        for (let i = 0; i < pieces; i++) safeSend(ws, stdoutFrame(piece))
        safeSend(ws, exitFrame(0))
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000,
            capture: 'tail'
        })
        let streamed = 0
        for await (const chunk of handle.stdout) streamed += chunk.length
        const result = await handle.result
        assert.equal(streamed, piece.length * pieces)
        assert.equal(result.exitCode, 0)
        assert.ok(result.stdout.length <= 8 * 1024)
        assert.ok(result.stdout.endsWith('x'))
    } finally {
        await server.close()
    }
})

test('capture default: result buffers keep the full output (back-compat)', async () => {
    const piece = 'y'.repeat(4096)
    const pieces = 4
    const server = await startServer((ws) => {
        for (let i = 0; i < pieces; i++) safeSend(ws, stdoutFrame(piece))
        safeSend(ws, exitFrame(0))
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000
        })
        void drain(handle.stdout)
        const result = await handle.result
        assert.equal(result.stdout.length, piece.length * pieces)
    } finally {
        await server.close()
    }
})

test('backpressure: a lagging consumer pauses the socket, parks liveness, and loses no bytes', async () => {
    const piece = Buffer.alloc(64 * 1024, 0x7a) // 'z'
    const pieces = 96 // 6MB > 4MB high water
    const totalBytes = piece.length * pieces
    const debugEvents: string[] = []
    const logger = {
        debug: (msg: string) => debugEvents.push(msg),
        info: () => {},
        warn: () => {},
        error: () => {}
    }
    const server = await startServer((ws) => {
        for (let i = 0; i < pieces; i++) safeSend(ws, stdoutFrame(piece))
        safeSend(ws, exitFrame(0))
    })
    try {
        const handle = execSpriteStream(
            fakeClient(server.port),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 30_000,
                keepAliveMs: 50,
                livenessTimeoutMs: 200,
                capture: 'tail'
            },
            logger
        )
        // Let the flood cross the high water mark while nothing consumes; the
        // 200ms liveness watchdog MUST be parked during the pause or it would
        // fail the stream on silence we caused ourselves.
        await delay(600)
        assert.ok(
            debugEvents.includes('sprites.exec.backpressure.pause'),
            `expected a pause event, saw: ${debugEvents.join(',')}`
        )
        let streamed = 0
        for await (const chunk of handle.stdout) streamed += chunk.length
        const result = await handle.result
        assert.equal(streamed, totalBytes)
        assert.equal(result.exitCode, 0)
        assert.ok(debugEvents.includes('sprites.exec.backpressure.resume'))
    } finally {
        await server.close()
    }
})

test('reattach: a dropped socket re-attaches, dedupes the full-history replay, and completes', async () => {
    const sid = 'sess-r1'
    const preDrop = ['A1\n', 'B2\n', 'C3\n']
    const live = ['D4\n', 'E5\n']
    let conns = 0
    const server = await startServer((ws, req) => {
        conns += 1
        const isAttach = (req.url ?? '').includes('id=')
        ws.send(sessionInfoText(sid))
        if (!isAttach) {
            for (const c of preDrop) safeSend(ws, stdoutFrame(c))
            // abrupt kill, no close frame — simulates a transport drop
            setTimeout(() => ws.terminate(), 50)
            return
        }
        // Platform semantics (probed 2026-07-07): attach replays the FULL
        // stdout history as a clean prefix, then live frames + exit follow.
        for (const c of [...preDrop, ...live]) safeSend(ws, stdoutFrame(c))
        safeSend(ws, exitFrame(0))
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 10_000,
            maxRunAfterDisconnectSeconds: 60,
            reattach: {}
        })
        let out = ''
        for await (const chunk of handle.stdout) out += chunk
        const result = await handle.result
        assert.equal(out, preDrop.join('') + live.join(''))
        assert.equal(result.exitCode, 0)
        assert.equal(conns, 2)
    } finally {
        await server.close()
    }
})

test('reattach: an attach refusal (session reaped) fails the stream immediately', async () => {
    const server = await startServer((ws, req) => {
        const isAttach = (req.url ?? '').includes('id=')
        if (!isAttach) {
            ws.send(sessionInfoText('sess-r2'))
            safeSend(ws, stdoutFrame('partial\n'))
            setTimeout(() => ws.terminate(), 30)
            return
        }
        ws.send(JSON.stringify({ error: 'session not found: sess-r2' }))
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 10_000,
            maxRunAfterDisconnectSeconds: 60,
            reattach: {}
        })
        void drain(handle.stdout)
        const err = await rejectionOf(handle.result)
        assert.ok(err instanceof SpritesError)
        assert.equal(
            err.message,
            'execSpriteStream attach failed: session not found'
        )
        // Structured marker lets the caller branch into JSONL recovery instead
        // of string-matching the wire message (#330).
        assert.equal(err.reason, 'exec_session_gone')
        assert.equal(err.execSessionId, 'sess-r2')
    } finally {
        await server.close()
    }
})

test('reattach: a non-"session not found" refusal carries the id but no gone reason', async () => {
    const server = await startServer((ws, req) => {
        const isAttach = (req.url ?? '').includes('id=')
        if (!isAttach) {
            ws.send(sessionInfoText('sess-x'))
            safeSend(ws, stdoutFrame('partial\n'))
            setTimeout(() => ws.terminate(), 30)
            return
        }
        ws.send(JSON.stringify({ error: 'internal server error' }))
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 10_000,
            maxRunAfterDisconnectSeconds: 60,
            reattach: {}
        })
        void drain(handle.stdout)
        const err = await rejectionOf(handle.result)
        assert.ok(err instanceof SpritesError)
        assert.equal(err.message, 'execSpriteStream attach refused')
        assert.equal(err.reason, undefined)
        assert.equal(err.execSessionId, 'sess-x')
    } finally {
        await server.close()
    }
})

test('reattach: a successful reattach then a reap surfaces the gone reason and deduped output', async () => {
    const sid = 'sess-seq'
    let conns = 0
    const server = await startServer((ws) => {
        conns += 1
        if (conns === 1) {
            ws.send(sessionInfoText(sid))
            safeSend(ws, stdoutFrame('A1\n'))
            safeSend(ws, stdoutFrame('B2\n'))
            setTimeout(() => ws.terminate(), 30)
            return
        }
        if (conns === 2) {
            ws.send(sessionInfoText(sid))
            // full-history replay (deduped by the client) + one live line
            for (const c of ['A1\n', 'B2\n', 'C3\n'])
                safeSend(ws, stdoutFrame(c))
            setTimeout(() => ws.terminate(), 30)
            return
        }
        // third connection: the process exited in the gap and was reaped
        ws.send(JSON.stringify({ error: `session not found: ${sid}` }))
    })
    try {
        const { logger, events } = makeLogger()
        const handle = execSpriteStream(
            fakeClient(server.port),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 30_000,
                maxRunAfterDisconnectSeconds: 60,
                reattach: {}
            },
            logger
        )
        let out = ''
        try {
            for await (const chunk of handle.stdout) out += chunk
        } catch {
            // result carries the terminal error
        }
        const err = await rejectionOf(handle.result)
        assert.equal(out, 'A1\nB2\nC3\n')
        assert.ok(err instanceof SpritesError)
        assert.equal(err.reason, 'exec_session_gone')
        assert.equal(conns, 3)
        assert.ok(events.some((e) => e.msg === 'sprites.exec.reattach.success'))
        assert.ok(events.some((e) => e.msg === 'sprites.exec.reattach.refused'))
    } finally {
        await server.close()
    }
})

test('close telemetry: sprites.exec.close is observable with code/reconnects/connAgeMs', async () => {
    const server = await startServer((ws) => {
        ws.send(sessionInfoText('sess-close'))
        safeSend(ws, stdoutFrame('hi\n'))
        // clean close WITHOUT an exit frame — the close handler logs before it
        // settles (a normal exit settles first and skips the log).
        setTimeout(() => ws.close(1000, 'bye'), 30)
    })
    try {
        const { logger, events } = makeLogger()
        const handle = execSpriteStream(
            fakeClient(server.port),
            'sprite',
            { cmd: ['noop'], timeoutMs: 10_000 },
            logger
        )
        await drain(handle.stdout)
        await rejectionOf(handle.result)
        const close = events.find((e) => e.msg === 'sprites.exec.close')
        assert.ok(close, 'expected a sprites.exec.close event')
        assert.equal(close.level, 'info')
        assert.equal(close.meta?.code, 1000)
        assert.equal(close.meta?.reconnects, 0)
        assert.equal(close.meta?.attach, false)
        assert.equal(typeof close.meta?.connAgeMs, 'number')
        assert.ok(!('reason' in (close.meta ?? {})))
    } finally {
        await server.close()
    }
})

test('reattach: abort during the reconnect wait still kills the remote session', async () => {
    const kills: KillCall[] = []
    const server = await startServer((ws, req) => {
        if ((req.url ?? '').includes('id=')) return
        ws.send(sessionInfoText('sess-r3'))
        setTimeout(() => ws.terminate(), 30)
    })
    try {
        const handle = execSpriteStream(
            fakeClient(server.port, kills),
            'sprite',
            {
                cmd: ['noop'],
                timeoutMs: 10_000,
                maxRunAfterDisconnectSeconds: 60,
                reattach: {}
            }
        )
        handle.result.catch(() => {})
        void drain(handle.stdout)
        await delay(150) // inside the ~500ms first reattach wait
        handle.abort()
        await delay(30)
        assert.equal(kills.length, 1)
        await assert.rejects(handle.result, /aborted/)
    } finally {
        await server.close()
    }
})

test('reattach: attempts exhaust into the plain transient error', async () => {
    let conns = 0
    const server = await startServer((ws, req) => {
        conns += 1
        if ((req.url ?? '').includes('id=')) {
            // accept then immediately drop every attach
            setTimeout(() => ws.terminate(), 10)
            return
        }
        ws.send(sessionInfoText('sess-r4'))
        setTimeout(() => ws.terminate(), 30)
    })
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 30_000,
            maxRunAfterDisconnectSeconds: 60,
            reattach: { maxAttempts: 2 }
        })
        void drain(handle.stdout)
        await assert.rejects(handle.result, /closed without exit code/)
        assert.equal(conns, 3) // original + 2 attach attempts
    } finally {
        await server.close()
    }
})

// A server that rejects the WebSocket upgrade with a non-101 HTTP status,
// simulating a revoked/expired account token on the exec channel (#264). ws
// surfaces this via 'unexpected-response', which must classify from the real
// status instead of the blind 'transient' the generic 'error' path used.
const startRejectingServer = async (
    status: number
): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = createServer((_req, res) => {
        res.statusCode = status
        res.end()
    })
    server.on('upgrade', (_req, socket) => {
        // end(), not write() + destroy(): write() only queues the bytes, and
        // destroy() discards whatever is still queued and sends an RST. On an
        // idle machine the header reaches the kernel first and the client reads
        // the status; on a loaded one it does not, so the client sees
        // ECONNRESET and both handshake tests below fail on the wrong error
        // class — `code: 'transient', status: undefined` ("socket hang up")
        // instead of the classified auth/transient status they assert. That is
        // the whole point of those tests, so the flake inverted their result
        // rather than just delaying it. end() flushes, then FINs.
        socket.end(
            `HTTP/1.1 ${status} Unauthorized\r\n` +
                'Connection: close\r\n' +
                'Content-Length: 0\r\n\r\n'
        )
    })
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
        port,
        close: () =>
            new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

test('handshake: a 401 upgrade response fails with a classified auth error, not transient', async () => {
    const server = await startRejectingServer(401)
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000
        })
        void drain(handle.stdout)
        await assert.rejects(handle.result, (err: unknown) => {
            assert.ok(err instanceof SpritesError, 'expected a SpritesError')
            assert.equal(err.code, 'auth')
            assert.equal(err.status, 401)
            return true
        })
    } finally {
        await server.close()
    }
})

test('handshake: a 502 upgrade response stays transient', async () => {
    const server = await startRejectingServer(502)
    try {
        const handle = execSpriteStream(fakeClient(server.port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000
        })
        void drain(handle.stdout)
        await assert.rejects(handle.result, (err: unknown) => {
            assert.ok(err instanceof SpritesError)
            assert.equal(err.code, 'transient')
            assert.equal(err.status, 502)
            assert.equal(err.execPhase, 'pre_open')
            return true
        })
    } finally {
        await server.close()
    }
})

test('handshake: a 502 upgrade response retries initial connection and succeeds on retry', async () => {
    let attempts = 0
    const server = createServer((_req, res) => {
        res.statusCode = 502
        res.end()
    })
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
        attempts++
        if (attempts === 1) {
            socket.write(
                'HTTP/1.1 502 Bad Gateway\r\n' +
                    'Connection: close\r\n' +
                    'Content-Length: 0\r\n\r\n'
            )
            socket.destroy()
            return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send(sessionInfoText('sess-init-retry'))
            ws.send(exitFrame(0))
        })
    })
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
        const handle = execSpriteStream(fakeClient(port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000,
            initialConnectRetry: {}
        })
        const res = await handle.result
        assert.equal(res.exitCode, 0)
        assert.equal(attempts, 2)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

// Callers that do not opt in keep exactly one upgrade attempt per exec —
// the api's sandbox health probe layers its own retry on top and counts
// upgrades to prove non-idempotent execs are never replayed.
test('handshake: without initialConnectRetry a 502 fails on the first attempt', async () => {
    let attempts = 0
    const server = createServer()
    server.on('upgrade', (_req, socket) => {
        attempts++
        socket.write(
            'HTTP/1.1 502 Bad Gateway\r\n' +
                'Connection: close\r\n' +
                'Content-Length: 0\r\n\r\n'
        )
        socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
        const handle = execSpriteStream(fakeClient(port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000
        })
        await assert.rejects(handle.result, (err: unknown) => {
            assert.ok(err instanceof SpritesError)
            assert.equal(err.code, 'transient')
            assert.equal(err.status, 502)
            return true
        })
        assert.equal(attempts, 1)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

// Unlike a non-101 response (which ws routes to 'unexpected-response' and
// suppresses further events), a socket dropped before any response emits
// 'error' and then a synchronous 'close' — the retry must survive that close.
test('handshake: a transport error retries initial connection and succeeds on retry', async () => {
    let attempts = 0
    const server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
        attempts++
        if (attempts === 1) {
            socket.destroy()
            return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send(sessionInfoText('sess-transport-retry'))
            ws.send(exitFrame(0))
        })
    })
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
        const handle = execSpriteStream(fakeClient(port), 'sprite', {
            cmd: ['noop'],
            timeoutMs: 5_000,
            initialConnectRetry: {}
        })
        const res = await handle.result
        assert.equal(res.exitCode, 0)
        assert.equal(attempts, 2)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

test('transport logs expose the failure class but not the socket exception text', async () => {
    const server = createServer()
    server.on('upgrade', (_req, socket) => socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
        const { logger, events } = makeLogger()
        const handle = execSpriteStream(
            fakeClient(port),
            'sprite',
            { cmd: ['noop'], timeoutMs: 5_000 },
            logger
        )
        await assert.rejects(handle.result)

        const failure = events.find(
            (event) => event.msg === 'sprites.exec.error'
        )
        assert.deepEqual(failure?.meta, { failureClass: 'Error' })
        assert.doesNotMatch(JSON.stringify(events), /socket hang up|ECONNRESET/)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})
