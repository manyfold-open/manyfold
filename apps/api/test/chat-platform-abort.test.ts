import { readyChatRunner, withRunnerCursors } from './chat-runner-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'
import {
    A2A_TURN_TIMEOUT_CODE,
    TurnAbortReason
} from '../src/modules/chat/turn-abort-reason'

// A stop the platform makes (the A2A cap) passes a TurnAbortReason to the
// turn's controller, and the terminal must carry it. Without one every abort
// read as the user's: cancelled_by_user, rendered by the web as a silent stop.
// These drive the real runAdapter / runAdapterFromIterable loops over fake
// infrastructure, one case per way an adapter reports an abort.

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

const BOUND_MS = 4_000

const platformStop = (): TurnAbortReason =>
    new TurnAbortReason(
        A2A_TURN_TIMEOUT_CODE,
        'the A2A task that started this turn reached its 7200s detached cap, so the turn was stopped',
        false
    )

// How the adapter reports the abort once it sees it: the cancel error the
// claude-code family yields, codex/gemini's throwIfAborted() (which throws the
// signal's reason), or a stream that just ends.
type AbortReport = 'report-cancel' | 'throw-reason' | 'silent'

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

const errorOf = (
    event: { payload: unknown } | undefined
): { code?: string; message?: string; retryable?: boolean } | null =>
    (event?.payload as { error?: Record<string, unknown> } | undefined)
        ?.error ?? null

const untilAborted = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve) => {
        if (!signal || signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
    })

const makeHarness = (report: AbortReport) => {
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
    const telemetry: Array<{ name: string; props: unknown }> = []
    const telemetryErrors: Array<{ name: string; error: Error }> = []
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
        getMessageById: async (id: string) => ({
            id,
            sessionId: sessionRow.id,
            role: 'assistant'
        }),
        insertMessage: async (row: { id: string; role: string }) => {
            insertedMessages.push(row)
            if (row.role === 'assistant') latestInflight = row.id
            return row
        },
        listMessages: async () => insertedMessages,
        latestInflightMessageId: async () => latestInflight,
        claimInflightTurn: async () => ({
            ok: true,
            frameworkSessionRef: null,
            runtimeSyncCursor: null
        }),
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
    const record = async (
        _messageId: string,
        event: { type: string; payload: unknown }
    ): Promise<{ persisted: boolean }> => {
        emitted.push(event)
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
            yield { type: 'token', text: 'partial' }
            adapterStartedResolve()
            await untilAborted(ctx.abortSignal)
            if (report === 'throw-reason') ctx.abortSignal?.throwIfAborted()
            if (report === 'report-cancel')
                yield {
                    type: 'error',
                    error: {
                        code: 'cancelled_by_user',
                        message: 'Cancelled by user',
                        retryable: false
                    }
                }
        }
    }

    const service = new ChatService(db as never,
        withRunnerCursors(repo as never),
        broadcaster as never,
        { get: () => adapter } as never,
        {} as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, props: unknown) =>
                telemetry.push({ name, props }),
            error: (name: string, error: Error) =>
                telemetryErrors.push({ name, error })
        } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        readyChatRunner(undefined)
    )

    const internals = service as unknown as {
        runAdapter: (...args: unknown[]) => Promise<void>
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
        emitted,
        telemetry,
        telemetryErrors,
        cancelRequested,
        adapterStarted,
        adapterFinished,
        latestInflight: () => latestInflight,
        trackRunningAdapter: (messageId: string, controller: AbortController) =>
            internals.trackRunningAdapter(messageId, controller),
        runAdapterFromIterable: (
            events: AsyncIterable<EmittedChatEvent>,
            messageId: string,
            abortSignal: AbortSignal
        ) => {
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
                { startedAt: Date.now(), via: 'resume' }
            )
        }
    }
}

for (const report of ['report-cancel', 'throw-reason', 'silent'] as const) {
    test(`a platform stop ends the turn with its own code (adapter: ${report})`, async () => {
        const stop = keepLoopAlive()
        const h = makeHarness(report)
        try {
            const sent = await h.service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hello'
            )
            await h.adapterStarted
            await h.service.cancelMessage(
                'user-1',
                'agent-1',
                sent.assistantMessageId,
                platformStop()
            )
            assert.ok(await settledWithin(h.adapterFinished, BOUND_MS))

            assert.deepEqual(
                h.emitted.map((event) => event.type),
                ['token', 'error']
            )
            const error = errorOf(h.emitted.at(-1))
            assert.equal(error?.code, A2A_TURN_TIMEOUT_CODE)
            assert.equal(error?.retryable, false)
            assert.match(error?.message ?? '', /detached cap/)
            assert.equal(h.latestInflight(), null)

            const terminal = h.telemetry.find(
                (event) => event.name === 'chat.turn.terminal'
            )
            assert.deepEqual(
                {
                    outcome: (terminal?.props as { outcome?: string })
                        ?.outcome,
                    errorCode: (terminal?.props as { errorCode?: string })
                        ?.errorCode
                },
                { outcome: 'error', errorCode: A2A_TURN_TIMEOUT_CODE }
            )
            assert.ok(
                h.telemetryErrors.some(
                    (event) => event.name === 'chat.stream.error'
                ),
                'a platform stop is a failure the funnel counts, not a cancel'
            )
        } finally {
            stop()
        }
    })
}

test('a cancel without a reason is still the user cancel', async () => {
    const stop = keepLoopAlive()
    const h = makeHarness('report-cancel')
    try {
        const sent = await h.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await h.adapterStarted
        await h.service.cancelMessage(
            'user-1',
            'agent-1',
            sent.assistantMessageId
        )
        assert.ok(await settledWithin(h.adapterFinished, BOUND_MS))

        assert.equal(errorOf(h.emitted.at(-1))?.code, 'cancelled_by_user')
        assert.equal(
            h.telemetryErrors.some(
                (event) => event.name === 'chat.stream.error'
            ),
            false
        )
    } finally {
        stop()
    }
})

test('the resume/adoption loop ends a platform stop with its code, whether the stream reports or throws', async () => {
    const stop = keepLoopAlive()
    try {
        for (const shape of ['yields', 'throws'] as const) {
            const h = makeHarness('silent')
            const messageId = `msg-resume-${shape}`
            const controller = new AbortController()
            h.trackRunningAdapter(messageId, controller)

            async function* resumed(): AsyncIterable<EmittedChatEvent> {
                yield { type: 'token', text: 'partial' }
                await untilAborted(controller.signal)
                if (shape === 'throws')
                    throw new Error('exec stream torn down')
                yield {
                    type: 'error',
                    error: {
                        code: 'claude_exec_failed',
                        message: 'exec aborted',
                        retryable: true
                    }
                }
            }

            const run = h.runAdapterFromIterable(
                resumed(),
                messageId,
                controller.signal
            )
            await new Promise((resolve) => setImmediate(resolve))
            await h.service.cancelMessage(
                'user-1',
                'agent-1',
                messageId,
                platformStop()
            )
            assert.ok(await settledWithin(run, BOUND_MS), shape)
            const outcome = await run

            assert.equal(outcome.outcome, 'error', shape)
            assert.equal(outcome.errorCode, A2A_TURN_TIMEOUT_CODE, shape)
            assert.equal(
                errorOf(h.emitted.at(-1))?.code,
                A2A_TURN_TIMEOUT_CODE,
                shape
            )
            assert.equal(h.latestInflight(), null, shape)
        }
    } finally {
        stop()
    }
})

// The documented trade-off: the peer NOTIFY and cancel_requested_at carry no
// reason, so a turn this instance does not run falls back to the generic cancel.
test('a platform stop for a turn running elsewhere falls back to the durable cancel', async () => {
    const h = makeHarness('silent')
    await h.service.cancelMessage(
        'user-1',
        'agent-1',
        'msg-on-a-peer',
        platformStop()
    )
    assert.deepEqual([...h.cancelRequested], ['msg-on-a-peer'])
})
