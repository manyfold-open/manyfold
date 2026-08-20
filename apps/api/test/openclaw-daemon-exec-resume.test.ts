import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent,
    EmittedRawSourceEvent
} from '../src/modules/chat/chat-adapter'
import type {
    ExecDriver,
    ExecResumeRequest,
    ExecStreamHandle,
    ExecStreamRequest,
    ExecStreamResult
} from '../src/modules/chat/adapters/exec-driver'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'
import { buildChatMessageSourceRow } from '../src/modules/chat/raw-message-source'

// #666, the other half. #667 taught the daemon-spawn path to SUSPEND a lost
// socket instead of failing it — but the hello that found the orphan called
// resumeMessage, which accepted only sprites runtimes and answered
// `openclaw_resume_unsupported`, non-retryable. So the fix moved the terminal
// from dispatch time to resume time and recovered nothing: the daemon finished
// `openclaw agent --json`, held the whole answer in its buffer, and had nowhere
// to hand it back.
//
// The buffer shape was the stated reason to decline. It is not a reason:
// `exec.resume` replays a completed exec's buffered stdout from seq 0 and acks
// with the child's exit code, i.e. the SAME handle shape `exec.start` produces,
// so the fresh-dispatch drain parses a replay without knowing it is one. These
// tests pin the adapter loop at its driver seam: dispatch → classified
// socket loss → suspended → attach → the same messageId completes. The real
// driver, CLI buffer, and hello single-flight contracts are covered in their
// own suites; only the staging restart drill crosses those process boundaries.

const DAEMON_ID = 'dh_1'
const MESSAGE_ID = 'msg_assistant'
const SESSION_ID = 'cts_1'

// What the daemon has buffered for this ref: `openclaw agent --json` NDJSON,
// not SSE deltas. The replay is byte-identical to what a live drain would have
// read, which is the whole reason one drain can serve both.
const CLI_STDOUT = [
    '{"type":"text","sessionId":"ocs_9","text":"recovered "}\n',
    '{"type":"tool_use","tool":"bash","callId":"call_1","input":{"cmd":"ls"}}\n',
    '{"type":"text","text":"answer"}\n{"type":"step_finish","usage":',
    '{"prompt_tokens":11,"completion_tokens":7}}\n'
]

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 1_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) await delay(5)
    assert.ok(predicate(), label)
}

interface HandleProbe {
    abortCalls: number
}

// Mirrors DaemonExecDriver: events are delivered on the stream, the ack settles
// `result`, and a cancel rejects the pending RPC with `cancelled` rather than
// resolving it.
const makeHandle = (opts: {
    stdout?: string[]
    reject?: Error
    settleOn?: 'dispatch' | 'abort'
    abortReject?: Error
}): { handle: ExecStreamHandle; probe: HandleProbe } => {
    const probe = { abortCalls: 0 }
    let fail: (err: Error) => void = () => {}
    let settle: (value: ExecStreamResult) => void = () => {}
    const result = new Promise<ExecStreamResult>((resolve, reject) => {
        settle = resolve
        fail = reject
    })
    // Mirrors observedResult: the adapter attaches its catch several
    // microtasks later, and an unobserved rejection kills the instance
    // (staging 2026-08-03).
    result.catch(() => {})
    if (opts.reject) fail(opts.reject)
    else if (opts.settleOn !== 'abort')
        settle({ exitCode: 0, stdout: '', stderr: '' })
    return {
        handle: {
            stdout: (async function* (): AsyncGenerator<string> {
                for (const chunk of opts.stdout ?? []) yield chunk
            })(),
            stderr: (async function* (): AsyncGenerator<string> {})(),
            result,
            abort: () => {
                probe.abortCalls += 1
                fail(opts.abortReject ?? new Error('cancelled'))
            }
        },
        probe
    }
}

interface Seam {
    starts: Array<{ cmd: string[]; execHandle?: string }>
    resumes: ExecResumeRequest[]
    daemonDrivers: Array<{
        daemonId: string
        baseEnv?: Record<string, string>
    }>
    sessionRefs: Array<[string, string | null]>
    aborts: () => number
    drivers: unknown
    chatRepo: unknown
}

const makeSeam = (
    opts: {
        dispatchReject?: Error
        resumeStdout?: string[]
        resumeReject?: Error
        resumeSettleOn?: 'dispatch' | 'abort'
        resumeAbortReject?: Error
        withoutResumeSupport?: boolean
    } = {}
): Seam => {
    const probes: HandleProbe[] = []
    const track = (made: {
        handle: ExecStreamHandle
        probe: HandleProbe
    }): ExecStreamHandle => {
        probes.push(made.probe)
        return made.handle
    }
    const seam: Seam = {
        starts: [],
        resumes: [],
        daemonDrivers: [],
        sessionRefs: [],
        aborts: () => probes.reduce((n, p) => n + p.abortCalls, 0),
        drivers: null,
        chatRepo: null
    }
    const driver: ExecDriver = {
        stream: (req: ExecStreamRequest) => {
            seam.starts.push({ cmd: req.cmd, execHandle: req.execHandle })
            return track(makeHandle({ reject: opts.dispatchReject }))
        },
        ...(opts.withoutResumeSupport
            ? {}
            : {
                  resumeStream: (req: ExecResumeRequest) => {
                      seam.resumes.push(req)
                      return track(
                          makeHandle({
                              stdout: opts.resumeStdout ?? CLI_STDOUT,
                              reject: opts.resumeReject,
                              settleOn: opts.resumeSettleOn,
                              abortReject: opts.resumeAbortReject
                          })
                      )
                  }
              })
    }
    seam.drivers = {
        forAgent: async () => ({
            driver,
            creds: null,
            runtime: 'daemon',
            agent: {
                id: 'agt_1',
                internalId: 'main',
                daemonId: DAEMON_ID,
                model: null
            }
        }),
        daemonDriverFor: (
            daemonId: string,
            baseEnv?: Record<string, string>
        ) => {
            seam.daemonDrivers.push({ daemonId, baseEnv })
            return driver
        }
    }
    seam.chatRepo = {
        updateFrameworkSessionRef: async (
            sessionId: string,
            ref: string | null
        ): Promise<void> => {
            seam.sessionRefs.push([sessionId, ref])
        }
    }
    return seam
}

const makeDb = () => ({
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => [
                    {
                        runtime: 'daemon',
                        internalId: 'main',
                        daemonId: DAEMON_ID
                    }
                ]
            })
        })
    })
})

// Six positional arguments on purpose: no registry, no admin settings. The
// daemon resume must not depend on either — MF_OPENCLAW_TURN_RPC gates the
// runner-owned turn.start transport, and this path is `exec.start` over the
// factory driver, which that flag never covered.
const buildAdapter = (seam: Seam): OpenclawAdapter =>
    new OpenclawAdapter(
        makeDb() as never,
        {} as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        seam.chatRepo as never,
        seam.drivers as never,
        { event: () => {}, error: () => {} } as never
    )

const sendCtx = (extra: Partial<ApiChatAdapterContext> = {}) =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        framework: 'openclaw',
        runtimeKind: 'daemon',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        frameworkSessionRef: null,
        history: [],
        ...extra
    }) as ApiChatAdapterContext

const resumeCtx = (extra: Partial<ApiChatResumeContext> = {}) =>
    ({
        ...sendCtx(),
        daemonId: DAEMON_ID,
        daemonExecRef: MESSAGE_ID,
        fromSeq: 0,
        ...extra
    }) as ApiChatResumeContext

const userMessage: ChatMessage = {
    id: 'msg_user',
    sessionId: SESSION_ID,
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }],
    createdAt: '2026-08-13T00:00:00.000Z'
}

const collect = async (
    it: AsyncIterable<EmittedChatEvent>
): Promise<EmittedChatEvent[]> => {
    const out: EmittedChatEvent[] = []
    for await (const ev of it) out.push(ev)
    return out
}

const textOf = (events: EmittedChatEvent[]): string =>
    events
        .filter((ev) => ev.type === 'token')
        .map((ev) => (ev.type === 'token' ? ev.text : ''))
        .join('')

// WHY: both adapter halves run against ONE seam, so "no duplicate execution"
// is provable as an absence: recovery must not start another CLI.
test('a suspended daemon exec reattaches and converges on the same message', async () => {
    const seam = makeSeam({ dispatchReject: new Error('connection replaced') })
    const adapter = buildAdapter(seam)

    const dispatched = await collect(
        adapter.sendMessage(sendCtx(), userMessage)
    )
    const suspended = dispatched.find((ev) => ev.type === 'suspended')
    assert.ok(
        suspended,
        `expected a suspend; got ${JSON.stringify(dispatched)}`
    )
    assert.equal(
        suspended.type === 'suspended' && suspended.daemonExecRef,
        MESSAGE_ID
    )

    const resumed = await collect(
        adapter.resumeMessage(
            resumeCtx({
                daemonId:
                    suspended.type === 'suspended'
                        ? suspended.daemonId
                        : DAEMON_ID,
                daemonExecRef:
                    suspended.type === 'suspended'
                        ? suspended.daemonExecRef
                        : MESSAGE_ID
            })
        )
    )

    assert.equal(
        seam.starts.length,
        1,
        `the resume must not re-run the CLI; starts=${JSON.stringify(seam.starts)}`
    )
    assert.deepEqual(seam.daemonDrivers, [
        { daemonId: DAEMON_ID, baseEnv: undefined }
    ])
    assert.equal(seam.resumes.length, 1)
    assert.equal(seam.resumes[0].refId, MESSAGE_ID)

    assert.ok(
        !resumed.some((ev) => ev.type === 'error'),
        `a recovered turn must not terminalize; got ${JSON.stringify(resumed)}`
    )
    assert.equal(textOf(resumed), 'recovered answer')
    const toolCall = resumed.find((ev) => ev.type === 'tool_call')
    assert.equal(toolCall?.type === 'tool_call' && toolCall.toolName, 'bash')
    assert.ok(
        resumed.some((ev) => ev.type === 'usage'),
        'the replayed step_finish carries the turn usage'
    )
    const done = resumed.find((ev) => ev.type === 'done')
    assert.ok(done)
    assert.equal(
        done.type === 'done' && done.finalMessageId,
        MESSAGE_ID,
        'the recovered turn must converge the message it suspended as'
    )
    // The replay is also where a first-turn session ref is learned: without it
    // the next turn on this session starts a new openclaw session.
    assert.deepEqual(seam.sessionRefs, [[SESSION_ID, 'ocs_9']])
})

// WHY: `openclaw agent --json` is parsed as ONE buffer — a replay that starts
// mid-stream parses to nothing at all, so a nonzero cursor would silently
// converge an empty answer. The path stamps no runnerSeq on any source row, so
// the ladder can only ever compute 0 for it; pinning it here means a future
// cursor change cannot quietly reach this transport.
test('the replay always starts at the head of the buffer', async () => {
    const seam = makeSeam()
    const events = await collect(
        buildAdapter(seam).resumeMessage(resumeCtx({ fromSeq: 12 }))
    )

    assert.equal(seam.resumes[0].fromSeq, 0)
    assert.equal(textOf(events), 'recovered answer')
})

// WHY: #570's burden of proof, on the path that had no resume at all. A hello
// already reported this stream, so a lookup that finds no socket means the
// connection died between hello and attach — the buffer is still on the daemon
// and the next hello reports it again. The same string at DISPATCH still means
// nothing ran, and must still fail retryably (#481/#512/2026-08-03).
test('an attach that loses the socket suspends again rather than terminalizing', async () => {
    const offline = 'daemon dh_1 is offline; no active websocket'

    const attach = makeSeam({ resumeReject: new Error(offline) })
    const resumed = await collect(
        buildAdapter(attach).resumeMessage(resumeCtx())
    )
    const suspended = resumed.find((ev) => ev.type === 'suspended')
    assert.ok(
        suspended,
        `a dead attach must stay recoverable; got ${JSON.stringify(resumed)}`
    )
    assert.equal(
        suspended.type === 'suspended' && suspended.daemonId,
        DAEMON_ID
    )
    assert.equal(
        suspended.type === 'suspended' && suspended.daemonExecRef,
        MESSAGE_ID,
        'the re-suspend must name the same ref, or the next hello cannot match'
    )
    assert.ok(!resumed.some((ev) => ev.type === 'error'))

    const dispatch = makeSeam({ dispatchReject: new Error(offline) })
    const sent = await collect(
        buildAdapter(dispatch).sendMessage(sendCtx(), userMessage)
    )
    assert.ok(
        !sent.some((ev) => ev.type === 'suspended'),
        'the dispatch classification must not inherit resume semantics'
    )
    assert.equal(
        sent.find((ev) => ev.type === 'error')?.type === 'error' &&
            (
                sent.find((ev) => ev.type === 'error') as EmittedChatEvent & {
                    error: { code: string; retryable: boolean }
                }
            ).error.code,
        'openclaw_daemon_exec_failed'
    )
})

// WHY: bounded recovery. A buffer the daemon can no longer serve is the
// 2026-08-03 shape — suspending would park the turn until the unmatched sweep
// ages it out, so it has to terminalize, retryably, on the spot.
test('a resume the daemon cannot serve fails retryably instead of parking', async () => {
    for (const reason of [
        `no buffer for refId ${MESSAGE_ID}`,
        'daemon process crashed'
    ]) {
        const seam = makeSeam({ resumeReject: new Error(reason) })
        const events = await collect(
            buildAdapter(seam).resumeMessage(resumeCtx())
        )
        assert.ok(
            !events.some((ev) => ev.type === 'suspended'),
            `must not park on: ${reason}`
        )
        const err = events.find((ev) => ev.type === 'error')
        assert.ok(err, `expected a terminal for: ${reason}`)
        assert.equal(
            err.type === 'error' && err.error.code,
            'openclaw_daemon_exec_failed'
        )
        assert.equal(err.type === 'error' && err.error.retryable, true)
        assert.equal(err.type === 'error' && err.error.message, reason)
    }
})

// WHY: hello-resume is at-least-once. The daemon service single-flights
// concurrent hellos; this adapter-level repeat pins deterministic replay and
// the absence of a fallback exec.start.
test('a repeated resume replays the same buffer without re-running the CLI', async () => {
    const seam = makeSeam()
    const adapter = buildAdapter(seam)

    const first = await collect(adapter.resumeMessage(resumeCtx()))
    const second = await collect(adapter.resumeMessage(resumeCtx()))

    assert.equal(seam.starts.length, 0)
    assert.deepEqual(
        seam.resumes.map((r) => [r.refId, r.fromSeq]),
        [
            [MESSAGE_ID, 0],
            [MESSAGE_ID, 0]
        ]
    )
    assert.equal(textOf(first), textOf(second))
    assert.deepEqual(
        first.map((ev) => ev.type),
        second.map((ev) => ev.type)
    )
})

test('replayed CLI stdout keeps one stable durable source identity', async () => {
    const seam = makeSeam()
    const adapter = buildAdapter(seam)

    const first = await collect(adapter.resumeMessage(resumeCtx()))
    const second = await collect(adapter.resumeMessage(resumeCtx()))
    const sourceOf = (
        events: EmittedChatEvent[]
    ): EmittedRawSourceEvent | undefined =>
        events.find(
            (ev): ev is EmittedRawSourceEvent => ev.type === 'raw_source'
        )
    const firstSource = sourceOf(first)
    const secondSource = sourceOf(second)

    assert.ok(firstSource)
    assert.ok(secondSource)
    assert.equal(firstSource.source.rawFormat, 'jsonl')
    const rowFor = (event: EmittedRawSourceEvent) =>
        buildChatMessageSourceRow({
            sourceKind: 'live_stream',
            sessionId: SESSION_ID,
            messageId: MESSAGE_ID,
            framework: 'openclaw',
            runtime: 'daemon',
            source: event.source
        })
    const firstRow = rowFor(firstSource)
    const secondRow = rowFor(secondSource)

    assert.equal(firstRow.sourceEventKey, secondRow.sourceEventKey)
    assert.equal(
        first.findIndex((ev) => ev.type === 'raw_source'),
        0,
        'the source key must be installed before any derived content row'
    )
})

test('replayed tool calls without an upstream id keep a stable id', async () => {
    const seam = makeSeam({
        resumeStdout: [
            '{"type":"tool_use","tool":"bash","input":{"cmd":"ls"}}\n'
        ]
    })
    const adapter = buildAdapter(seam)

    const toolId = async (): Promise<string | null> => {
        const events = await collect(adapter.resumeMessage(resumeCtx()))
        const tool = events.find((ev) => ev.type === 'tool_call')
        return tool?.type === 'tool_call' ? tool.toolCallId : null
    }

    assert.equal(await toolId(), `${MESSAGE_ID}-tool-1`)
    assert.equal(await toolId(), `${MESSAGE_ID}-tool-1`)
})

// WHY: a cancel must win over a recovery. The attach holds a socket the same
// way a dispatch does, so it has to be torn down exactly once — and the outcome
// must NOT be a re-suspend, or the turn the user cancelled comes back on the
// next hello.
test('a cancel during a resume tears the attach down exactly once', async () => {
    const seam = makeSeam({ resumeSettleOn: 'abort' })
    const controller = new AbortController()

    const events: EmittedChatEvent[] = []
    const consumed = (async (): Promise<void> => {
        for await (const ev of buildAdapter(seam).resumeMessage(
            resumeCtx({ abortSignal: controller.signal })
        ))
            events.push(ev)
    })()

    await waitFor(() => seam.resumes.length === 1, 'expected an attach')
    controller.abort()
    await consumed

    assert.equal(seam.aborts(), 1, 'the attach must be torn down once')
    assert.equal(seam.starts.length, 0, 'a cancel starts nothing')
    assert.ok(
        !events.some((ev) => ev.type === 'suspended'),
        `a cancelled turn must not stay recoverable; got ${JSON.stringify(events)}`
    )
    assert.ok(events.some((ev) => ev.type === 'error'))
})

test('a cancel wins when the resume socket disappears at the same time', async () => {
    const seam = makeSeam({
        resumeSettleOn: 'abort',
        resumeAbortReject: new Error('connection replaced')
    })
    const controller = new AbortController()
    const events: EmittedChatEvent[] = []
    const consumed = (async (): Promise<void> => {
        for await (const ev of buildAdapter(seam).resumeMessage(
            resumeCtx({ abortSignal: controller.signal })
        ))
            events.push(ev)
    })()

    await waitFor(() => seam.resumes.length === 1, 'expected an attach')
    controller.abort()
    await consumed

    assert.ok(!events.some((ev) => ev.type === 'suspended'))
    const terminal = events.at(-1)
    assert.equal(
        terminal?.type === 'error' && terminal.error.code,
        'openclaw_aborted'
    )
})

test('a completed resume releases its abort listener', async () => {
    const seam = makeSeam()
    const controller = new AbortController()

    await collect(
        buildAdapter(seam).resumeMessage(
            resumeCtx({ abortSignal: controller.signal })
        )
    )
    controller.abort()

    assert.equal(seam.aborts(), 0)
})

test('an already-cancelled resume does not attach', async () => {
    const seam = makeSeam()
    const controller = new AbortController()
    controller.abort()

    const events = await collect(
        buildAdapter(seam).resumeMessage(
            resumeCtx({ abortSignal: controller.signal })
        )
    )

    assert.equal(seam.daemonDrivers.length, 0)
    assert.equal(seam.resumes.length, 0)
    assert.equal(
        events[0]?.type === 'error' && events[0].error.code,
        'openclaw_aborted'
    )
})

// WHY: blast radius. The sprite runner turn resumes over turn.start and stays
// behind its own flag; the daemon branch must not answer for it.
test('a sprite openclaw turn keeps the runner-resume gate', async () => {
    const seam = makeSeam()
    const events = await collect(
        buildAdapter(seam).resumeMessage(resumeCtx({ runtimeKind: 'sprites' }))
    )

    assert.equal(seam.daemonDrivers.length, 0)
    assert.equal(seam.resumes.length, 0)
    assert.equal(
        events[0]?.type === 'error' && events[0].error.code,
        'openclaw_resume_unsupported'
    )
})

// WHY: a daemon whose transport cannot replay is a real state (an old CLI, or a
// driver without the capability). Declining explicitly beats attaching to
// something that will never answer.
test('a daemon transport without replay support declines the resume', async () => {
    const seam = makeSeam({ withoutResumeSupport: true })
    const events = await collect(buildAdapter(seam).resumeMessage(resumeCtx()))

    assert.equal(seam.starts.length, 0)
    const err = events.find((ev) => ev.type === 'error')
    assert.ok(err)
    assert.equal(
        err.type === 'error' && err.error.code,
        'openclaw_resume_unsupported'
    )
    assert.equal(err.type === 'error' && err.error.retryable, false)
})
