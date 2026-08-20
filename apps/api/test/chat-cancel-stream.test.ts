import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatCancelBus } from '../src/modules/chat/chat-cancel-bus'
import { ChatService } from '../src/modules/chat/chat.service'

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

test('cancelStream aborts the running adapter and emits a terminal error', async () => {
    const harness = makeHarness()

    const sendPromise = harness.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    const sent = await sendPromise
    const messageId = sent.assistantMessageId

    await harness.adapterStarted

    assert.equal(harness.emittedTypes(), 'token')
    assert.ok(
        harness.runningAdapterPresent(messageId),
        'expected runningAdapters to track the message before cancel'
    )

    await harness.service.cancelStream('user-1', 'agent-1', 'session-1')

    await harness.adapterFinished
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(
        harness.emittedTypes(),
        'token,error',
        'cancel should produce a terminal error event'
    )
    const errorEvent = harness.emitted.at(-1)
    assert.equal(errorEvent?.type, 'error')
    assert.equal(
        (errorEvent?.payload as { error: { code: string } }).error.code,
        'cancelled_by_user'
    )
    assert.deepEqual(harness.persistedContentBlocks.at(-1), [
        { type: 'text', text: 'hi' }
    ])
    assert.equal(
        harness.latestInflight(),
        null,
        'terminal cancellation should clear the inflight message'
    )
    assert.equal(
        harness.runningAdapterPresent(messageId),
        false,
        'expected runningAdapters to be cleaned up after cancel'
    )
})

test('cancelStream is a no-op when no adapter is running', async () => {
    const harness = makeHarness({ skipSend: true })
    await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
    assert.equal(harness.emitted.length, 0)
})

test('a delayed cancel cannot target the turn that replaced its captured turn', async () => {
    const harness = makeHarness()
    const sent = await harness.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    await harness.adapterStarted

    await assert.rejects(
        harness.service.cancelStream(
            'user-1',
            'agent-1',
            'session-1',
            'obsolete-message-id'
        ),
        /assistant turn is no longer active/
    )
    await new Promise((resolve) => setImmediate(resolve))

    assert.ok(harness.runningAdapterPresent(sent.assistantMessageId))
    assert.equal(harness.emittedTypes(), 'token')

    await harness.service.cancelStream(
        'user-1',
        'agent-1',
        'session-1',
        sent.assistantMessageId
    )
    await harness.adapterFinished
})

test('sendMessage defaults Claude Code permission mode to bypassPermissions', async () => {
    const harness = makeHarness()

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await harness.adapterStarted

    assert.equal(
        harness.latestAdapterCtx()?.claudeCodePermissionMode,
        'bypassPermissions'
    )

    await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
    await harness.adapterFinished
})

test('sendMessage emits done when adapter finishes without a terminal event', async () => {
    const harness = makeHarness({ finishWithoutTerminal: true })

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await harness.adapterFinished

    assert.equal(
        harness.emittedTypes(),
        'token,done',
        'an implicit adapter finish must still terminalize the stream'
    )
    assert.deepEqual(harness.persistedContentBlocks.at(-1), [
        { type: 'text', text: 'hi' }
    ])
    assert.equal(
        harness.latestInflight(),
        null,
        'done must clear the message from refresh-time inflight detection'
    )
})

test('cancelStream normalizes adapter abort failures and preserves partial content', async () => {
    const harness = makeHarness({ abortBehavior: 'throw-transport-error' })

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await harness.adapterStarted

    await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
    await harness.adapterFinished

    assert.equal(harness.emittedTypes(), 'token,error')
    const errorEvent = harness.emitted.at(-1)
    assert.equal(errorEvent?.type, 'error')
    assert.equal(
        (errorEvent?.payload as { error: { code: string; retryable: boolean } })
            .error.code,
        'cancelled_by_user'
    )
    assert.equal(
        (errorEvent?.payload as { error: { retryable: boolean } }).error
            .retryable,
        false
    )
    assert.deepEqual(harness.persistedContentBlocks.at(-1), [
        { type: 'text', text: 'hi' }
    ])
    assert.equal(harness.latestInflight(), null)
})

test('raw_source events are cached but not broadcast to subscribers', async () => {
    const harness = makeHarness({ emitRawSource: true })

    const sent = await harness.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    await harness.adapterStarted

    assert.equal(harness.emittedTypes(), 'token')

    // Source rows batch on a short window; the write must land by the batch
    // timer (or the terminal flush) without ever reaching subscribers.
    const deadline = Date.now() + 1_000
    while (harness.rawSourceRows.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(sent.assistantMessageId, harness.rawSourceRows[0]?.messageId)
    assert.equal(harness.rawSourceRows.length, 1)
    assert.equal(harness.emittedTypes(), 'token')

    await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
    await harness.adapterFinished
})

test('raw_source cache write failure does not interrupt streaming', async () => {
    const harness = makeHarness({
        emitRawSource: true,
        failRawSourceWrite: true
    })

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await harness.adapterStarted

    assert.equal(harness.rawSourceRows.length, 0)
    assert.equal(harness.emittedTypes(), 'token')

    await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
    await harness.adapterFinished
})

// Two convergence ticks plus slack: the timer keeps the loop alive for the
// whole window, so a regression fails on this assertion instead of hanging.
const CONVERGENCE_BOUND_MS = 6_000

const settledWithin = async (
    promise: Promise<void>,
    ms: number
): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
    })
    try {
        return await Promise.race([promise.then(() => true), expiry])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

// #402 failure-path durability: a cancel that lands on a non-owner instance
// persists cancel_requested_at and then fire-and-forgets a pg NOTIFY. When that
// publish is rejected (or the owner's LISTEN is not up yet, or the connection
// drops) the owner never hears about it, and before this convergence path the
// turn ran to completion while the caller already had its 204. Nothing else
// reads the durable flag for an API-owned live turn — only the daemon resume
// path does.
test('a cancel whose NOTIFY is lost still converges the owner turn to cancelled_by_user', async () => {
    const harness = makeHarness()
    await harness.service.onApplicationBootstrap()
    try {
        const sent = await harness.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await harness.adapterStarted
        assert.ok(harness.runningAdapterPresent(sent.assistantMessageId))

        const cancelledAt = Date.now()
        await harness.peer.cancelStream('user-1', 'agent-1', 'session-1')
        assert.deepEqual(
            harness.peerTelemetry.map((e) => e.name),
            ['chat.cancel.broadcast'],
            'the peer must still take the durable + broadcast path'
        )
        assert.equal(
            harness.emittedTypes(),
            'token',
            'a lost NOTIFY must not have terminalized the turn yet'
        )

        const converged = await settledWithin(
            harness.adapterFinished,
            CONVERGENCE_BOUND_MS
        )
        assert.ok(
            converged,
            `the owner turn must converge within ${CONVERGENCE_BOUND_MS}ms of the durable mark`
        )
        await new Promise((resolve) => setImmediate(resolve))
        const convergedInMs = Date.now() - cancelledAt

        const terminal = harness.emitted.at(-1)
        assert.equal(harness.emittedTypes(), 'token,error')
        assert.equal(
            (terminal?.payload as { error: { code: string } }).error.code,
            'cancelled_by_user'
        )
        assert.deepEqual(
            harness.telemetry
                .map((e) => e.name)
                .filter((name) => name.startsWith('chat.cancel.')),
            ['chat.cancel.durable_converge'],
            'the owner must converge from the durable flag, not the bus'
        )
        // #638 parity: the converged terminal is still persisted-gated and
        // counted exactly once, as a cancel rather than an error.
        const terminals = harness.telemetry.filter(
            (e) => e.name === 'chat.turn.terminal'
        )
        assert.equal(terminals.length, 1)
        assert.equal(
            (terminals[0].props as { outcome: string }).outcome,
            'cancelled'
        )
        assert.ok(
            convergedInMs < CONVERGENCE_BOUND_MS,
            `convergence must stay inside the stated bound, took ${convergedInMs}ms`
        )
        assert.equal(harness.latestInflight(), null)
    } finally {
        await harness.service.onModuleDestroy()
    }
})

interface HarnessOptions {
    skipSend?: boolean
    emitRawSource?: boolean
    failRawSourceWrite?: boolean
    abortBehavior?: 'yield-cancel-error' | 'throw-transport-error'
    finishWithoutTerminal?: boolean
}

const makeHarness = (
    _opts: HarnessOptions = {}
): {
    service: ChatService
    peer: ChatService
    telemetry: Array<{ name: string; props: unknown }>
    peerTelemetry: Array<{ name: string; props: unknown }>
    emitted: Array<{ type: string; payload: unknown }>
    emittedTypes: () => string
    persistedContentBlocks: unknown[]
    rawSourceRows: Array<{ messageId: string | null }>
    latestInflight: () => string | null
    latestAdapterCtx: () => ApiChatAdapterContext | null
    runningAdapterPresent: (messageId: string) => boolean
    adapterStarted: Promise<void>
    adapterFinished: Promise<void>
} => {
    const insertedMessages: Array<{
        id: string
        sessionId: string
        role: string
        contentBlocksJson: unknown
        capabilityEventsJson: unknown
        createdAt: Date
    }> = []
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
    const persistedContentBlocks: unknown[] = []
    const rawSourceRows: Array<{ messageId: string | null }> = []
    const cancelRequested = new Set<string>()
    const telemetry: Array<{ name: string; props: unknown }> = []
    const peerTelemetry: Array<{ name: string; props: unknown }> = []
    let latestAdapterCtx: ApiChatAdapterContext | null = null

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agentRow]
                })
            })
        }),
        update: () => ({
            set: (values: { contentBlocksJson?: unknown }) => ({
                where: async () => {
                    if ('contentBlocksJson' in values)
                        persistedContentBlocks.push(values.contentBlocksJson)
                }
            })
        })
    }
    const repo = {
        listOrphanedAssistantMessages: async () => [],
        getSession: async () => sessionRow,
        insertMessage: async (row: {
            id: string
            sessionId: string
            role: string
            contentBlocksJson: unknown
            capabilityEventsJson: unknown
            createdAt: Date
        }) => {
            insertedMessages.push(row)
            if (row.role === 'assistant') latestInflight = row.id
            return row
        },
        listMessages: async () => insertedMessages,
        latestInflightMessageId: async () => latestInflight,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        upsertMessageSources: async (
            rows: Array<{ messageId: string | null }>
        ) => {
            if (_opts.failRawSourceWrite) throw new Error('cache unavailable')
            rawSourceRows.push(...rows)
            return { upserted: rows.length }
        },
        writeAssistantContent: async (_messageId: string, blocks: unknown) => {
            persistedContentBlocks.push(blocks)
            return true
        },
        insertStreamEvent: async () => undefined,
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined,
        clearStaleInflightClaims: async () => 0,
        markCancelRequested: async (messageId: string) => {
            cancelRequested.add(messageId)
        },
        findCancelRequestedMessageIds: async (messageIds: string[]) =>
            messageIds.filter((id) => cancelRequested.has(id))
    }
    const record = async (
        _messageId: string,
        event: { type: string; payload: unknown },
        terminalContent?: {
            contentBlocksJson: unknown
            contentCheckpointEventId: bigint | null
        }
    ): Promise<{ persisted: boolean }> => {
        emitted.push(event)
        if (event.type === 'done' || event.type === 'error') {
            latestInflight = null
            if (terminalContent)
                persistedContentBlocks.push(terminalContent.contentBlocksJson)
        }
        return { persisted: true }
    }
    const broadcaster = {
        setStreamFence: () => undefined,
        beginStream: () => undefined,
        emit: record,
        emitDetached: async (
            messageId: string,
            event: { type: string; payload: unknown }
        ) => {
            await record(messageId, event)
            return true
        }
    }
    const adapter = {
        sendMessage: async function* (
            ctx: ApiChatAdapterContext
        ): AsyncIterable<EmittedChatEvent> {
            latestAdapterCtx = ctx
            if (_opts.emitRawSource)
                yield {
                    type: 'raw_source',
                    source: {
                        sourceRef: 'runtime-session-1',
                        sourceSeq: 1,
                        externalId: 'raw-1',
                        parentExternalId: null,
                        rawFormat: 'jsonl',
                        rawText: '{"type":"message"}',
                        parserName: 'test-stream-jsonl',
                        parserVersion: '1'
                    }
                }
            yield { type: 'token', text: 'hi' }
            adapterStartedResolve()
            if (_opts.finishWithoutTerminal) return
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
            } catch (err) {
                if (_opts.abortBehavior === 'throw-transport-error')
                    throw new Error('transport aborted')
                yield {
                    type: 'error',
                    error: {
                        code: 'cancelled_by_user',
                        message: (err as Error).message,
                        retryable: false
                    }
                }
                return
            }
            yield { type: 'done', finalMessageId: ctx.messageId }
        }
    }
    const adapters = { get: () => adapter }
    const files = {
        build: async () => ({
            root: { id: 'workspace' }
        })
    }

    // A pg client whose publish always rejects: the real ChatCancelBus logs and
    // swallows it, which is exactly the silent loss under test.
    const rejectingPgClient = {
        listen: async () => ({ unlisten: async () => {} }),
        notify: async () => {
            throw new Error('bus publish rejected')
        }
    }
    const ownerBus = new ChatCancelBus({
        $client: rejectingPgClient
    } as never)
    // A separate instance, as in production: the peer's NOTIFY would have to
    // travel through postgres to reach the owner's listener, and it never does.
    const peerBus = new ChatCancelBus({ $client: rejectingPgClient } as never)

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
                telemetry.push({ name, props })
        } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ownerBus
    )
    const peer = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        {} as never,
        files as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, props: unknown) =>
                peerTelemetry.push({ name, props })
        } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        peerBus
    )

    const originalRun = (
        service as unknown as {
            runAdapter: (...args: unknown[]) => Promise<void>
        }
    ).runAdapter.bind(service)
    ;(
        service as unknown as {
            runAdapter: (...args: unknown[]) => Promise<void>
        }
    ).runAdapter = async (...args: unknown[]): Promise<void> => {
        try {
            await originalRun(...args)
        } finally {
            adapterFinishedResolve()
        }
    }

    return {
        service,
        peer,
        telemetry,
        peerTelemetry,
        emitted,
        persistedContentBlocks,
        rawSourceRows,
        latestInflight: () => latestInflight,
        latestAdapterCtx: () => latestAdapterCtx,
        emittedTypes: () => emitted.map((e) => e.type).join(','),
        runningAdapterPresent: (messageId: string) =>
            (
                service as unknown as {
                    runningAdapters: Map<string, AbortController>
                }
            ).runningAdapters.has(messageId),
        adapterStarted,
        adapterFinished
    }
}
