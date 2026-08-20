import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// gemini-cli's stream-json has no thought event, so a live gemini turn showed
// no thinking at all while claude and codex did. Thinking comes from the
// session JSONL the CLI writes during the turn, polled in the BACKGROUND:
// awaiting that read per delivered line let a 407KB session file pace token
// delivery to ~7s/line (#518), so thinking may now trail the text of its step
// but must still land before the terminal. These pin that it reaches the
// stream without pacing delivery, and that the paths which have no prompt to
// anchor on stay off.

const REF = 'sess-1'
const PROMPT = 'why is blue calming?'

const LINE = (o: unknown): string => `${JSON.stringify(o)}\n`

const STDOUT =
    LINE({ type: 'init', session_id: REF, model: 'gemini-2.5-flash' }) +
    LINE({ type: 'message', role: 'assistant', content: 'Blue is calming.' }) +
    LINE({ type: 'result', status: 'success' })

const SESSION_JSONL = [
    JSON.stringify({ sessionId: REF, startTime: '2026-07-27T10:00:00.000Z' }),
    JSON.stringify({
        id: 'u1',
        type: 'user',
        timestamp: '2026-07-27T10:00:01.000Z',
        content: [{ text: PROMPT }]
    }),
    JSON.stringify({
        id: 'g1',
        type: 'gemini',
        timestamp: '2026-07-27T10:00:02.000Z',
        content: [{ text: 'Blue is calming.' }],
        thoughts: [
            {
                subject: 'Weighing the wavelength',
                description: 'Short wavelengths read as distant and cool.',
                timestamp: '2026-07-27T10:00:02.000Z'
            }
        ]
    })
].join('\n')

const handleFor = (stdout: string) => ({
    stdout: (async function* () {
        yield stdout
    })(),
    stderr: (async function* () {})(),
    result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    abort: () => {},
    lastDeliveredSeq: () => 3
})

const buildDrivers = (sessionJsonl: string | null) => {
    const calls = { locate: 0, read: 0 }
    const driver = { stream: () => handleFor(STDOUT) }
    return {
        calls,
        drivers: {
            forAgent: async () => ({
                driver,
                creds: { googleApiKey: 'key' },
                runtime: 'sprites',
                agent: {
                    id: 'agt_1',
                    daemonId: null,
                    spriteName: 'sprite-1',
                    workspacePath: '/home/sprite/work'
                }
            }),
            daemonDriverFor: () => driver,
            recoveryFsForAgent: async () => ({
                runtime: 'sprites',
                fs: {
                    locate: async () => {
                        calls.locate++
                        return sessionJsonl === null ? null : '/tmp/session.jsonl'
                    },
                    readFile: async () => {
                        calls.read++
                        return sessionJsonl
                    },
                    listFiles: async () => []
                }
            })
        }
    }
}

const adminSettings = {
    getCachedChatExecTimeoutMs: async () => ({
        timeoutMs: 1000,
        keepAliveMs: 1000,
        livenessTimeoutMs: 1000
    })
}

const adapterOf = (drivers: unknown): GeminiCliAdapter =>
    new GeminiCliAdapter(
        drivers as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        { priceFor: () => null } as never,
        adminSettings as never
    )

const ctx = (): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        model: null,
        modelOverride: null,
        modelConfig: null,
        frameworkSessionRef: null,
        history: []
    }) as unknown as ApiChatAdapterContext

const userMessage = (): ChatMessage =>
    ({
        id: 'msg_0',
        role: 'user',
        contentBlocks: [{ type: 'text', text: PROMPT }]
    }) as unknown as ChatMessage

const drain = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

const withPollMs = async (
    value: string | undefined,
    fn: () => Promise<void>
): Promise<void> => {
    const prev = process.env.MF_GEMINI_THINKING_POLL_MS
    if (value === undefined) delete process.env.MF_GEMINI_THINKING_POLL_MS
    else process.env.MF_GEMINI_THINKING_POLL_MS = value
    try {
        await fn()
    } finally {
        if (prev === undefined) delete process.env.MF_GEMINI_THINKING_POLL_MS
        else process.env.MF_GEMINI_THINKING_POLL_MS = prev
    }
}

test('a live gemini turn streams thinking before the terminal', async () => {
    await withPollMs(undefined, async () => {
        const { drivers, calls } = buildDrivers(SESSION_JSONL)
        const events = await drain(
            adapterOf(drivers).sendMessage(ctx(), userMessage())
        )
        const semantic = events.filter((e) => e.type !== 'raw_source')
        const thinking = semantic.findIndex((e) => e.type === 'thinking')
        assert.ok(thinking !== -1, 'thinking reached the stream')
        assert.match(
            semantic[thinking].type === 'thinking'
                ? semantic[thinking].text
                : '',
            /Weighing the wavelength/
        )
        assert.equal(events.at(-1)?.type, 'done')
        // Located once for the turn, no matter how many polls.
        assert.equal(calls.locate, 1)
    })
})

test('MF_GEMINI_THINKING_POLL_MS=0 keeps the turn intact and reads nothing', async () => {
    await withPollMs('0', async () => {
        const { drivers, calls } = buildDrivers(SESSION_JSONL)
        const events = await drain(
            adapterOf(drivers).sendMessage(ctx(), userMessage())
        )
        assert.ok(!events.some((e) => e.type === 'thinking'))
        assert.equal(
            events.find((e) => e.type === 'token')?.text,
            'Blue is calming.'
        )
        assert.equal(events.at(-1)?.type, 'done')
        assert.equal(calls.locate, 0)
        assert.equal(calls.read, 0)
    })
})

test('a missing session file costs the turn nothing', async () => {
    await withPollMs(undefined, async () => {
        const { drivers } = buildDrivers(null)
        const events = await drain(
            adapterOf(drivers).sendMessage(ctx(), userMessage())
        )
        assert.ok(!events.some((e) => e.type === 'thinking'))
        assert.equal(
            events.find((e) => e.type === 'token')?.text,
            'Blue is calming.'
        )
        assert.equal(events.at(-1)?.type, 'done')
    })
})
