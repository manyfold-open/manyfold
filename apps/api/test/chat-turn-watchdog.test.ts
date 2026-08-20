import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'
import type { TurnBudgets } from '../src/modules/chat/turn-budgets'

// #668. An adapter iterator parked forever on next() used to hold the session's
// inflight claim, the runningAdapters entry, the sprite awake hold and the lease
// renew timer until the next deploy — every existing backstop deliberately steps
// around a turn that is live in THIS process. These drive the real runAdapter /
// runAdapterFromIterable loops over fake infrastructure, because the property
// under test is which terminal the catch path picks and in what order it does
// the two writes.
//
// The budgets are injected through the service's own turnBudgets() seam rather
// than through env: MF_TURN_IDLE_TIMEOUT_MS has a 60s floor (a watchdog you can
// set to half a second is a truncator, #556), and asserting BEHAVIOUR through
// that floor would mean a 60s test. The floor itself, and the env parsing it
// guards, are proven in turn-budgets.test.ts. The one env-driven case here is
// the off switch, which the floor does not touch.

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    runtimeId: 'runtime-1',
    model: null
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

// Two idle budgets plus slack. A regression fails on the assertion instead of
// hanging the suite, which is the whole point of a bounded wait here: on
// unfixed code the parked turn never terminalizes at all.
const BOUND_MS = 4_000
const IDLE_MS = 150
const TOTAL_MS = 400
const OFF_SWITCH_OBSERVATION_MS = IDLE_MS * 2

// Every watchdog timer is unref'd so a hung turn can never keep a process
// alive; in production the HTTP server holds the loop open, and a test whose
// only other handle is a promise that never settles has to do it itself.
const keepLoopAlive = (): (() => void) => {
    const timer = setInterval(() => {}, 1_000)
    return () => clearInterval(timer)
}

const settledWithin = async (
    promise: Promise<unknown>,
    ms: number
): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
    })
    try {
        return await Promise.race([
            promise.then(
                () => true,
                () => true
            ),
            expiry
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const errorCodeOf = (event: { payload: unknown } | undefined): string | null =>
    (event?.payload as { error?: { code?: string } } | undefined)?.error
        ?.code ?? null

const errorRetryableOf = (
    event: { payload: unknown } | undefined
): boolean | null =>
    (event?.payload as { error?: { retryable?: boolean } } | undefined)?.error
        ?.retryable ?? null

type AdapterScript =
    | 'park-after-token'
    | 'trickle-forever'
    | 'trickle-then-done'
    | 'suspend'
    | 'cancellable'

interface HarnessOptions {
    script: AdapterScript
    budgets?: TurnBudgets
}

test('a turn whose adapter parks terminalizes turn_idle_timeout, not a cancel', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({
        script: 'park-after-token',
        budgets: { idleTimeoutMs: IDLE_MS, maxDurationMs: 0 }
    })
    try {
        const sent = await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await harness.adapterStarted
        assert.equal(harness.emittedTypes(), 'token')
        assert.equal(
            harness.latestInflight(),
            sent.assistantMessageId,
            'the claim is held while the turn is live'
        )

        assert.ok(
            await settledWithin(harness.adapterFinished, BOUND_MS),
            `a parked turn must terminalize inside ${BOUND_MS}ms`
        )

        const terminal = harness.emitted.at(-1)
        assert.equal(harness.emittedTypes(), 'token,error')
        assert.equal(errorCodeOf(terminal), 'turn_idle_timeout')
        assert.equal(
            errorRetryableOf(terminal),
            true,
            'the user must be able to resend'
        )
        assert.notEqual(
            errorCodeOf(terminal),
            'cancelled_by_user',
            'a watchdog kill is not a user cancel'
        )
        assert.match(
            (terminal?.payload as { error: { message: string } }).error.message,
            /idle budget/
        )
        assert.equal(
            harness.latestInflight(),
            null,
            'the timeout terminal must release the inflight claim'
        )
        assert.equal(
            harness.runningAdapterPresent(sent.assistantMessageId),
            false
        )
    } finally {
        stop()
    }
})

test('the transport is aborted only AFTER the terminal is durable', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({
        script: 'park-after-token',
        budgets: { idleTimeoutMs: IDLE_MS, maxDurationMs: 0 }
    })
    try {
        await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await harness.adapterStarted
        assert.ok(await settledWithin(harness.adapterFinished, BOUND_MS))

        // The claim release and the turn_executions close ride the terminal's
        // own transaction; aborting first would raise abortSignal.aborted before
        // that write, which is exactly what mislabels the turn.
        assert.deepEqual(harness.timeline, [
            'emit:token',
            'emit:error',
            'abort'
        ])
    } finally {
        stop()
    }
})

test('the terminal funnel reports a timeout as an error carrying its kind', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({
        script: 'park-after-token',
        budgets: { idleTimeoutMs: IDLE_MS, maxDurationMs: 0 }
    })
    try {
        await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await harness.adapterStarted
        assert.ok(await settledWithin(harness.adapterFinished, BOUND_MS))

        const terminals = harness.telemetry.filter(
            (e) => e.name === 'chat.turn.terminal'
        )
        assert.equal(terminals.length, 1)
        const props = terminals[0].props as {
            outcome: string
            errorCode?: string
        }
        assert.equal(props.outcome, 'error')
        assert.notEqual(props.outcome, 'cancelled')
        assert.equal(
            props.errorCode,
            'turn_idle_timeout',
            'the budget kind must survive the funnel'
        )
        // The elapsed/budget numbers ride the Error itself into the stream
        // error funnel, so no separate event is needed to diagnose one.
        const streamErrors = harness.telemetryErrors.filter(
            (e) => e.name === 'chat.stream.error'
        )
        assert.equal(streamErrors.length, 1)
        assert.match(streamErrors[0].error.message, /idle budget \d+s/)
    } finally {
        stop()
    }
})

test('a turn that keeps streaming past the wall clock gets turn_max_duration', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({
        script: 'trickle-forever',
        // Idle off: whatever ends this turn can only be the total budget, since
        // events never stop arriving.
        budgets: { idleTimeoutMs: 0, maxDurationMs: TOTAL_MS }
    })
    try {
        await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await harness.adapterStarted
        assert.ok(await settledWithin(harness.adapterFinished, BOUND_MS))

        const terminal = harness.emitted.at(-1)
        assert.equal(errorCodeOf(terminal), 'turn_max_duration')
        assert.equal(errorRetryableOf(terminal), true)
        assert.equal(harness.latestInflight(), null)
        assert.equal(harness.timeline.at(-1), 'abort')
        assert.equal(harness.timeline.at(-2), 'emit:error')
    } finally {
        // On unfixed code this adapter drives itself forever; without the
        // cancel the assertions above would fail and then the process would
        // never exit, which reads as "the suite hangs" rather than "the
        // watchdog is missing".
        await harness.service
            .cancelStream('user-1', 'agent-1', 'session-1')
            .catch(() => undefined)
        await settledWithin(harness.adapterFinished, BOUND_MS)
        stop()
    }
})

// Blast-radius control. If the classification order were wrong this stays green
// while the timeout tests go red, and vice versa — the two failures are not
// interchangeable.
test('a genuine user cancel is still cancelled_by_user with the watchdog armed', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({
        script: 'cancellable',
        budgets: { idleTimeoutMs: 30_000, maxDurationMs: 60_000 }
    })
    try {
        await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await harness.adapterStarted
        await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
        assert.ok(await settledWithin(harness.adapterFinished, BOUND_MS))

        const terminal = harness.emitted.at(-1)
        assert.equal(errorCodeOf(terminal), 'cancelled_by_user')
        assert.equal(errorRetryableOf(terminal), false)
        assert.equal(harness.latestInflight(), null)
    } finally {
        stop()
    }
})

// Control: the watchdog must be invisible to the path that hands the turn back
// to a runner. A suspended turn KEEPS its claim on purpose.
test('a suspended turn is untouched by the watchdog and keeps its claim', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({
        script: 'suspend',
        budgets: { idleTimeoutMs: IDLE_MS, maxDurationMs: TOTAL_MS }
    })
    try {
        const sent = await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        assert.ok(await settledWithin(harness.adapterFinished, BOUND_MS))
        // Well past both budgets: a watchdog timer left armed by the break path
        // would fire in here.
        await new Promise((resolve) => setTimeout(resolve, TOTAL_MS + 200))

        assert.equal(harness.emittedTypes(), 'token,suspended')
        assert.equal(
            harness.latestInflight(),
            sent.assistantMessageId,
            'a suspended turn keeps its inflight claim for the next owner'
        )
        assert.equal(
            harness.telemetry.filter((e) => e.name === 'chat.turn.terminal')
                .length,
            0
        )
        assert.ok(!harness.timeline.includes('abort'))
    } finally {
        stop()
    }
})

test('a live but slow stream is never killed: every event rearms the budget', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({
        script: 'trickle-then-done',
        // Eight 25ms gaps run ~200ms, comfortably past the idle budget in total
        // but never within one gap.
        budgets: { idleTimeoutMs: IDLE_MS, maxDurationMs: 0 }
    })
    try {
        await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        assert.ok(await settledWithin(harness.adapterFinished, BOUND_MS))

        const terminal = harness.emitted.at(-1)
        assert.equal(terminal?.type, 'done')
        assert.equal(
            harness.emitted.filter((e) => e.type === 'error').length,
            0
        )
        assert.ok(!harness.timeline.includes('abort'))
    } finally {
        stop()
    }
})

// The off switch, driven through the real env path (0 is the one value the
// floor never rewrites). Inverse control for the first test: same parked
// adapter, same bounded wait, opposite outcome.
test('MF_TURN_IDLE_TIMEOUT_MS=0 leaves a parked turn running', async () => {
    const stop = keepLoopAlive()
    const savedIdle = process.env.MF_TURN_IDLE_TIMEOUT_MS
    const savedMax = process.env.MF_TURN_MAX_DURATION_MS
    process.env.MF_TURN_IDLE_TIMEOUT_MS = '0'
    process.env.MF_TURN_MAX_DURATION_MS = '0'
    const harness = makeHarness({ script: 'park-after-token' })
    try {
        const sent = await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await harness.adapterStarted
        assert.equal(
            await settledWithin(
                harness.adapterFinished,
                OFF_SWITCH_OBSERVATION_MS
            ),
            false,
            'a disabled watchdog must not terminalize a parked turn'
        )
        assert.equal(harness.emittedTypes(), 'token')
        assert.equal(harness.latestInflight(), sent.assistantMessageId)

        // Leave nothing running behind the test.
        await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
        assert.ok(await settledWithin(harness.adapterFinished, BOUND_MS))
    } finally {
        if (savedIdle === undefined) delete process.env.MF_TURN_IDLE_TIMEOUT_MS
        else process.env.MF_TURN_IDLE_TIMEOUT_MS = savedIdle
        if (savedMax === undefined) delete process.env.MF_TURN_MAX_DURATION_MS
        else process.env.MF_TURN_MAX_DURATION_MS = savedMax
        stop()
    }
})

// The resume/adoption loop had no catch at all, so a budget breach there would
// have escaped to callers that only know how to release the claim — no terminal,
// no telemetry, and the turn invisible to every later recovery attempt.
test('the resume/adoption loop gets the same budget and the same ordering', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({ script: 'park-after-token' })
    try {
        const messageId = 'msg-resume-1'
        const controller = new AbortController()
        controller.signal.addEventListener('abort', () =>
            harness.timeline.push('abort')
        )
        harness.trackRunningAdapter(messageId, controller)
        harness.setBudgets({ idleTimeoutMs: IDLE_MS, maxDurationMs: 0 })

        async function* parked(): AsyncIterable<EmittedChatEvent> {
            yield { type: 'token', text: 'hi' }
            await new Promise<void>(() => {})
        }

        const run = harness.runAdapterFromIterable(
            parked(),
            messageId,
            controller.signal
        )
        assert.ok(
            await settledWithin(run, BOUND_MS),
            `a parked resume must terminalize inside ${BOUND_MS}ms`
        )
        const outcome = await run

        assert.equal(outcome.suspended, false)
        assert.equal(outcome.outcome, 'error')
        assert.equal(outcome.errorCode, 'turn_idle_timeout')
        assert.equal(errorCodeOf(harness.emitted.at(-1)), 'turn_idle_timeout')
        assert.equal(errorRetryableOf(harness.emitted.at(-1)), true)
        assert.equal(harness.latestInflight(), null)
        assert.deepEqual(harness.timeline, [
            'emit:token',
            'emit:error',
            'abort'
        ])
        const terminals = harness.telemetry.filter(
            (e) => e.name === 'chat.turn.terminal'
        )
        assert.equal(terminals.length, 1)
        assert.equal(
            (terminals[0].props as { errorCode?: string }).errorCode,
            'turn_idle_timeout'
        )
        assert.equal(
            (terminals[0].props as { via?: string }).via,
            'resume',
            'the recovery funnel still has to say where the terminal came from'
        )
    } finally {
        stop()
    }
})

// The continuation half of the same contract. `opts.startedAt` is the durable
// turn origin (message.createdAt) and the total budget is measured from it, so
// a deploy, a daemon resume or an adoption continues the turn's one deadline
// instead of issuing a new one.

// Events forever, so nothing but the wall clock can end these turns.
const trickleForever = (
    onPull?: () => void
): AsyncIterable<EmittedChatEvent> => {
    async function* gen(): AsyncIterable<EmittedChatEvent> {
        onPull?.()
        for (let i = 0; ; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            yield { type: 'token', text: `t${i}` }
        }
    }
    return gen()
}

test('a continuation already past its durable deadline terminalizes turn_max_duration at once', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({ script: 'park-after-token' })
    try {
        const messageId = 'msg-resume-exhausted'
        const controller = new AbortController()
        controller.signal.addEventListener('abort', () =>
            harness.timeline.push('abort')
        )
        harness.trackRunningAdapter(messageId, controller)
        harness.setBudgets({ idleTimeoutMs: 0, maxDurationMs: TOTAL_MS })
        let pulled = false

        const at = Date.now()
        const outcome = await harness.runAdapterFromIterable(
            trickleForever(() => {
                pulled = true
            }),
            messageId,
            controller.signal,
            // Ten budgets old: whatever process was streaming this turn before,
            // it is long past the cap.
            at - TOTAL_MS * 10
        )
        const wallMs = Date.now() - at

        assert.equal(outcome.outcome, 'error')
        assert.equal(outcome.errorCode, 'turn_max_duration')
        assert.equal(errorRetryableOf(harness.emitted.at(-1)), true)
        assert.ok(
            wallMs < TOTAL_MS / 2,
            `an exhausted continuation must not stream for another budget (took ${wallMs}ms)`
        )
        assert.equal(
            pulled,
            false,
            'a turn over its deadline must not reopen the transport'
        )
        // Same funnel and same order as a live breach: the terminal releases
        // the claim and closes turn_executions, and only then is the transport
        // torn down.
        assert.deepEqual(harness.timeline, ['emit:error', 'abort'])
        assert.equal(harness.latestInflight(), null)
        const terminals = harness.telemetry.filter(
            (e) => e.name === 'chat.turn.terminal'
        )
        assert.equal(terminals.length, 1)
        assert.equal(
            (terminals[0].props as { errorCode?: string }).errorCode,
            'turn_max_duration'
        )
        assert.equal((terminals[0].props as { via?: string }).via, 'resume')
    } finally {
        stop()
    }
})

test('a continuation near its durable deadline gets only the time that is left', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({ script: 'park-after-token' })
    const TOTAL = 2_000
    try {
        const messageId = 'msg-resume-near-deadline'
        const controller = new AbortController()
        harness.trackRunningAdapter(messageId, controller)
        harness.setBudgets({ idleTimeoutMs: 0, maxDurationMs: TOTAL })

        const run = harness.runAdapterFromIterable(
            trickleForever(),
            messageId,
            controller.signal,
            Date.now() - (TOTAL - 200)
        )
        assert.ok(
            await settledWithin(run, 1_000),
            `a turn resumed 200ms short of its deadline must end there, not ${TOTAL}ms later`
        )
        const outcome = await run
        assert.equal(outcome.errorCode, 'turn_max_duration')
        assert.equal(harness.latestInflight(), null)
    } finally {
        stop()
    }
})

// The reset loop this closes: 1h59m, resume for another 2h, resume again…
test('re-running the same durable turn does not hand it another full budget', async () => {
    const stop = keepLoopAlive()
    const harness = makeHarness({ script: 'park-after-token' })
    const TOTAL = 900
    try {
        const messageId = 'msg-resume-rewrapped'
        const controller = new AbortController()
        harness.trackRunningAdapter(messageId, controller)
        harness.setBudgets({ idleTimeoutMs: 0, maxDurationMs: TOTAL })
        const origin = Date.now() - (TOTAL - 200)

        const first = await harness.runAdapterFromIterable(
            trickleForever(),
            messageId,
            controller.signal,
            origin
        )
        assert.equal(first.errorCode, 'turn_max_duration')

        // The redeploy: a brand new wrapper, the same durable turn.
        const secondController = new AbortController()
        harness.trackRunningAdapter(messageId, secondController)
        const at = Date.now()
        const second = await harness.runAdapterFromIterable(
            trickleForever(),
            messageId,
            secondController.signal,
            origin
        )
        const secondMs = Date.now() - at

        assert.equal(second.errorCode, 'turn_max_duration')
        assert.ok(
            secondMs < 200,
            `the second continuation must inherit a spent budget, not restart it (ran ${secondMs}ms)`
        )
        assert.equal(harness.latestInflight(), null)
    } finally {
        stop()
    }
})

interface TelemetryEvent {
    name: string
    props: unknown
}

interface TelemetryError {
    name: string
    error: Error
}

const makeHarness = (
    opts: HarnessOptions
): {
    service: ChatService
    telemetry: TelemetryEvent[]
    telemetryErrors: TelemetryError[]
    emitted: Array<{ type: string; payload: unknown }>
    emittedTypes: () => string
    timeline: string[]
    latestInflight: () => string | null
    runningAdapterPresent: (messageId: string) => boolean
    trackRunningAdapter: (
        messageId: string,
        controller: AbortController
    ) => void
    setBudgets: (budgets: TurnBudgets) => void
    runAdapterFromIterable: (
        events: AsyncIterable<EmittedChatEvent>,
        messageId: string,
        abortSignal: AbortSignal,
        startedAt?: number
    ) => Promise<{
        suspended: boolean
        outcome: string
        errorCode: string | null
    }>
    adapterStarted: Promise<void>
    adapterFinished: Promise<void>
} => {
    const insertedMessages: Array<{ id: string; role: string }> = []
    let latestInflight: string | null = null
    let adapterStartedResolve!: () => void
    let adapterFinishedResolve!: () => void
    const adapterStarted = new Promise<void>((r) => {
        adapterStartedResolve = r
    })
    const adapterFinished = new Promise<void>((r) => {
        adapterFinishedResolve = r
    })
    const emitted: Array<{ type: string; payload: unknown }> = []
    // One ordered log for BOTH durable writes and aborts: the ordering claim is
    // the point of this fix, and two separate arrays cannot express it.
    const timeline: string[] = []
    const telemetry: TelemetryEvent[] = []
    const telemetryErrors: TelemetryError[] = []
    const cancelRequested = new Set<string>()

    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: () => ({ limit: async () => [agentRow] })
                }),
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({
            set: () => ({ where: async () => undefined })
        })
    }
    const repo = {
        listOrphanedAssistantMessages: async () => [],
        getSession: async () => sessionRow,
        getSessionById: async () => sessionRow,
        insertMessage: async (row: { id: string; role: string }) => {
            insertedMessages.push(row)
            if (row.role === 'assistant') latestInflight = row.id
            return row
        },
        listMessages: async () => insertedMessages,
        latestInflightMessageId: async () => latestInflight,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        upsertMessageSources: async (rows: unknown[]) => ({
            upserted: rows.length
        }),
        insertStreamEvent: async () => undefined,
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined,
        clearStaleInflightClaims: async () => 0,
        maxStreamEventSeq: async () => 0n,
        markCancelRequested: async (messageId: string) => {
            cancelRequested.add(messageId)
        },
        findCancelRequestedMessageIds: async (messageIds: string[]) =>
            messageIds.filter((id) => cancelRequested.has(id))
    }
    // Stands in for insertStreamEvent's transaction: a durable terminal releases
    // the claim, and nothing else does.
    const record = async (
        _messageId: string,
        event: { type: string; payload: unknown }
    ): Promise<{ persisted: boolean }> => {
        emitted.push(event)
        timeline.push(`emit:${event.type}`)
        if (event.type === 'done' || event.type === 'error')
            latestInflight = null
        return { persisted: true }
    }
    const broadcaster = {
        beginStream: () => undefined,
        setStreamFence: () => undefined,
        beginResumeStream: async () => undefined,
        endStream: () => undefined,
        hasStream: () => true,
        emit: record,
        emitDetached: record
    }

    const adapter = {
        sendMessage: async function* (
            ctx: ApiChatAdapterContext
        ): AsyncIterable<EmittedChatEvent> {
            ctx.abortSignal?.addEventListener(
                'abort',
                () => timeline.push('abort'),
                { once: true }
            )
            if (opts.script === 'suspend') {
                yield { type: 'token', text: 'hi' }
                yield {
                    type: 'suspended',
                    daemonId: 'daemon-1',
                    daemonExecRef: ctx.messageId,
                    reason: 'daemon_owns_turn'
                }
                return
            }
            yield { type: 'token', text: 'hi' }
            adapterStartedResolve()
            if (opts.script === 'park-after-token') {
                await new Promise<void>((resolve) => {
                    if (ctx.abortSignal?.aborted) {
                        resolve()
                        return
                    }
                    ctx.abortSignal?.addEventListener(
                        'abort',
                        () => resolve(),
                        {
                            once: true
                        }
                    )
                })
                return
            }
            if (opts.script === 'trickle-forever') {
                // Honours the abort so that on UNFIXED code, where nothing ends
                // this turn, the test's own cleanup can stop it — otherwise a
                // prove-red run reports its failures and then hangs on a
                // self-driving adapter instead of exiting.
                for (let i = 0; !ctx.abortSignal?.aborted; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 20))
                    yield { type: 'token', text: `t${i}` }
                }
                return
            }
            if (opts.script === 'trickle-then-done') {
                for (let i = 0; i < 8; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 25))
                    yield { type: 'token', text: `t${i}` }
                }
                yield { type: 'done', finalMessageId: ctx.messageId }
                return
            }
            // 'cancellable': block until the user cancels, like a real transport.
            try {
                await new Promise<void>((_resolve, reject) => {
                    if (ctx.abortSignal?.aborted) {
                        reject(new Error('cancelled_by_user'))
                        return
                    }
                    ctx.abortSignal?.addEventListener(
                        'abort',
                        () => reject(new Error('cancelled_by_user')),
                        { once: true }
                    )
                })
            } catch {
                yield {
                    type: 'error',
                    error: {
                        code: 'cancelled_by_user',
                        message: 'cancelled by user',
                        retryable: false
                    }
                }
                return
            }
            yield { type: 'done', finalMessageId: ctx.messageId }
        }
    }
    const adapters = { get: () => adapter }
    const files = { build: async () => ({ root: { id: 'workspace' } }) }

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        {} as never,
        files as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, props: unknown) =>
                telemetry.push({ name, props }),
            error: (name: string, error: Error) =>
                telemetryErrors.push({ name, error })
        } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never
    )

    const internals = service as unknown as {
        runAdapter: (...args: unknown[]) => Promise<void>
        turnBudgets: () => TurnBudgets
        trackRunningAdapter: (
            messageId: string,
            controller: AbortController
        ) => void
        runAdapterFromIterable: (
            events: AsyncIterable<EmittedChatEvent>,
            session: unknown,
            assistantMessageId: string,
            agentCtx: unknown,
            abortSignal: AbortSignal,
            opts: unknown
        ) => Promise<{
            suspended: boolean
            outcome: string
            errorCode: string | null
        }>
    }
    if (opts.budgets) {
        const budgets = opts.budgets
        internals.turnBudgets = () => budgets
    }
    const originalRun = internals.runAdapter.bind(service)
    internals.runAdapter = async (...args: unknown[]): Promise<void> => {
        try {
            await originalRun(...args)
        } finally {
            adapterFinishedResolve()
        }
    }

    return {
        service,
        telemetry,
        telemetryErrors,
        emitted,
        emittedTypes: () => emitted.map((e) => e.type).join(','),
        timeline,
        latestInflight: () => latestInflight,
        runningAdapterPresent: (messageId: string) =>
            (
                service as unknown as {
                    runningAdapters: Map<string, AbortController>
                }
            ).runningAdapters.has(messageId),
        trackRunningAdapter: (messageId, controller) =>
            internals.trackRunningAdapter(messageId, controller),
        setBudgets: (budgets: TurnBudgets) => {
            internals.turnBudgets = () => budgets
        },
        runAdapterFromIterable: (events, messageId, abortSignal, startedAt) => {
            latestInflight = messageId
            return internals.runAdapterFromIterable.call(
                service,
                events,
                sessionRow,
                messageId,
                {
                    framework: 'claude-code',
                    runtime: 'sprites',
                    runtimeId: 'runtime-1',
                    model: null,
                    modelProviderId: null,
                    modelProviderBuiltInId: null,
                    daemonId: null,
                    spriteName: 'sprite-1',
                    workspacePath: null
                },
                abortSignal,
                { startedAt: startedAt ?? Date.now(), via: 'resume' }
            )
        },
        adapterStarted,
        adapterFinished
    }
}
