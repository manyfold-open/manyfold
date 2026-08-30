import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError } from '@manyfold/sprites'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import type { ExecDriver } from '../src/modules/chat/adapters/exec-driver'

const userMessage: ChatMessage = {
    id: 'msg-user',
    sessionId: 'session-1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hello' }],
    createdAt: new Date().toISOString()
}

const baseCtx: ApiChatAdapterContext = {
    userId: 'user-1',
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    sessionId: 'session-1',
    messageId: 'msg-assistant',
    framework: 'claude-code',
    runtimeKind: 'sprites',
    model: null,
    modelOverride: null,
    modelConfig: null,
    claudeCodePermissionMode: null,
    codexPermissionMode: null,
    hermesPermissionMode: null,
    frameworkSessionRef: null,
    history: []
}

const creds = {
    anthropicAuthToken: 'token',
    anthropicBaseUrl: 'https://api.example.test'
}

const goneError = (): SpritesError =>
    new SpritesError(
        'transient',
        'execSpriteStream attach failed: session not found: s1',
        undefined,
        undefined,
        { reason: 'exec_session_gone', execSessionId: 's1' }
    )

const chunks = async function* (...values: string[]): AsyncIterable<string> {
    for (const value of values) yield value
}

const throwingChunks = (
    lines: string[],
    error: Error
): AsyncIterable<string> =>
    (async function* () {
        for (const line of lines) yield `${line}\n`
        throw error
    })()

const collect = async (
    events: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const event of events) out.push(event)
    return out
}

interface FactoryOpts {
    stdoutLines: string[]
    error?: Error
    runtime?: 'sprites' | 'daemon'
    diskText?: string | null
    locateNull?: boolean
    fsThrows?: boolean
}

const makeFactory = (opts: FactoryOpts) => {
    const state = { recoveryFsCalls: 0, sessionRefWrites: [] as string[] }
    const error = opts.error
    const driver: ExecDriver = {
        stream: () => {
            const result = error
                ? Promise.reject(error)
                : Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
            result.catch(() => {})
            return {
                stdout: error
                    ? throwingChunks(opts.stdoutLines, error)
                    : chunks(...opts.stdoutLines.map((l) => `${l}\n`)),
                stderr: chunks(''),
                result,
                abort: () => {}
            }
        }
    }
    const drivers = {
        forAgent: async () => ({
            driver,
            creds,
            runtime: opts.runtime ?? 'sprites',
            agent: { workspacePath: '/workspace', daemonId: null }
        }),
        recoveryFsForAgent: async () => {
            state.recoveryFsCalls += 1
            if (opts.fsThrows) throw new Error('recoveryFs unavailable')
            return {
                fs: {
                    locate: async () =>
                        opts.locateNull ? null : '/home/sprite/s.jsonl',
                    listFiles: async () => [],
                    readFile: async () => opts.diskText ?? null,
                    readBinary: async () => null
                },
                runtime: 'sprites',
                agent: {}
            }
        }
    }
    const chatRepo = {
        updateFrameworkSessionRef: async (_id: string, ref: string | null) => {
            if (ref) state.sessionRefWrites.push(ref)
        }
    } as never
    return { drivers, chatRepo, state }
}

const adminSettings = (partialStream = false) =>
    ({
        isFeatureEnabled: async (key: string) =>
            partialStream && key === 'claude_partial_stream',
        getCachedChatExecTimeoutMs: async () => ({
            keepAliveMs: 20_000,
            livenessTimeoutMs: 75_000,
            timeoutMs: 7_200_000
        })
    }) as never

const makeTelemetry = () => {
    const events: { name: string; attrs: Record<string, unknown> }[] = []
    return {
        telemetry: {
            event: (name: string, attrs: Record<string, unknown>) =>
                events.push({ name, attrs }),
            error: () => {}
        } as never,
        events
    }
}

const line = (o: unknown): string => JSON.stringify(o)

// stream-json stdout builders (what the live adapter consumes)
const sysStdout = (uuid = 'sys'): string =>
    line({ type: 'system', subtype: 'init', session_id: 'sess-1', uuid })
const asstStdout = (uuid: string, id: string, content: unknown): string =>
    line({
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        uuid,
        message: { id, content }
    })
const resultStdout = (): string =>
    line({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sess-1',
        uuid: 'res',
        usage: { input_tokens: 3, output_tokens: 4 },
        total_cost_usd: 0.02
    })

// on-disk transcript builders
const diskUser = (uuid: string, text: string): string =>
    line({
        uuid,
        parentUuid: null,
        sessionId: 'sess-1',
        type: 'user',
        timestamp: '2026-07-10T00:00:00.000Z',
        message: { role: 'user', content: text }
    })
const diskAsst = (o: {
    uuid: string
    id: string
    stop: string
    content: unknown
    model?: string
    usage?: Record<string, number>
}): string =>
    line({
        uuid: o.uuid,
        parentUuid: null,
        sessionId: 'sess-1',
        type: 'assistant',
        timestamp: '2026-07-10T00:00:01.000Z',
        message: {
            role: 'assistant',
            id: o.id,
            model: o.model ?? 'claude-x',
            stop_reason: o.stop,
            usage: o.usage ?? { input_tokens: 10, output_tokens: 20 },
            content: o.content
        }
    })
const diskToolResult = (uuid: string, toolUseId: string, out: string): string =>
    line({
        uuid,
        parentUuid: null,
        sessionId: 'sess-1',
        type: 'user',
        timestamp: '2026-07-10T00:00:02.000Z',
        message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUseId, content: out }]
        }
    })

const tokenText = (events: EmittedChatEvent[]): string =>
    events
        .filter((e): e is { type: 'token'; text: string } => e.type === 'token')
        .map((e) => e.text)
        .join('')

const errors = (events: EmittedChatEvent[]) =>
    events.filter((e) => e.type === 'error')

const recoveredRawSources = (events: EmittedChatEvent[]) =>
    events.filter(
        (e) =>
            e.type === 'raw_source' &&
            e.source.parserName === 'claude-code-session-jsonl'
    )

test('recovery completes the turn instead of CLAUDE_EXEC_FAILED when the JSONL is terminal', async () => {
    const diskText = [
        diskUser('up', 'hello'),
        diskAsst({ uuid: 'a1', id: 'm1', stop: 'tool_use', content: [{ type: 'text', text: 'part one' }] }),
        diskAsst({ uuid: 'a1b', id: 'm1', stop: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } }] }),
        diskToolResult('tr', 'tu_1', 'file.txt'),
        diskAsst({ uuid: 'b1', id: 'm2', stop: 'end_turn', content: [{ type: 'text', text: 'final answer' }] })
    ].join('\n')
    const f = makeFactory({
        // live stream showed system + first assistant text line, then dropped
        stdoutLines: [sysStdout(), asstStdout('a1', 'm1', [{ type: 'text', text: 'part one' }])],
        error: goneError(),
        diskText
    })
    const { telemetry, events: tel } = makeTelemetry()
    const adapter = new ClaudeCodeAdapter(
        f.drivers as never,
        f.chatRepo,
        adminSettings(),
        telemetry
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    assert.equal(errors(events).length, 0)
    assert.ok(events.some((e) => e.type === 'done'))
    assert.ok(events.some((e) => e.type === 'usage'))
    // 'part one' streamed live once, recovered tail adds the rest exactly once
    assert.equal(tokenText(events), 'part onefinal answer')
    // recovered raw_sources cover only the 3 unseen disk lines (a1 excluded)
    assert.equal(recoveredRawSources(events).length, 3)
    assert.ok(f.state.sessionRefWrites.includes('sess-1'))
    assert.ok(
        tel.some(
            (e) => e.name === 'chat.exec.recovery' && e.attrs.outcome === 'recovered'
        )
    )
})

test('exactly-once: an already-streamed line is not re-emitted from disk', async () => {
    const diskText = [
        diskUser('up', 'hello'),
        diskAsst({ uuid: 'a1', id: 'm1', stop: 'tool_use', content: [{ type: 'text', text: 'part one' }] }),
        diskAsst({ uuid: 'b1', id: 'm2', stop: 'end_turn', content: [{ type: 'text', text: 'final answer' }] })
    ].join('\n')
    const f = makeFactory({
        stdoutLines: [sysStdout(), asstStdout('a1', 'm1', [{ type: 'text', text: 'part one' }])],
        error: goneError(),
        diskText
    })
    const adapter = new ClaudeCodeAdapter(f.drivers as never, f.chatRepo, adminSettings())

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    // exactly one 'part one' (live only); recovered rows never include a1
    const partOnes = events.filter(
        (e) => e.type === 'token' && e.text === 'part one'
    )
    assert.equal(partOnes.length, 1)
    const recoveredIds = recoveredRawSources(events).map(
        (e) => e.type === 'raw_source' && e.source.externalId
    )
    assert.ok(!recoveredIds.includes('a1'))
    assert.deepEqual(recoveredIds, ['b1'])
})

test('delta prefix: recovery emits only the tail beyond streamed partial deltas', async () => {
    // partial-stream on: stream 'Hello wor' as deltas + a block_stop, then drop
    const streamEvent = (delta: Record<string, unknown>): string =>
        line({
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta },
            parent_tool_use_id: null,
            session_id: 'sess-1'
        })
    const blockStop = (): string =>
        line({
            type: 'stream_event',
            event: { type: 'content_block_stop', index: 0 },
            parent_tool_use_id: null,
            session_id: 'sess-1'
        })
    const diskText = [
        diskUser('up', 'hello'),
        diskAsst({ uuid: 'a1', id: 'm1', stop: 'end_turn', content: [{ type: 'text', text: 'Hello world!' }] })
    ].join('\n')
    const f = makeFactory({
        stdoutLines: [
            sysStdout(),
            streamEvent({ type: 'text_delta', text: 'Hello wor' }),
            blockStop()
        ],
        error: goneError(),
        diskText
    })
    const adapter = new ClaudeCodeAdapter(
        f.drivers as never,
        f.chatRepo,
        adminSettings(true)
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    assert.equal(errors(events).length, 0)
    // streamed 'Hello wor' + recovered remainder 'ld!' → full text once
    assert.equal(tokenText(events), 'Hello world!')
    assert.ok(events.some((e) => e.type === 'done'))
})

test('result-lost: a non-terminal JSONL keeps partial content and emits sprite_exec_result_lost', async () => {
    const diskText = [
        diskUser('up', 'hello'),
        diskAsst({ uuid: 'a1', id: 'm1', stop: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] })
    ].join('\n')
    const f = makeFactory({
        stdoutLines: [sysStdout()],
        error: goneError(),
        diskText
    })
    const { telemetry, events: tel } = makeTelemetry()
    const adapter = new ClaudeCodeAdapter(
        f.drivers as never,
        f.chatRepo,
        adminSettings(),
        telemetry
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    const errs = errors(events)
    assert.equal(errs.length, 1)
    assert.equal(errs[0].type === 'error' && errs[0].error.code, 'sprite_exec_result_lost')
    assert.equal(errs[0].type === 'error' && errs[0].error.retryable, true)
    // partial content (the dangling tool_call) preserved; no usage, no done
    assert.ok(events.some((e) => e.type === 'tool_call'))
    assert.ok(!events.some((e) => e.type === 'usage'))
    assert.ok(!events.some((e) => e.type === 'done'))
    assert.ok(
        tel.some(
            (e) => e.name === 'chat.exec.recovery' && e.attrs.outcome === 'result_lost'
        )
    )
})

test('cancellation is never converted into recovery', async () => {
    const controller = new AbortController()
    controller.abort()
    const f = makeFactory({
        stdoutLines: [sysStdout()],
        error: goneError(),
        diskText: diskUser('up', 'hello')
    })
    const adapter = new ClaudeCodeAdapter(f.drivers as never, f.chatRepo, adminSettings())

    const events = await collect(
        adapter.sendMessage(
            { ...baseCtx, abortSignal: controller.signal },
            userMessage
        )
    )

    assert.equal(f.state.recoveryFsCalls, 0)
    assert.equal(
        errors(events)[0]?.type === 'error' && errors(events)[0].error.code,
        'claude_exec_failed'
    )
})

test('turn timeout is never converted into recovery', async () => {
    const timeoutError = new SpritesError(
        'transient',
        'execSpriteStream timed out after 7200000ms'
    )
    const f = makeFactory({
        stdoutLines: [sysStdout()],
        error: timeoutError,
        diskText: diskUser('up', 'hello')
    })
    const adapter = new ClaudeCodeAdapter(f.drivers as never, f.chatRepo, adminSettings())

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    assert.equal(f.state.recoveryFsCalls, 0)
    assert.equal(
        errors(events)[0]?.type === 'error' && errors(events)[0].error.code,
        'claude_exec_failed'
    )
})

test('recovery infrastructure failure falls back to claude_exec_failed', async () => {
    const f = makeFactory({
        stdoutLines: [sysStdout()],
        error: goneError(),
        fsThrows: true
    })
    const { telemetry, events: tel } = makeTelemetry()
    const adapter = new ClaudeCodeAdapter(
        f.drivers as never,
        f.chatRepo,
        adminSettings(),
        telemetry
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    assert.equal(f.state.recoveryFsCalls, 1)
    assert.equal(
        errors(events)[0]?.type === 'error' && errors(events)[0].error.code,
        'claude_exec_failed'
    )
    assert.ok(
        tel.some(
            (e) => e.name === 'chat.exec.recovery' && e.attrs.outcome === 'failed'
        )
    )
})

test('fast path: a fully-streamed result with only the exit frame lost finishes with zero fs calls', async () => {
    const f = makeFactory({
        stdoutLines: [
            sysStdout(),
            asstStdout('a1', 'm1', [{ type: 'text', text: 'answer' }]),
            resultStdout()
        ],
        error: goneError(),
        diskText: null
    })
    const { telemetry, events: tel } = makeTelemetry()
    const adapter = new ClaudeCodeAdapter(
        f.drivers as never,
        f.chatRepo,
        adminSettings(),
        telemetry
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    assert.equal(f.state.recoveryFsCalls, 0)
    assert.equal(errors(events).length, 0)
    assert.ok(events.some((e) => e.type === 'usage'))
    assert.ok(events.some((e) => e.type === 'done'))
    assert.ok(
        tel.some(
            (e) =>
                e.name === 'chat.exec.recovery' &&
                e.attrs.outcome === 'recovered_noop'
        )
    )
})

test('runtime guard: a non-sprites runtime never attempts recovery', async () => {
    const f = makeFactory({
        stdoutLines: [sysStdout()],
        error: goneError(),
        runtime: 'daemon',
        diskText: diskUser('up', 'hello')
    })
    const adapter = new ClaudeCodeAdapter(f.drivers as never, f.chatRepo, adminSettings())

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    assert.equal(f.state.recoveryFsCalls, 0)
    assert.equal(
        errors(events)[0]?.type === 'error' && errors(events)[0].error.code,
        'claude_exec_failed'
    )
})
