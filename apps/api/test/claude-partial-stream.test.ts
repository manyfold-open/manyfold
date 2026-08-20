import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ClaudeCodeAdapter } from '../src/modules/chat/adapters/claude-code.adapter'
import type {
    ExecDriver,
    ExecStreamRequest
} from '../src/modules/chat/adapters/exec-driver'

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
    frameworkSessionRef: null,
    history: []
}

const creds = {
    anthropicAuthToken: 'token',
    anthropicBaseUrl: 'https://api.example.test'
}

const makeDriverFactory = (
    stdout: string,
    runtime: 'sprites' | 'daemon' = 'sprites'
): {
    drivers: { forAgent: () => Promise<unknown> }
    request: ExecStreamRequest | null
} => {
    const out: {
        drivers: { forAgent: () => Promise<unknown> }
        request: ExecStreamRequest | null
    } = {
        request: null,
        drivers: {
            forAgent: async () => ({
                driver,
                creds,
                runtime,
                agent: { workspacePath: '/workspace' }
            })
        }
    }
    const driver: ExecDriver = {
        stream: (request) => {
            out.request = request
            return {
                stdout: chunks(stdout),
                stderr: chunks(''),
                result: Promise.resolve({ exitCode: 0, stdout, stderr: '' }),
                abort: () => {}
            }
        }
    }
    return out
}

const chunks = async function* (...values: string[]): AsyncIterable<string> {
    for (const value of values) yield value
}

const collect = async (
    events: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const event of events) out.push(event)
    return out
}

const chatRepo = { updateFrameworkSessionRef: async () => undefined } as never

const adminSettingsEnabled = {
    isFeatureEnabled: async (key: string) => key === 'claude_partial_stream',
    getCachedChatExecTimeoutMs: async () => ({
        keepAliveMs: 20_000,
        livenessTimeoutMs: 75_000,
        timeoutMs: 7_200_000
    })
} as never

const streamEvent = (
    delta: Record<string, unknown>,
    parentToolUseId: string | null = null
): string =>
    JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta },
        parent_tool_use_id: parentToolUseId,
        session_id: 'sess-1'
    })

const blockStop = (): string =>
    JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
        parent_tool_use_id: null,
        session_id: 'sess-1'
    })

const resultLine = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Hello world',
    session_id: 'sess-1',
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 5 } },
    total_cost_usd: 0.01
})

const FIXTURE_PARTIAL = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    streamEvent({ type: 'thinking_delta', thinking: 'Let me think' }),
    streamEvent({ type: 'thinking_delta', thinking: ' about it' }),
    blockStop(),
    streamEvent({ type: 'text_delta', text: 'Hello' }),
    streamEvent({ type: 'text_delta', text: ' world' }),
    blockStop(),
    JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        message: {
            content: [
                { type: 'thinking', text: 'Let me think about it' },
                { type: 'text', text: 'Hello world' },
                {
                    type: 'tool_use',
                    id: 'tu-1',
                    name: 'Bash',
                    input: { command: 'ls' }
                }
            ]
        }
    }),
    JSON.stringify({
        type: 'user',
        session_id: 'sess-1',
        message: {
            content: [
                { type: 'tool_result', tool_use_id: 'tu-1', content: 'file.txt' }
            ]
        }
    }),
    streamEvent({ type: 'text_delta', text: 'SUBAGENT-DELTA' }, 'tu-1'),
    JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'tu-1',
        session_id: 'sess-1',
        message: { content: [{ type: 'text', text: 'subagent says hi' }] }
    }),
    resultLine,
    ''
].join('\n')

test('partial deltas stream as tokens without duplicating the complete blocks', async () => {
    const handle = makeDriverFactory(FIXTURE_PARTIAL)
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        chatRepo,
        adminSettingsEnabled
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))

    assert.ok(handle.request?.cmd.includes('--include-partial-messages'))

    const thinking = events.filter((ev) => ev.type === 'thinking')
    assert.equal(thinking.length, 1)
    assert.equal(
        thinking[0].type === 'thinking' && thinking[0].text,
        'Let me think about it'
    )

    const tokens = events.filter((ev) => ev.type === 'token')
    const tokenText = tokens
        .map((ev) => (ev.type === 'token' ? ev.text : ''))
        .join('')
    // Top-level text arrives exactly once (deltas), subagent text arrives
    // exactly once (complete line) — no duplication from the complete
    // top-level assistant line.
    assert.equal(tokenText, 'Hello world' + 'subagent says hi')

    const toolCalls = events.filter((ev) => ev.type === 'tool_call')
    assert.equal(toolCalls.length, 1)
    assert.equal(
        toolCalls[0].type === 'tool_call' && toolCalls[0].toolCallId,
        'tu-1'
    )
    assert.equal(events.filter((ev) => ev.type === 'tool_result').length, 1)

    // stream_event lines never produce raw_source rows; the five complete
    // lines (system, assistant, user, subagent assistant, result) do.
    assert.equal(events.filter((ev) => ev.type === 'raw_source').length, 5)

    const usage = events.find((ev) => ev.type === 'usage')
    assert.ok(usage && usage.type === 'usage')
    assert.equal(usage.usage.inputTokens, 10)
    assert.equal(events.at(-1)?.type, 'done')
})

test('delta ordering flushes pending text before tool events', async () => {
    const stdout = [
        streamEvent({ type: 'text_delta', text: 'before-tool' }),
        JSON.stringify({
            type: 'assistant',
            parent_tool_use_id: null,
            session_id: 'sess-1',
            message: {
                content: [
                    { type: 'text', text: 'before-tool' },
                    { type: 'tool_use', id: 'tu-9', name: 'Read', input: {} }
                ]
            }
        }),
        resultLine,
        ''
    ].join('\n')
    const handle = makeDriverFactory(stdout)
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        chatRepo,
        adminSettingsEnabled
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))
    const kinds = events
        .filter((ev) => ev.type === 'token' || ev.type === 'tool_call')
        .map((ev) => ev.type)
    assert.deepEqual(kinds, ['token', 'tool_call'])
    const token = events.find((ev) => ev.type === 'token')
    assert.equal(token?.type === 'token' && token.text, 'before-tool')
})

test('long delta runs coalesce on the size cap without losing bytes', async () => {
    const piece = 'x'.repeat(200)
    const stdout = [
        streamEvent({ type: 'text_delta', text: piece }),
        streamEvent({ type: 'text_delta', text: piece }),
        streamEvent({ type: 'text_delta', text: piece }),
        blockStop(),
        resultLine,
        ''
    ].join('\n')
    const handle = makeDriverFactory(stdout)
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        chatRepo,
        adminSettingsEnabled
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))
    const tokens = events.filter((ev) => ev.type === 'token')
    assert.equal(tokens.length, 1)
    assert.equal(
        tokens[0].type === 'token' && tokens[0].text.length,
        piece.length * 3
    )
})

test('without deltas the complete blocks stream as before', async () => {
    const stdout = [
        JSON.stringify({
            type: 'assistant',
            session_id: 'sess-1',
            message: { content: [{ type: 'text', text: 'block-level' }] }
        }),
        resultLine,
        ''
    ].join('\n')
    const handle = makeDriverFactory(stdout)
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        chatRepo,
        adminSettingsEnabled
    )

    const events = await collect(adapter.sendMessage(baseCtx, userMessage))
    const tokens = events.filter((ev) => ev.type === 'token')
    assert.equal(tokens.length, 1)
    assert.equal(tokens[0].type === 'token' && tokens[0].text, 'block-level')
})

test('daemon runtime never gets the partial-messages flag', async () => {
    const handle = makeDriverFactory(resultLine + '\n', 'daemon')
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        chatRepo,
        adminSettingsEnabled
    )

    await collect(adapter.sendMessage(baseCtx, userMessage))
    assert.equal(
        handle.request?.cmd.includes('--include-partial-messages'),
        false
    )
})

test('toggle off keeps the legacy invocation', async () => {
    const adminSettingsDisabled = {
        isFeatureEnabled: async () => false,
        getCachedChatExecTimeoutMs: async () => ({
            keepAliveMs: 20_000,
            livenessTimeoutMs: 75_000,
            timeoutMs: 7_200_000
        })
    } as never
    const handle = makeDriverFactory(resultLine + '\n')
    const adapter = new ClaudeCodeAdapter(
        handle.drivers as never,
        chatRepo,
        adminSettingsDisabled
    )

    await collect(adapter.sendMessage(baseCtx, userMessage))
    assert.equal(
        handle.request?.cmd.includes('--include-partial-messages'),
        false
    )
})
