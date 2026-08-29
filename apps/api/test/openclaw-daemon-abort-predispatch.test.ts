import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import type {
    ExecDriver,
    ExecStreamResult
} from '../src/modules/chat/adapters/exec-driver'
import { OpenclawAdapter } from '../src/modules/chat/adapters/openclaw.adapter'

// #402. The daemon-spawn path dispatched `openclaw agent --json` and only THEN
// registered its abort listener. A signal never replays, so a turn cancelled
// before the dispatch (or during the awaits that precede it — the agents read
// in sendMessage, `drivers.forAgent` here) started a CLI that nobody was left
// to read: the local terminal converged to `cancelled_by_user` while the daemon
// kept burning compute and model quota, the same leak #665 paid for on hermes.
//
// The counters below are the whole point. "No exec was started" is only
// provable as an absence at the driver seam, and "the running exec was torn
// down" only as exactly one `abort()` — the post-dispatch semantics must be
// unchanged by the no-start fix.

const DAEMON_ID = 'dh_1'
const MESSAGE_ID = 'msg_assistant'

const empty = async function* (): AsyncIterable<string> {}

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

interface DriverProbe {
    drivers: { forAgent: (agentId: string) => Promise<unknown> }
    streamCalls: number
    abortCalls: number
    lookupEntered: () => boolean
    releaseLookup: () => void
}

// `gateLookup` holds `drivers.forAgent` open so a cancel can land inside it —
// the interleaving a pre-aborted controller cannot reach. `settleOn` decides
// whether a dispatched exec finishes on its own ('dispatch', so a regressed
// no-start fails on the counter instead of hanging) or only when torn down
// ('abort', which is how a real turn waits on the CLI).
const makeDrivers = (
    opts: { gateLookup?: boolean; settleOn?: 'dispatch' | 'abort' } = {}
): DriverProbe => {
    const probe = {
        streamCalls: 0,
        abortCalls: 0,
        entered: false,
        release: (): void => {}
    }
    const lookupGate = new Promise<void>((resolve) => {
        probe.release = resolve
    })
    const driver: ExecDriver = {
        stream: () => {
            probe.streamCalls += 1
            let settle: (value: ExecStreamResult) => void = () => {}
            const result = new Promise<ExecStreamResult>((resolve) => {
                settle = resolve
            })
            if (opts.settleOn !== 'abort')
                settle({ exitCode: 0, stdout: '', stderr: '' })
            return {
                stdout: empty(),
                stderr: empty(),
                result,
                abort: () => {
                    probe.abortCalls += 1
                    settle({ exitCode: 143, stdout: '', stderr: '' })
                }
            }
        }
    }
    return {
        drivers: {
            forAgent: async () => {
                probe.entered = true
                if (opts.gateLookup) await lookupGate
                return {
                    driver,
                    creds: null,
                    runtime: 'daemon',
                    agent: {
                        id: 'agt_1',
                        internalId: 'main',
                        daemonId: DAEMON_ID,
                        model: null
                    }
                }
            }
        },
        get streamCalls() {
            return probe.streamCalls
        },
        get abortCalls() {
            return probe.abortCalls
        },
        lookupEntered: () => probe.entered,
        releaseLookup: () => probe.release()
    }
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

const buildAdapter = (drivers: DriverProbe): OpenclawAdapter =>
    new OpenclawAdapter(
        makeDb() as never,
        {} as never,
        { computeCost: () => ({ costUsd: null, costSource: 'none' }) } as never,
        { updateFrameworkSessionRef: async () => {} } as never,
        drivers.drivers as never,
        { event: () => {}, error: () => {} } as never
    )

const ctx = (abortSignal: AbortSignal): ApiChatAdapterContext =>
    ({
        userId: 'user-1',
        agentId: 'agt_1',
        runtimeId: 'art_1',
        sessionId: 'cts_1',
        messageId: MESSAGE_ID,
        framework: 'openclaw',
        runtimeKind: 'daemon',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        hermesPermissionMode: null,
        frameworkSessionRef: 'fsr-1',
        history: [],
        abortSignal
    }) as ApiChatAdapterContext

const userMessage: ChatMessage = {
    id: 'msg_user',
    sessionId: 'cts_1',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'hi' }],
    createdAt: '2026-08-13T00:00:00.000Z'
}

// WHY: this is the leak itself. `exec.start` is what bills the daemon, so a
// turn the user already cancelled must not reach the driver at all.
test('an already-cancelled daemon turn dispatches no openclaw exec', async () => {
    const drivers = makeDrivers()
    const adapter = buildAdapter(drivers)
    const controller = new AbortController()
    controller.abort()

    const events: EmittedChatEvent[] = []
    for await (const ev of adapter.sendMessage(
        ctx(controller.signal),
        userMessage
    ))
        events.push(ev)

    assert.equal(
        drivers.streamCalls,
        0,
        `a cancelled turn must not start the CLI; got ${JSON.stringify(events)}`
    )
    assert.equal(
        drivers.abortCalls,
        0,
        'nothing was started, so nothing tears down'
    )
    assert.deepEqual(
        events.map((ev) => ev.type),
        ['error'],
        'the turn still has to terminalize, or the pipeline waits forever'
    )
    const terminal = events[0]
    assert.equal(
        terminal.type === 'error' && terminal.error.code,
        'openclaw_aborted'
    )
    assert.equal(
        terminal.type === 'error' && terminal.error.retryable,
        false,
        'a cancel is not a retryable failure'
    )
})

// WHY: the cancel does not have to precede the call. `drivers.forAgent` resolves
// credentials and admission over the network, and a cancel landing inside that
// await used to be invisible to a listener registered after the dispatch.
test('a cancel during the driver lookup dispatches no openclaw exec', async () => {
    const drivers = makeDrivers({ gateLookup: true })
    const adapter = buildAdapter(drivers)
    const controller = new AbortController()

    const events: EmittedChatEvent[] = []
    const consumed = (async () => {
        for await (const ev of adapter.sendMessage(
            ctx(controller.signal),
            userMessage
        ))
            events.push(ev)
    })()

    await waitFor(drivers.lookupEntered, 'expected the driver lookup to start')
    controller.abort()
    drivers.releaseLookup()
    await consumed

    assert.equal(
        drivers.streamCalls,
        0,
        `a cancel inside forAgent must still stop the dispatch; got ${JSON.stringify(events)}`
    )
    assert.equal(drivers.abortCalls, 0)
    assert.deepEqual(
        events.map((ev) => ev.type),
        ['error']
    )
    assert.equal(
        events[0].type === 'error' && events[0].error.code,
        'openclaw_aborted'
    )
})

// WHY: blast radius of the no-start fix. Once the exec IS running, a cancel has
// to tear it down — exactly once, since a second abort on a finished handle is
// a driver call for a turn that no longer exists.
test('a cancel after dispatch aborts the running exec exactly once', async () => {
    const drivers = makeDrivers({ settleOn: 'abort' })
    const adapter = buildAdapter(drivers)
    const controller = new AbortController()

    const events: EmittedChatEvent[] = []
    const consumed = (async () => {
        for await (const ev of adapter.sendMessage(
            ctx(controller.signal),
            userMessage
        ))
            events.push(ev)
    })()

    await waitFor(
        () => drivers.streamCalls === 1,
        'expected the exec to be dispatched'
    )
    controller.abort()
    await consumed

    assert.equal(drivers.streamCalls, 1)
    assert.equal(
        drivers.abortCalls,
        1,
        'the running exec must be torn down once and only once'
    )
})

test('a completed daemon exec releases its abort listener', async () => {
    const drivers = makeDrivers()
    const controller = new AbortController()
    const events: EmittedChatEvent[] = []

    for await (const ev of buildAdapter(drivers).sendMessage(
        ctx(controller.signal),
        userMessage
    ))
        events.push(ev)
    controller.abort()

    assert.equal(drivers.streamCalls, 1)
    assert.equal(drivers.abortCalls, 0)
    assert.ok(events.some((ev) => ev.type === 'done'))
})
