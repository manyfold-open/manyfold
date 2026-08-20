import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAdapter } from '../src/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

// Codex and gemini could START a turn on the sprite's runner but had
// no resumeMessage at all, so an interrupted runner turn could only be rebuilt
// from the framework transcript — the runner's whole advantage (an exact,
// already-parsed replay from a cursor) was unreachable for two of three
// frameworks.
//
// The stream parsing now lives in one place per adapter, shared by sendMessage
// and resumeMessage. That is what these pin: the resume path must reach the
// SAME parser (so a recovered turn produces the same events a live one does),
// must target the daemon that reported the stream, and must carry the cursor.

const LINE = (o: unknown): string => `${JSON.stringify(o)}\n`

const handleFor = (stdout: string, seq = 0) => ({
    stdout: (async function* () {
        yield stdout
    })(),
    stderr: (async function* () {})(),
    result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    abort: () => {},
    lastDeliveredSeq: () => seq
})

const buildDrivers = (stdout: string) => {
    const resumes: Array<{
        daemonId: string
        refId: string
        fromSeq: number
    }> = []
    return {
        resumes,
        drivers: {
            daemonDriverFor: (daemonId: string) => ({
                stream: () => handleFor(stdout),
                resumeStream: (r: { refId: string; fromSeq: number }) => {
                    resumes.push({ daemonId, ...r })
                    return handleFor(stdout)
                }
            })
        }
    }
}

const adminSettings = {
    isFeatureEnabled: async () => true,
    getCachedChatExecTimeoutMs: async () => ({
        timeoutMs: 1000,
        keepAliveMs: 1000,
        livenessTimeoutMs: 1000
    })
}

const resumeCtx = (): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: 'msg_1',
        runtimeKind: 'sprites',
        model: 'gpt-5',
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: 'thread-1',
        history: [],
        daemonId: 'dh_runner',
        daemonExecRef: 'msg_1',
        fromSeq: 12
    }) as unknown as ApiChatAdapterContext

const drain = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

test('a codex resume replays through the same parser, from the cursor', async () => {
    const stdout =
        LINE({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'recovered answer' }
        }) + LINE({ type: 'turn.completed' })
    const { drivers, resumes } = buildDrivers(stdout)
    const adapter = new CodexAdapter(
        drivers as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        { priceFor: () => null } as never,
        adminSettings as never
    )

    const events = await drain(adapter.resumeMessage(resumeCtx() as never))

    // Reached the daemon that reported the stream — NOT a driver picked from
    // the agent's runtime, which for a sprite runner would have refused.
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].daemonId, 'dh_runner')
    assert.equal(resumes[0].refId, 'msg_1')
    assert.equal(resumes[0].fromSeq, 12)
    // Parsed, not just relayed: the replayed bytes became the same event types
    // a live turn produces, including the raw_source rows dedup depends on.
    assert.ok(events.some((e) => e.type === 'raw_source'))
    assert.equal(
        events.find((e) => e.type === 'token')?.text,
        'recovered answer'
    )
    assert.equal(events.at(-1)?.type, 'done')
})

test('a gemini resume replays through the same parser, from the cursor', async () => {
    const stdout = LINE({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'recovered gemini' }] }
    })
    const { drivers, resumes } = buildDrivers(stdout)
    const adapter = new GeminiCliAdapter(
        drivers as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        { priceFor: () => null } as never,
        adminSettings as never
    )

    const events = await drain(adapter.resumeMessage(resumeCtx() as never))

    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].daemonId, 'dh_runner')
    assert.equal(resumes[0].refId, 'msg_1')
    assert.equal(resumes[0].fromSeq, 12)
    assert.ok(events.some((e) => e.type === 'raw_source'))
    assert.equal(events.at(-1)?.type, 'done')
})

test('a resume without a resume-capable transport says so instead of hanging', async () => {
    // WHY retryable:false — there is no buffer to come back to, so retrying the
    // resume can never succeed; the turn has to be re-sent.
    const drivers = { daemonDriverFor: () => ({ stream: () => handleFor('') }) }
    const adapter = new CodexAdapter(
        drivers as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        { priceFor: () => null } as never,
        adminSettings as never
    )
    const events = await drain(adapter.resumeMessage(resumeCtx() as never))
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'error')
    assert.equal(
        events[0].type === 'error' ? events[0].error.code : null,
        'codex_resume_unsupported'
    )
})

// Without a runner seq on the source rows the cursor is always 0, so every
// resume replays the entire turn — safe (the unique source key absorbs it) but
// it throws away the exact-replay the exec buffer exists to provide. claude has
// stamped this since S0; codex and gemini did not, so their resumes silently
// degraded to full replay.
test('codex stamps a resume watermark on lines that end on a chunk boundary', async () => {
    const { drivers } = buildDrivers(
        LINE({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'hi' }
        })
    )
    const adapter = new CodexAdapter(
        drivers as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        { priceFor: () => null } as never,
        adminSettings as never
    )
    const events = await drain(adapter.resumeMessage(resumeCtx() as never))
    const raw = events.find((e) => e.type === 'raw_source')
    assert.ok(raw && 'runnerSeq' in raw, 'raw_source carries the watermark')
})

test('gemini stamps a resume watermark too', async () => {
    const { drivers } = buildDrivers(
        LINE({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'hi' }] }
        })
    )
    const adapter = new GeminiCliAdapter(
        drivers as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        { priceFor: () => null } as never,
        adminSettings as never
    )
    const events = await drain(adapter.resumeMessage(resumeCtx() as never))
    const raw = events.find((e) => e.type === 'raw_source')
    assert.ok(raw && 'runnerSeq' in raw)
})
