import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    truncate,
    writeFile
} from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderError } from 'commander'
import type { ChatSessionSummary, ChatToolCallEvent } from '@manyfold/shared'
import { ApiError } from '@manyfold/sdk'
import { json, runMf, type Route, type Run } from './fixtures/fake-api'
import {
    chatEvent,
    sse,
    sseFrame,
    type StreamEvent
} from './fixtures/chat-stream'
import { spawnMf } from './fixtures/spawn-mf'
import {
    humanView,
    latestSession,
    readMessage,
    type TurnOutcome
} from '../src/commands/agent/chat-turn'
import { normalizeCliError } from '../src/output'
import { UsageError } from '../src/usage-error'

// `mf agent send`: a message to an agent and its reply, read off the
// session's stream, against a fake API.

const usage = {
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 10,
    outputTokens: 122,
    cacheReadTokens: 0,
    cacheCreationTokens: 29593,
    costUsd: 0.0376,
    costSource: 'table',
    firstTokenMs: 900,
    totalMs: 3100
}

const reply: StreamEvent[] = [
    chatEvent('token', 1, { text: 'Hel' }),
    // Another turn of the same session: not this one's.
    chatEvent('token', 2, { messageId: 'msg_other', text: 'NOPE' }),
    chatEvent('tool_call', 3, {
        toolCallId: 't1',
        toolName: 'Read',
        args: { file_path: 'src/x.ts' }
    }),
    chatEvent('token', 4, { text: 'lo' }),
    chatEvent('usage', 5, { usage }),
    chatEvent('done', 6, { finalMessageId: 'msg_a' })
]

const session = (
    id: string,
    over: Partial<ChatSessionSummary> = {}
): ChatSessionSummary =>
    ({
        id,
        agentId: 'agt_1',
        title: null,
        frameworkSessionRef: null,
        channel: null,
        holderTerminalId: null,
        holderAcquiredAt: null,
        holderClient: null,
        importPendingSince: null,
        origin: null,
        createdAt: '2026-09-29T10:00:00.000Z',
        updatedAt: '2026-09-29T10:00:00.000Z',
        ...over
    }) as ChatSessionSummary

// A session cts_1 created on request, whose turn msg_a streams `events`
// (one list per connection).
const routes = (
    events: StreamEvent[][] = [reply],
    over: Record<string, Route> = {}
): Record<string, Route> => ({
    'POST /agents/agt_1/sessions': () => json(session('cts_1'), 201),
    'POST /agents/agt_1/sessions/cts_1/messages': () =>
        json(
            { userMessage: { id: 'msg_u' }, assistantMessageId: 'msg_a' },
            201
        ),
    'GET /agents/agt_1/sessions/cts_1/stream': (_call, index) =>
        sse(events[Math.min(index, events.length - 1)]),
    'DELETE /agents/agt_1/sessions/cts_1': () =>
        new Response(null, { status: 204 }),
    'GET /config/capabilities': () =>
        json({ branding: { webBaseUrl: 'https://app.test' } }),
    ...over
})

const posts = (run: Run) =>
    run.calls.filter(
        (call) => call.method === 'POST' && call.path.endsWith('/messages')
    )

const usageError = (run: Run): string => {
    assert.ok(
        run.error instanceof CommanderError,
        `expected a usage error, got ${String(run.error)}`
    )
    return run.error.message
}

test('a message starts a session, and the reply is read off its stream', async () => {
    const listeners = process.listenerCount('SIGINT')
    const run = await runMf(
        ['agent', 'send', 'agt_1', 'hello', 'there'],
        routes()
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.equal(run.exitCode, 0)
    // Only the text: the agent's saved model and permission settings apply.
    assert.deepEqual(posts(run)[0].body, { text: 'hello there' })
    const stream = run.calls.find((call) => call.path.endsWith('/stream'))
    assert.equal(stream?.query.get('replayMessageId'), 'msg_a')
    // Not a terminal: the answer once, whole, on stdout.
    assert.deepEqual(run.out, ['Hello'])
    const err = run.err.join('\n')
    assert.match(err, /→ Read src\/x\.ts/)
    assert.match(
        err,
        /claude-haiku-4-5-20251001 · 10 in \/ 29\.6k cache \/ 122 out · \$0\.0376 · \d+\.\d s/
    )
    assert.match(
        err,
        /session cts_1 · continue: mf agent send agt_1 --session cts_1 "…"/
    )
    assert.equal(process.listenerCount('SIGINT'), listeners)
})

test('usage the stream does not carry is read off the finished message', async () => {
    const run = await runMf(
        ['agent', 'send', 'agt_1', 'hi', '--json'],
        routes(
            [
                [
                    chatEvent('token', 1, { text: 'pong' }),
                    chatEvent('done', 2, { finalMessageId: 'msg_a' })
                ]
            ],
            {
                'GET /agents/agt_1/sessions/cts_1/messages': (call) => {
                    assert.equal(call.query.get('limit'), '2')
                    return json({
                        messages: [
                            { id: 'msg_u', role: 'user' },
                            { id: 'msg_a', role: 'assistant', usage }
                        ],
                        hasMore: false,
                        nextBefore: null
                    })
                }
            }
        )
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(JSON.parse(run.out.join('\n')).usage, usage)
})

test('an answer the agent rewrote is printed as rewritten', async () => {
    const run = await runMf(
        ['agent', 'send', 'agt_1', 'hi'],
        routes([
            [
                chatEvent('token', 1, { text: 'draft' }),
                chatEvent('replace', 2, { text: 'final answer', reason: 'x' }),
                chatEvent('done', 3, { finalMessageId: 'msg_a' })
            ]
        ])
    )
    assert.deepEqual(run.out, ['final answer'])
})

test('--json prints one object for the turn', async () => {
    const run = await runMf(
        ['agent', 'send', 'agt_1', 'hi', '--json'],
        routes()
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(JSON.parse(run.out.join('\n')), {
        sessionId: 'cts_1',
        userMessageId: 'msg_u',
        assistantMessageId: 'msg_a',
        text: 'Hello',
        usage,
        error: null
    })
    assert.doesNotMatch(run.err.join('\n'), /→ Read/)
})

test('--session continues that session, and -c the one last active', async () => {
    const given = await runMf(
        ['agent', 'send', 'agt_1', 'again', '--session', 'cts_9', '--json'],
        routes([reply], {
            'POST /agents/agt_1/sessions/cts_9/messages': () =>
                json(
                    {
                        userMessage: { id: 'msg_u' },
                        assistantMessageId: 'msg_a'
                    },
                    201
                ),
            'GET /agents/agt_1/sessions/cts_9/stream': () =>
                sse(reply.map((event) => ({ ...event, sessionId: 'cts_9' })))
        })
    )
    assert.equal(given.error, undefined, String(given.error))
    assert.equal(
        given.calls.some((call) => call.path === '/agents/agt_1/sessions'),
        false
    )
    assert.equal(posts(given)[0].path, '/agents/agt_1/sessions/cts_9/messages')

    // Listed oldest first by creation; the channel's session is newer still.
    const listed = [
        session('cts_new', {
            createdAt: '2026-09-29T09:00:00.000Z',
            updatedAt: '2026-09-29T12:00:00.000Z'
        }),
        session('cts_1', {
            createdAt: '2026-09-29T10:00:00.000Z',
            updatedAt: '2026-09-29T11:00:00.000Z'
        }),
        session('cts_tg', {
            createdAt: '2026-09-29T11:00:00.000Z',
            updatedAt: '2026-09-29T13:00:00.000Z',
            channel: { id: 'chn_1' } as ChatSessionSummary['channel']
        })
    ]
    assert.equal(latestSession(listed)?.id, 'cts_new')
    const cont = await runMf(
        ['agent', 'send', 'agt_1', 'again', '-c', '--json'],
        routes([reply], {
            'GET /agents/agt_1/sessions': () => json(listed.slice(1))
        })
    )
    assert.equal(cont.error, undefined, String(cont.error))
    assert.equal(posts(cont)[0].path, '/agents/agt_1/sessions/cts_1/messages')

    const both = await runMf(
        ['agent', 'send', 'agt_1', 'x', '-c', '--session', 'cts_1'],
        routes()
    )
    assert.match(usageError(both), /--session and --continue both pick/)
    assert.deepEqual(both.calls, [])
})

test('a turn that fails exits 1 with its error', async () => {
    const failing = [
        chatEvent('token', 1, { text: 'x' }),
        chatEvent('error', 2, {
            error: {
                code: 'invalid_request',
                message: 'API Error: 400 bad request',
                retryable: false
            }
        })
    ]
    const human = await runMf(
        ['agent', 'send', 'agt_1', 'hi'],
        routes([failing])
    )
    assert.equal(human.exitCode, 1)
    assert.deepEqual(human.out, [])
    assert.match(human.err.join('\n'), /error: API Error: 400 bad request/)
    const scripted = await runMf(
        ['agent', 'send', 'agt_1', 'hi', '--json'],
        routes([failing])
    )
    assert.equal(scripted.exitCode, 1)
    assert.equal(
        JSON.parse(scripted.out.join('\n')).error.code,
        'invalid_request'
    )
})

test('a stream that drops is picked up after the last event it gave', async () => {
    const run = await runMf(
        ['agent', 'send', 'agt_1', 'hi'],
        routes([
            [chatEvent('token', 5, { text: 'Hel' })],
            [
                chatEvent('token', 6, { text: 'lo' }),
                chatEvent('done', 7, { finalMessageId: 'msg_a' })
            ]
        ])
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, ['Hello'])
    const streams = run.calls.filter((call) => call.path.endsWith('/stream'))
    assert.equal(streams.length, 2)
    assert.equal(streams[1].query.get('lastEventId'), '5')
    assert.equal(streams[1].headers.get('last-event-id'), '5')
    assert.match(run.err.join('\n'), /reconnecting \(1\/5\)/)
})

test('a session busy with another turn gets a hint, and the new empty session goes', async () => {
    const busy = await runMf(
        ['agent', 'send', 'agt_1', 'hi'],
        routes([reply], {
            'POST /agents/agt_1/sessions/cts_1/messages': () =>
                json(
                    {
                        // What the API sends for a ConflictException
                        // without a code.
                        error: {
                            code: 'bad_request',
                            message: 'session has an active assistant turn'
                        }
                    },
                    409
                )
        })
    )
    assert.equal(busy.exitCode, 1)
    assert.match(busy.err.join('\n'), /A turn is still running in this session/)
    assert.ok(
        busy.calls.some(
            (call) =>
                call.method === 'DELETE' &&
                call.path === '/agents/agt_1/sessions/cts_1'
        )
    )
    const held = await runMf(
        ['agent', 'send', 'agt_1', 'hi', '--session', 'cts_1'],
        routes([reply], {
            'POST /agents/agt_1/sessions/cts_1/messages': () =>
                json(
                    {
                        error: {
                            code: 'session_held_by_terminal',
                            message: 'session is open in a terminal'
                        }
                    },
                    409
                )
        })
    )
    // Left to the top-level handler, which renders the code's hint.
    assert.ok(held.error instanceof ApiError, String(held.error))
    assert.match(
        normalizeCliError(held.error).error.hint ?? '',
        /open in a terminal: close it there/
    )
    // Not ours to delete.
    assert.equal(
        held.calls.some((call) => call.method === 'DELETE'),
        false
    )
})

test('--file uploads each file next to the session and attaches it', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-send-file-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const shot = join(dir, 'shot.png')
    await writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const run = await runMf(
        ['agent', 'send', 'agt_1', 'what is in it?', '--file', shot],
        routes([reply], {
            'GET /agents/agt_1': () =>
                json({
                    id: 'agt_1',
                    name: 'demo',
                    framework: 'claude-code',
                    runtime: 'sprites'
                }),
            'PUT /agents/agt_1/files/write': () => json({ ok: true })
        })
    )
    assert.equal(run.error, undefined, String(run.error))
    const put = run.calls.find((call) => call.method === 'PUT')
    const path = put?.query.get('path') ?? ''
    assert.match(path, /^chat-attachments\/cts_1\/[0-9a-f-]{36}\/shot\.png$/)
    assert.equal(put?.query.get('rootId'), 'workspace')
    assert.deepEqual(put?.body, await readFile(shot))
    assert.deepEqual(posts(run)[0].body, {
        text: 'what is in it?',
        attachments: [{ path, rootId: 'workspace', name: 'shot.png', size: 7 }]
    })
})

// Seen on a local stack [2026-09-30]: the upload of an attachment to a
// sandbox on CLI 4.8.0 was given the "a turn is still running" hint.
test("an upload the sandbox's CLI is too old for keeps its own hint", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-send-old-cli-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'app.log')
    await writeFile(file, 'ERROR disk full\n')
    const run = await runMf(
        ['agent', 'send', 'agt_1', 'read it', '--file', file],
        routes([reply], {
            'GET /agents/agt_1': () =>
                json({
                    id: 'agt_1',
                    name: 'demo',
                    framework: 'claude-code',
                    runtime: 'sprites'
                }),
            'PUT /agents/agt_1/files/write': () =>
                json(
                    {
                        error: {
                            code: 'SANDBOX_CLI_TOO_OLD',
                            message:
                                'sandbox-001 already runs the latest Manyfold CLI (4.8.0), which does not support this yet',
                            details: {
                                hostId: 'sbx_1',
                                hostName: 'sandbox-001',
                                cliVersion: '4.8.0',
                                latestCliVersion: '4.8.0'
                            }
                        }
                    },
                    409
                )
        })
    )
    assert.ok(run.error instanceof ApiError, String(run.error))
    assert.match(
        normalizeCliError(run.error).error.hint ?? '',
        /mf sandbox update sandbox-001/
    )
    assert.equal(posts(run).length, 0)
    // The session this run started for it is not left empty behind.
    assert.ok(
        run.calls.some(
            (call) =>
                call.method === 'DELETE' &&
                call.path === '/agents/agt_1/sessions/cts_1'
        )
    )
})

test('files that cannot go are refused before anything is sent', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-send-refuse-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const small = join(dir, 'a.txt')
    await writeFile(small, 'a')
    const big = join(dir, 'big.bin')
    await writeFile(big, '')
    await truncate(big, 26 * 1024 * 1024)
    await mkdir(join(dir, 'sub'))
    const cases: Array<[string[], RegExp]> = [
        [['--file', join(dir, 'missing.txt')], /no such file/],
        [['--file', join(dir, 'sub')], /is not a file/],
        [['--file', big], /at most 25 MiB/],
        [
            Array.from({ length: 11 }, () => ['--file', small]).flat(),
            /11 files; one message takes at most 10/
        ]
    ]
    for (const [flags, message] of cases) {
        const run = await runMf(
            ['agent', 'send', 'agt_1', 'x', ...flags],
            routes()
        )
        assert.match(usageError(run), message)
        assert.deepEqual(run.calls, [], flags.join(' '))
    }
    const external = await runMf(
        ['agent', 'send', 'agt_1', 'x', '--file', small],
        routes([reply], {
            'GET /agents/agt_1': () =>
                json({
                    id: 'agt_1',
                    name: 'flow',
                    framework: 'langflow',
                    runtime: 'external'
                })
        })
    )
    assert.match(usageError(external), /has no workspace to put files in/)
    assert.deepEqual(
        external.calls.map((call) => `${call.method} ${call.path}`),
        ['GET /agents/agt_1']
    )
})

test('a permission request says where to answer it, and the turn waits', async () => {
    const run = await runMf(
        ['agent', 'send', 'agt_1', 'hi'],
        routes([
            [
                chatEvent('permission_request', 1, {
                    requestId: 'req_1',
                    toolCallId: null,
                    title: 'Run rm -rf build?',
                    detail: null,
                    options: []
                }),
                chatEvent('token', 2, { text: 'done it' }),
                chatEvent('done', 3, { finalMessageId: 'msg_a' })
            ]
        ])
    )
    assert.equal(run.error, undefined, String(run.error))
    const err = run.err.join('\n')
    assert.match(err, /The agent asks: Run rm -rf build\?/)
    assert.match(
        err,
        /Answer it in the web chat: https:\/\/app\.test\/agents\/agt_1\/chat\?sessionId=cts_1/
    )
    assert.deepEqual(run.out, ['done it'])
})

test('the message comes from the arguments or from stdin', () => {
    const tty = { isTTY: true, read: () => assert.fail('read stdin') }
    assert.equal(readMessage(['a', 'b'], tty), 'a b')
    assert.equal(
        readMessage(['-'], { isTTY: false, read: () => 'piped\n' }),
        'piped'
    )
    assert.equal(
        readMessage([], { isTTY: false, read: () => 'line 1\nline 2\n' }),
        'line 1\nline 2'
    )
    assert.throws(() => readMessage(['-'], tty), UsageError)
    assert.throws(() => readMessage(['x'.repeat(32_001)], tty), /at most 32000/)
})

// A server for the child process: the session, its message, and a stream
// that stays open for the test to steer.
const chatServer = async () => {
    const seen: string[] = []
    let stream: ServerResponse | null = null
    let body = ''
    const opened: { resolve: () => void; promise: Promise<void> } = (() => {
        let resolve = () => {}
        const promise = new Promise<void>((done) => (resolve = done))
        return { resolve, promise }
    })()
    let onCancel: (res: ServerResponse) => void = (res) => {
        res.writeHead(204).end()
        stream?.end(
            sseFrame(
                chatEvent('error', 3, {
                    error: {
                        code: 'cancelled_by_user',
                        message: 'stopped',
                        retryable: false
                    }
                })
            )
        )
    }
    const server = createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://x')
            seen.push(`${req.method} ${url.pathname}${url.search}`)
            if (url.pathname.endsWith('/sessions') && req.method === 'POST') {
                res.writeHead(201, { 'content-type': 'application/json' })
                res.end(JSON.stringify(session('cts_1')))
            } else if (
                url.pathname.endsWith('/messages') &&
                req.method === 'POST'
            ) {
                body = raw
                res.writeHead(201, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        userMessage: { id: 'msg_u' },
                        assistantMessageId: 'msg_a'
                    })
                )
            } else if (url.pathname.endsWith('/stream')) {
                stream = res
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                res.write(sseFrame(chatEvent('token', 1, { text: 'thinking' })))
                opened.resolve()
            } else if (url.pathname.endsWith('/cancel')) onCancel(res)
            else res.writeHead(404).end()
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    return {
        port: (server.address() as AddressInfo).port,
        seen,
        body: () => body,
        opened: opened.promise,
        holdCancel: () => {
            onCancel = () => undefined
        },
        close: () => {
            server.closeAllConnections()
            server.close()
        }
    }
}

const sendInChild = async (
    t: { after: (fn: () => unknown) => void },
    server: Awaited<ReturnType<typeof chatServer>>
) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-send-child-'))
    t.after(async () => {
        server.close()
        await rm(dir, { recursive: true, force: true })
    })
    const child = spawnMf(
        [
            '--api-url',
            `http://127.0.0.1:${server.port}/api`,
            'agent',
            'send',
            'agt_1',
            '-'
        ],
        { HOME: dir, MF_CONFIG_DIR: dir, MF_API_TOKEN: 'nca_rt_env' }
    )
    child.stdin.end('from a pipe\n')
    let stderr = ''
    child.stderr.on('data', (data) => (stderr += data))
    const closed = once(child, 'close')
    await Promise.race([
        server.opened,
        closed.then(() => {
            throw new Error(`mf exited before the stream opened: ${stderr}`)
        })
    ])
    return { child, closed, stderr: () => stderr }
}

test(
    'Ctrl-C stops the turn on the server and exits 130; the message came from stdin',
    { timeout: 60_000 },
    async (t) => {
        const server = await chatServer()
        const { child, closed, stderr } = await sendInChild(t, server)
        child.kill('SIGINT')
        const [code] = await closed
        assert.equal(code, 130, stderr())
        assert.deepEqual(JSON.parse(server.body()), { text: 'from a pipe' })
        assert.ok(
            server.seen.includes(
                'POST /api/agents/agt_1/sessions/cts_1/cancel?assistantMessageId=msg_a'
            ),
            server.seen.join('\n')
        )
        assert.match(stderr(), /stopping the turn/)
    }
)

test(
    'a second Ctrl-C leaves at once, while the stop is still pending',
    { timeout: 60_000 },
    async (t) => {
        const server = await chatServer()
        server.holdCancel()
        const { child, closed, stderr } = await sendInChild(t, server)
        child.kill('SIGINT')
        await new Promise((done) => setTimeout(done, 500))
        const second = Date.now()
        child.kill('SIGINT')
        const [code] = await closed
        assert.equal(code, 130, stderr())
        assert.ok(Date.now() - second < 5_000)
    }
)

// What the view writes, raw streams and console alike, while `fn` runs.
const captured = async (
    fn: () => void | Promise<void>
): Promise<{ out: string; err: string }> => {
    const out: string[] = []
    const err: string[] = []
    const saved = {
        out: process.stdout.write,
        err: process.stderr.write,
        log: console.log,
        error: console.error
    }
    process.stdout.write = ((chunk: string) =>
        out.push(String(chunk)) > 0) as typeof process.stdout.write
    process.stderr.write = ((chunk: string) =>
        err.push(String(chunk)) > 0) as typeof process.stderr.write
    console.log = (...values: unknown[]) => {
        out.push(`${values.join(' ')}\n`)
    }
    console.error = (...values: unknown[]) => {
        err.push(`${values.join(' ')}\n`)
    }
    try {
        await fn()
    } finally {
        process.stdout.write = saved.out
        process.stderr.write = saved.err
        console.log = saved.log
        console.error = saved.error
    }
    return { out: out.join(''), err: err.join('') }
}

const answered = { text: 'Answer', error: null } as TurnOutcome
const readTool = {
    toolName: 'Read',
    args: { file_path: 'a.ts' }
} as ChatToolCallEvent

test('--show-thinking streams the thinking to stderr, each run on lines of its own', async () => {
    const onTerminal = await captured(() => {
        const view = humanView({
            stream: true,
            showThinking: true,
            chatLink: async () => null
        })
        view.thinking('Let me ')
        view.thinking('check.')
        view.text('Ans')
        view.text('wer')
        view.thinking('Double-check.')
        view.toolCall(readTool)
        view.finish(answered)
    })
    assert.equal(onTerminal.out, 'Answer\n')
    assert.equal(onTerminal.err, 'Let me check.\nDouble-check.\n→ Read a.ts\n')
    // Piped, the answer comes whole at the end; the thinking still streams.
    const piped = await captured(() => {
        const view = humanView({
            stream: false,
            showThinking: true,
            chatLink: async () => null
        })
        view.thinking('Let me check.')
        view.text('Answer')
        view.finish(answered)
    })
    assert.equal(piped.err, 'Let me check.\n')
    assert.equal(piped.out, 'Answer\n')
    const quiet = await captured(() => {
        const view = humanView({ stream: true, chatLink: async () => null })
        view.thinking('Let me check.')
        view.text('Answer')
        view.finish(answered)
    })
    assert.equal(quiet.err, '')
})

test('--json carries the thinking only when asked for it', async () => {
    const thought = [
        chatEvent('thinking', 1, { text: 'Let me ' }),
        chatEvent('thinking', 2, { text: 'check.' }),
        chatEvent('token', 3, { text: 'pong' }),
        chatEvent('usage', 4, { usage }),
        chatEvent('done', 5, { finalMessageId: 'msg_a' })
    ]
    const asked = await runMf(
        ['agent', 'send', 'agt_1', 'hi', '--json', '--show-thinking'],
        routes([thought])
    )
    assert.equal(asked.error, undefined, String(asked.error))
    assert.equal(JSON.parse(asked.out.join('\n')).thinking, 'Let me check.')
    const plain = await runMf(
        ['agent', 'send', 'agt_1', 'hi', '--json'],
        routes([thought])
    )
    assert.equal('thinking' in JSON.parse(plain.out.join('\n')), false)
})
