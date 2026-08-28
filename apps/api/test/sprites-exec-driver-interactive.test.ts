import assert from 'node:assert/strict'
import test from 'node:test'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { SpritesClient, SpritesLogger } from '@manyfold/sprites'
import {
    SpritesExecDriver,
    makePushStdin
} from '../src/modules/chat/adapters/sprites-exec-driver'

const noopLogger: SpritesLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
}

interface KillCall {
    spriteName: string
    sessionId: string
}

const fakeClient = (port: number, kills: KillCall[]): SpritesClient =>
    ({
        wsBaseUrl: `ws://127.0.0.1:${port}`,
        authHeaderForInternalUse: () => ({}),
        killExecSession: async (spriteName: string, sessionId: string) => {
            kills.push({ spriteName, sessionId })
        }
    }) as unknown as SpritesClient

interface ServerSession {
    url: string
    ws: WebSocket
    stdin: Buffer[]
    stdinEof: boolean
}

const startServer = async (): Promise<{
    port: number
    sessions: ServerSession[]
    close: () => Promise<void>
}> => {
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    const sessions: ServerSession[] = []
    wss.on('connection', (ws, req: IncomingMessage) => {
        const session: ServerSession = {
            url: req.url ?? '',
            ws,
            stdin: [],
            stdinEof: false
        }
        sessions.push(session)
        ws.on('error', () => {})
        ws.send(
            JSON.stringify({ type: 'session_info', session_id: 'sess-1' })
        )
        ws.on('message', (data, isBinary) => {
            if (!isBinary) return
            const buf = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data as ArrayBuffer)
            if (buf.length === 1 && buf[0] === 0x04) {
                session.stdinEof = true
                // stdio server semantics: exit cleanly on EOF
                ws.send(Buffer.from([0x03, 0]))
                ws.close()
                return
            }
            if (buf[0] === 0x00) {
                const payload = buf.subarray(1)
                session.stdin.push(payload)
                // echo back on stdout to prove full duplex
                ws.send(Buffer.concat([Buffer.from([0x01]), payload]))
            }
        })
    })
    const address = wss.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
        port,
        sessions,
        close: () => new Promise<void>((resolve) => wss.close(() => resolve()))
    }
}

const waitFor = async (
    cond: () => boolean,
    what: string,
    budgetMs = 3_000
): Promise<void> => {
    const start = Date.now()
    while (!cond()) {
        if (Date.now() - start > budgetMs)
            throw new Error(`timed out waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

test('makePushStdin delivers post-start writes in order and ends the iterable', async () => {
    const stdin = makePushStdin()
    const seen: string[] = []
    const consumed = (async () => {
        for await (const chunk of stdin.iterable)
            seen.push(chunk.toString('utf8'))
    })()
    stdin.write(Buffer.from('a'))
    await waitFor(() => seen.length === 1, 'first chunk')
    stdin.write(Buffer.from('b'))
    stdin.write(Buffer.from('c'))
    await waitFor(() => seen.length === 3, 'queued chunks')
    stdin.end()
    await consumed
    assert.deepEqual(seen, ['a', 'b', 'c'])
    stdin.write(Buffer.from('dropped'))
    assert.deepEqual(seen, ['a', 'b', 'c'])
})

test('streamInteractive drives stdin after start and completes on EOF exit', async () => {
    const server = await startServer()
    const kills: KillCall[] = []
    try {
        const driver = new SpritesExecDriver(
            fakeClient(server.port, kills),
            'sprite-1',
            noopLogger
        )
        let sessionId: string | null = null
        const handle = driver.streamInteractive({
            cmd: ['hermes', 'acp', '--accept-hooks'],
            env: { HERMES_YOLO_MODE: '1' },
            timeoutMs: 10_000,
            onExecSession: (id) => {
                sessionId = id
            }
        })

        let echoed = ''
        const stdoutDone = (async () => {
            for await (const chunk of handle.stdout) echoed += chunk
        })()

        await waitFor(() => server.sessions.length === 1, 'connection')
        const session = server.sessions[0]
        // kill-on-abort opt-in rides the URL; open stdin means no reattach
        assert.match(session.url, /max_run_after_disconnect=10/)

        handle.write(Buffer.from('{"jsonrpc":"2.0","id":1}\n'))
        await waitFor(() => session.stdin.length === 1, 'first stdin frame')
        handle.write(Buffer.from('second\n'))
        await waitFor(() => session.stdin.length === 2, 'second stdin frame')
        assert.equal(
            Buffer.concat(session.stdin).toString('utf8'),
            '{"jsonrpc":"2.0","id":1}\nsecond\n'
        )
        assert.equal(session.stdinEof, false)

        handle.endInput()
        const result = await handle.result
        assert.equal(result.exitCode, 0)
        await stdoutDone
        assert.equal(echoed, '{"jsonrpc":"2.0","id":1}\nsecond\n')
        assert.equal(session.stdinEof, true)
        assert.equal(sessionId, 'sess-1')
        assert.equal(kills.length, 0)
    } finally {
        await server.close()
    }
})

test('streamInteractive abort kills the exec session and rejects the result', async () => {
    const server = await startServer()
    const kills: KillCall[] = []
    try {
        const driver = new SpritesExecDriver(
            fakeClient(server.port, kills),
            'sprite-1',
            noopLogger
        )
        const handle = driver.streamInteractive({
            cmd: ['hermes', 'acp', '--accept-hooks'],
            timeoutMs: 10_000
        })
        const rejected = assert.rejects(handle.result)
        await waitFor(() => server.sessions.length === 1, 'connection')
        handle.abort()
        await rejected
        await waitFor(() => kills.length === 1, 'REST kill call')
        assert.deepEqual(kills[0], {
            spriteName: 'sprite-1',
            sessionId: 'sess-1'
        })
    } finally {
        await server.close()
    }
})
