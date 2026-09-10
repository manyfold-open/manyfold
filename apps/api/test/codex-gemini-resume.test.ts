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
            // The settled turn counts its rollout through the recovery fs.
            recoveryFsForAgent: async () => ({
                fs: { exec: async () => '1\n' }
            }),
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
        {
            updateFrameworkSessionRef: async () => {},
            setRuntimeSyncCursor: async () => {}
        } as never,
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
        {
            updateFrameworkSessionRef: async () => {},
            setRuntimeSyncCursor: async () => {}
        } as never,
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
        {
            updateFrameworkSessionRef: async () => {},
            setRuntimeSyncCursor: async () => {}
        } as never,
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
        {
            updateFrameworkSessionRef: async () => {},
            setRuntimeSyncCursor: async () => {}
        } as never,
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
        {
            updateFrameworkSessionRef: async () => {},
            setRuntimeSyncCursor: async () => {}
        } as never,
        { priceFor: () => null } as never,
        adminSettings as never
    )
    const events = await drain(adapter.resumeMessage(resumeCtx() as never))
    const raw = events.find((e) => e.type === 'raw_source')
    assert.ok(raw && 'runnerSeq' in raw)
})

// ---- transcript cursor -----------------------------------------------------
//
// The rollout codex just wrote is already in the cloud through the stream;
// the runtime-session sync must not read it back as the TUI's. So once codex
// exits the adapter counts the file's lines and stores that on the session,
// before `done` frees the turn slot the sync waits on.

const cursorHarness = (
    stdout: string,
    options: {
        lineCount?: string | null
        fsThrows?: boolean
        exit?: { exitCode: number; stderr: string }
        streamThrows?: boolean
    } = {}
) => {
    const log: string[] = []
    const execs: string[] = []
    const handle = {
        stdout: (async function* () {
            if (options.streamThrows) throw new Error('socket closed')
            yield stdout
        })(),
        stderr: (async function* () {})(),
        result: Promise.resolve({
            exitCode: options.exit?.exitCode ?? 0,
            stdout: '',
            stderr: options.exit?.stderr ?? ''
        }),
        abort: () => {},
        lastDeliveredSeq: () => 0
    }
    const drivers = {
        daemonDriverFor: () => ({
            stream: () => handle,
            resumeStream: () => handle
        }),
        recoveryFsForAgent: async (agentId: string) => {
            if (options.fsThrows) throw new Error('sprite unreachable')
            log.push(`fs:${agentId}`)
            return {
                fs: {
                    exec: async (script: string) => {
                        execs.push(script)
                        return options.lineCount === undefined
                            ? '22\n'
                            : options.lineCount
                    }
                }
            }
        }
    }
    const cursors: Array<number | null> = []
    const chatRepo = {
        updateFrameworkSessionRef: async () => {},
        setRuntimeSyncCursor: async (
            sessionId: string,
            cursor: number | null
        ) => {
            cursors.push(cursor)
            log.push(`cursor:${sessionId}:${cursor}`)
        }
    }
    const adapter = new CodexAdapter(
        drivers as never,
        chatRepo as never,
        { priceFor: () => null } as never,
        adminSettings as never
    )
    return { adapter, log, execs, cursors }
}

test('codex records the rollout line count before it yields done', async () => {
    const h = cursorHarness(
        LINE({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'ok' }
        }) + LINE({ type: 'turn.completed' })
    )
    const events: string[] = []
    for await (const ev of h.adapter.resumeMessage(resumeCtx() as never)) {
        events.push(ev.type)
        h.log.push(`event:${ev.type}`)
    }
    assert.deepEqual(h.cursors, [22])
    assert.match(h.execs[0], /01a08b38|thread-1/)
    assert.equal(h.log.indexOf('cursor:cts_1:22') > -1, true)
    assert.ok(
        h.log.indexOf('cursor:cts_1:22') < h.log.indexOf('event:done'),
        `cursor must land before done: ${h.log.join(' ')}`
    )
    assert.equal(events.at(-1), 'done')
})

test('codex drops the cursor when the rollout cannot be counted', async () => {
    for (const options of [{ fsThrows: true }, { lineCount: 'wc: no file' }]) {
        const h = cursorHarness(LINE({ type: 'turn.completed' }), options)
        await drain(h.adapter.resumeMessage(resumeCtx() as never))
        assert.deepEqual(h.cursors, [null], JSON.stringify(options))
    }
})

test('codex drops the cursor after a lost stream and a failed exec, but keeps it over a busy thread', async () => {
    const lost = cursorHarness('', { streamThrows: true })
    await drain(lost.adapter.resumeMessage(resumeCtx() as never))
    assert.deepEqual(lost.cursors, [null])

    const failed = cursorHarness('', {
        exit: { exitCode: 1, stderr: 'boom' }
    })
    await drain(failed.adapter.resumeMessage(resumeCtx() as never))
    assert.deepEqual(failed.cursors, [null])

    const busy = cursorHarness('', {
        exit: {
            exitCode: 1,
            stderr: 'thread/resume failed: thread x already has an active writer (code -32600)'
        }
    })
    await drain(busy.adapter.resumeMessage(resumeCtx() as never))
    assert.deepEqual(busy.cursors, [])
})
