import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatContentBlock, ChatStreamEvent } from '@manyfold/shared'
import {
    chatStreamStore,
    type ReplayCheckpoint,
    type StartStreamParams
} from '../src/lib/chatStreamStore'
import { streamingBlocksToContentBlocks } from '../src/components/chat/utils/streamingBlocks'
import { recoveryLabelKey } from '../src/components/chat/utils/recoveryLabel'

const key = chatStreamStore.keyOf('agent-1', 'session-1')
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const encoder = new TextEncoder()
// Mirrors STALL_HINT_MS in the store: the silence deadline is identified by its
// delay, so the harness can hold it and fire it on demand.
const STALL_HINT_MS = 180_000

test.afterEach(() => {
    chatStreamStore.clear()
    chatStreamStore.setTelemetry(null)
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
})

test('reconnects from the last event id after non-terminal EOF', async () => {
    installFastReconnectTimers()
    const calls = installFetch([
        frame(tokenEvent('1', 'hello')),
        frame(doneEvent('2'))
    ])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )

    await waitFor(() => {
        const snapshot = chatStreamStore.getSnapshot(key)
        return calls.length === 2 && snapshot.status === 'idle'
    })

    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(fallbackCalls, 0)
    assert.equal(snapshot.streamErrors.length, 0)
    assert.equal(calls[1]?.lastEventId, '1')
    assert.match(calls[1]?.url ?? '', /[?&]lastEventId=1(?:&|$)/)
})

test('EOF retries exhaust into a refetch fallback and keep waiting, not a dead end', async () => {
    installFastReconnectTimers()
    const calls = installFetch(['', '', '', '', '', '', '', '', '', ''])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )

    await waitFor(() => fallbackCalls === 1)

    const snapshot = chatStreamStore.getSnapshot(key)
    // 1 initial read + 8 fast reconnects (budget sized to outlast a rolling
    // API deploy), then the store refetches messages via onFallback and keeps
    // waiting on a 30s slow retry — never a terminal error: the turn may have
    // completed server-side, and acknowledgePersistedMessage resolves it after
    // the refetch.
    assert.equal(calls.length, 9)
    assert.equal(snapshot.status, 'connecting')
    assert.equal(snapshot.streamErrors.length, 0)
})

test('reconnects from the last event id after a mid-stream reader exception', async () => {
    installFastReconnectTimers()
    const dropped = controlledTextStream()
    const resumed = controlledTextStream()
    const calls = installFetch([dropped.stream, resumed.stream])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )
    await waitFor(() => calls.length === 1)
    dropped.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    dropped.fail(new Error('network error'))

    await waitFor(() => chatStreamStore.getSnapshot(key).status !== 'streaming')
    const reconnecting = chatStreamStore.getSnapshot(key)
    assert.equal(reconnecting.status, 'connecting')
    assert.equal(reconnecting.error, null)
    assert.equal(reconnecting.streamingAssistantId, 'msg-1')
    assert.equal(fallbackCalls, 0)

    await waitFor(() => calls.length === 2)
    assert.equal(calls[1]?.lastEventId, '1')
    assert.match(calls[1]?.url ?? '', /[?&]lastEventId=1(?:&|$)/)

    resumed.write(frame(tokenEvent('2', ' completed by adoption')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'streaming')
    assert.deepEqual(chatStreamStore.getSnapshot(key).streamingBlocks, [
        { kind: 'token', text: 'partial answer completed by adoption' }
    ])

    resumed.write(frame(doneEvent('3')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')

    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.streamingAssistantId, null)
    assert.equal(snapshot.streamErrors.length, 0)
    assert.equal(fallbackCalls, 0)
})

test('converges on the adopted message after the exception ladder is exhausted', async () => {
    installFastReconnectTimers()
    const dropped = controlledTextStream()
    const deployBounce = (): Error => new Error('Failed to fetch')
    const calls = installFetch([
        dropped.stream,
        ...Array.from({ length: 8 }, deployBounce)
    ])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )
    await waitFor(() => calls.length === 1)
    dropped.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    dropped.fail(new Error('network error'))

    // 1 interrupted read + 8 fast reconnects, then the refetch — which observes
    // the turn the backend adopted and persisted while we were disconnected.
    await waitFor(() => fallbackCalls === 1)
    assert.equal(calls.length, 9)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'connecting')
    assert.equal(chatStreamStore.getSnapshot(key).streamErrors.length, 0)

    chatStreamStore.acknowledgePersistedMessage(key, 'msg-1')
    await sleep(20)

    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'idle')
    assert.equal(snapshot.streamingAssistantId, null)
    assert.equal(snapshot.streamingBlocks.length, 0)
    assert.equal(snapshot.streamErrors.length, 0)
    assert.equal(calls.length, 9)
})

test('retries a stream bounced by a restarting API', async () => {
    installFastReconnectTimers()
    const calls = installFetch([{ status: 503 }, frame(doneEvent('1'))])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )

    await waitFor(
        () =>
            calls.length === 2 &&
            chatStreamStore.getSnapshot(key).status === 'idle'
    )
    assert.equal(fallbackCalls, 0)
    assert.equal(chatStreamStore.getSnapshot(key).streamErrors.length, 0)
})

test('does not retry a stream the server rejects as unauthorized', async () => {
    installFastReconnectTimers()
    const calls = installFetch([{ status: 401 }, frame(doneEvent('1'))])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )

    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'error')
    await sleep(20)

    assert.equal(calls.length, 1)
    assert.equal(fallbackCalls, 1)
    assert.equal(
        chatStreamStore.getSnapshot(key).error,
        'SSE connection failed: 401'
    )
})

test('recovers EOF for a later turn on the same SSE connection', async () => {
    installFastReconnectTimers()
    const firstStream = controlledTextStream()
    const calls = installFetch([
        firstStream.stream,
        frame(doneEvent('3', 'msg-2'))
    ])
    let fallbackCalls = 0
    const params = streamParams(() => {
        fallbackCalls += 1
    })

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    await waitFor(() => calls.length === 1)

    firstStream.write(frame(doneEvent('1', 'msg-1')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')

    chatStreamStore.beginAssistantTurn(key, params, 'msg-2')
    firstStream.write(frame(tokenEvent('2', 'second turn', 'msg-2')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingAssistantId === 'msg-2'
    )

    firstStream.close()
    await waitFor(() => {
        const snapshot = chatStreamStore.getSnapshot(key)
        return calls.length === 2 && snapshot.status === 'idle'
    })

    assert.equal(calls[1]?.lastEventId, '2')
    assert.equal(fallbackCalls, 0)
})

test('does not retry idle listener EOF after a terminal event', async () => {
    installFastReconnectTimers()
    const calls = installFetch([frame(doneEvent('1')), ''])
    let fallbackCalls = 0
    const params = streamParams(() => {
        fallbackCalls += 1
    })

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')

    chatStreamStore.getOrStart(params)
    await waitFor(() => calls.length === 2)
    await sleep(20)

    assert.equal(calls.length, 2)
    assert.equal(fallbackCalls, 0)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'idle')
})

test('preserves streamed blocks while waiting for cancellation terminal event', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    chatStreamStore.cancel(key)

    let snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'cancelling')
    assert.equal(snapshot.streamingAssistantId, 'msg-1')
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer' }
    ])
    assert.equal(snapshot.streamErrors.length, 0)

    stream.write(frame(cancelledEvent('2')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'cancelled')

    snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.streamingAssistantId, 'msg-1')
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer' }
    ])
    assert.equal(snapshot.streamErrors.length, 0)
})

test('clears cancelled temporary stream after persisted message acknowledgement', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    chatStreamStore.cancel(key)
    stream.write(frame(cancelledEvent('2')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'cancelled')

    chatStreamStore.acknowledgePersistedMessage(key, 'msg-1')

    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'idle')
    assert.equal(snapshot.streamingAssistantId, null)
    assert.equal(snapshot.streamingBlocks.length, 0)
    assert.equal(snapshot.streamErrors.length, 0)
})

test('clears active temporary stream after persisted terminal message acknowledgement', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    chatStreamStore.acknowledgePersistedMessage(key, 'msg-1')

    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'idle')
    assert.equal(snapshot.streamingAssistantId, null)
    assert.equal(snapshot.streamingBlocks.length, 0)
    assert.equal(snapshot.streamErrors.length, 0)
})

test('cold attach replays the inflight turn and shows the working indicator', async () => {
    const stream = controlledTextStream()
    const calls = installFetch([stream.stream])

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-1',
        initialLastEventId: '999'
    })

    const hydrated = chatStreamStore.getSnapshot(key)
    assert.equal(hydrated.streamingAssistantId, 'msg-1')
    assert.equal(hydrated.status, 'connecting')
    assert.equal(hydrated.streamingBlocks.length, 0)

    await waitFor(() => calls.length === 1)
    assert.equal(calls[0]?.lastEventId, null)
    assert.match(calls[0]?.url ?? '', /[?&]replayMessageId=msg-1(?:&|$)/)

    stream.write(frame(tokenEvent('5', 'replayed head', 'msg-1')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'streaming')
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'replayed head' }
    ])
})

test('an idle message page cursor anchors the first stream request', async () => {
    const stream = controlledTextStream()
    const calls = installFetch([stream.stream])

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        initialLastEventId: '41'
    })

    await waitFor(() => calls.length === 1)
    assert.equal(calls[0]?.lastEventId, '41')
    assert.match(calls[0]?.url ?? '', /[?&]lastEventId=41(?:&|$)/)
    assert.doesNotMatch(calls[0]?.url ?? '', /replayMessageId/)
})

test('cold attach reconnect resumes from lastEventId and drops the replay cursor', async () => {
    installFastReconnectTimers()
    const first = controlledTextStream()
    const calls = installFetch([first.stream, frame(doneEvent('6', 'msg-1'))])

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-1'
    })
    await waitFor(() => calls.length === 1)

    first.write(frame(tokenEvent('5', 'partial', 'msg-1')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    first.close()

    await waitFor(
        () =>
            calls.length === 2 &&
            chatStreamStore.getSnapshot(key).status === 'idle'
    )
    assert.equal(calls[1]?.lastEventId, '5')
    assert.match(calls[1]?.url ?? '', /[?&]lastEventId=5(?:&|$)/)
    assert.doesNotMatch(calls[1]?.url ?? '', /replayMessageId/)
})

test('cold attach to an already-finished turn replays through to done and clears the indicator', async () => {
    const calls = installFetch([
        frame(tokenEvent('5', 'whole answer', 'msg-1')) +
            frame(doneEvent('6', 'msg-1'))
    ])

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-1'
    })
    assert.equal(chatStreamStore.getSnapshot(key).streamingAssistantId, 'msg-1')

    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.streamingAssistantId, null)
    assert.equal(snapshot.streamingBlocks.length, 0)
    assert.match(calls[0]?.url ?? '', /[?&]replayMessageId=msg-1(?:&|$)/)
})

test('reports a mid-stream transport drop with its reason, cursor state and attempt', async () => {
    installFastReconnectTimers()
    const telemetry = installTelemetry()
    const dropped = controlledTextStream()
    const resumed = controlledTextStream()
    const calls = installFetch([dropped.stream, resumed.stream])

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )
    await waitFor(() => calls.length === 1)
    dropped.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    dropped.fail(new Error('network error'))
    await waitFor(() => telemetry.length === 1)

    // Correlation is the opaque agent/session/message id trio the server side
    // already logs — enough to line this tab up with the adopted turn, and
    // nothing from the conversation itself.
    assert.deepEqual(telemetry[0], {
        name: 'chat.sse.disconnected',
        reason: 'reader_exception',
        status: null,
        resuming: true,
        attempt: 1,
        agentId: 'agent-1',
        sessionId: 'session-1',
        messageId: 'msg-1'
    })
})

test('reports a recovered stream with the attempts taken and elapsed time', async () => {
    installFastReconnectTimers()
    const telemetry = installTelemetry()
    const dropped = controlledTextStream()
    const resumed = controlledTextStream()
    const calls = installFetch([dropped.stream, resumed.stream])

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )
    await waitFor(() => calls.length === 1)
    dropped.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    dropped.fail(new Error('network error'))
    await waitFor(() => calls.length === 2)
    resumed.write(frame(tokenEvent('2', ' completed by adoption')))
    await waitFor(() => telemetry.length === 2)

    assert.equal(telemetry[1]?.name, 'chat.sse.reconnected')
    assert.equal(telemetry[1]?.attempts, 1)
    assert.equal(typeof telemetry[1]?.elapsedMs, 'number')
    assert.equal(telemetry[1]?.sessionId, 'session-1')
    assert.equal(telemetry[1]?.messageId, 'msg-1')

    resumed.write(frame(doneEvent('3')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    assert.equal(telemetry.length, 2)
})

test('reports the fallback when the reconnect ladder is exhausted', async () => {
    installFastReconnectTimers()
    const telemetry = installTelemetry()
    const dropped = controlledTextStream()
    const deployBounce = (): Error => new Error('Failed to fetch')
    const calls = installFetch([
        dropped.stream,
        ...Array.from({ length: 8 }, deployBounce)
    ])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )
    await waitFor(() => calls.length === 1)
    dropped.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    dropped.fail(new Error('network error'))
    await waitFor(() => fallbackCalls === 1)

    // 1 interrupted read + 8 exhausted fast reconnects, each reported once.
    assert.equal(
        telemetry.filter((event) => event.name === 'chat.sse.disconnected')
            .length,
        9
    )
    assert.equal(telemetry.at(-1)?.name, 'chat.sse.reconnect_failed')
    assert.equal(telemetry.at(-1)?.attempts, 9)
    assert.equal(typeof telemetry.at(-1)?.elapsedMs, 'number')
    assert.equal(telemetry.at(-1)?.messageId, 'msg-1')
})

test('reports a retryable HTTP bounce with the status that caused it', async () => {
    installFastReconnectTimers()
    const telemetry = installTelemetry()
    const calls = installFetch([{ status: 503 }, frame(doneEvent('1'))])

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )
    await waitFor(
        () =>
            calls.length === 2 &&
            chatStreamStore.getSnapshot(key).status === 'idle'
    )

    assert.deepEqual(telemetry[0], {
        name: 'chat.sse.disconnected',
        reason: 'http_status',
        status: 503,
        resuming: false,
        attempt: 1,
        agentId: 'agent-1',
        sessionId: 'session-1',
        messageId: 'msg-1'
    })
    assert.equal(telemetry[1]?.name, 'chat.sse.reconnected')
    assert.equal(telemetry[1]?.attempts, 1)
    assert.equal(telemetry.length, 2)
})

test('reports nothing for turns that stream, finish and cancel normally', async () => {
    const telemetry = installTelemetry()
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    stream.write(frame(doneEvent('2')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')

    chatStreamStore.beginAssistantTurn(key, params, 'msg-2')
    stream.write(frame(tokenEvent('3', 'second turn', 'msg-2')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingAssistantId === 'msg-2'
    )
    chatStreamStore.cancel(key)
    stream.write(frame(cancelledEvent('4', 'msg-2')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'cancelled')

    assert.deepEqual(telemetry, [])
})

test('reports nothing for a request the server rejects as unauthorized', async () => {
    installFastReconnectTimers()
    const telemetry = installTelemetry()
    installFetch([{ status: 401 }])

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'error')
    await sleep(20)

    assert.deepEqual(telemetry, [])
})

test('reports nothing when an LRU eviction tears a live reader down', async () => {
    const telemetry = installTelemetry()
    const started: string[] = []
    // Aborting a real fetch body errors the reader mid-read; a manually driven
    // stream would never notice the signal, so eviction has to be simulated
    // this way for the aborted-reader guard to be exercised at all.
    globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> => {
        started.push(String(input))
        const signal = init?.signal
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                signal?.addEventListener('abort', () => {
                    controller.error(new Error('The operation was aborted'))
                })
            }
        })
        return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        })
    }) as typeof fetch

    for (const sessionId of ['s-1', 's-2', 's-3', 's-4']) {
        chatStreamStore.beginAssistantTurn(
            chatStreamStore.keyOf('agent-1', sessionId),
            streamParams(() => undefined, sessionId),
            'msg-1'
        )
    }
    await waitFor(() => started.length === 4)

    chatStreamStore.beginAssistantTurn(
        chatStreamStore.keyOf('agent-1', 's-5'),
        streamParams(() => undefined, 's-5'),
        'msg-1'
    )
    await waitFor(() => started.length === 5)
    await sleep(20)

    assert.deepEqual(telemetry, [])
})

test('holds a suspended turn open until the daemon carries it further', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    let fallbackCalls = 0
    const params = streamParams(() => {
        fallbackCalls += 1
    })

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    stream.write(frame(suspendedEvent('2', 'daemon offline')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'suspended')

    // The row stays open server-side and a resumed exec appends to the same
    // messageId, so nothing may be dropped and no refetch may race the resume.
    let snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.streamingAssistantId, 'msg-1')
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer' }
    ])
    assert.equal(snapshot.suspendedReason, 'daemon offline')
    assert.equal(snapshot.streamErrors.length, 0)
    assert.equal(fallbackCalls, 0)

    stream.write(frame(tokenEvent('3', ' finished after resume')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'streaming')

    snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.suspendedReason, null)
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer finished after resume' }
    ])

    stream.write(frame(doneEvent('4')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    assert.equal(fallbackCalls, 0)
})

test('ends a suspension on any event that proves the turn is producing again', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)
    const resumingEvents = [
        thinkingEvent('r1', 'still reasoning'),
        toolCallEvent('r2'),
        toolResultEvent('r3'),
        replaceEvent('r4', 'moderated answer')
    ]

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')

    for (const [index, event] of resumingEvents.entries()) {
        stream.write(frame(suspendedEvent(`s${index}`, 'daemon offline')))
        await waitFor(
            () => chatStreamStore.getSnapshot(key).status === 'suspended'
        )

        stream.write(frame(event))
        await waitFor(
            () => chatStreamStore.getSnapshot(key).status === 'streaming'
        )
        assert.equal(chatStreamStore.getSnapshot(key).suspendedReason, null)
    }
})

test('keeps a requested cancellation while the transport is suspended', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    chatStreamStore.cancel(key)

    stream.write(frame(suspendedEvent('2', 'daemon offline')))
    await waitFor(
        () =>
            chatStreamStore.getSnapshot(key).suspendedReason ===
            'daemon offline'
    )

    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.suspendedReason, 'daemon offline')
    assert.equal(snapshot.status, 'cancelling')
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer' }
    ])
})

test('hands a suspended turn back as suspended when the cancel request never reached the server', async () => {
    const silence = installStallTimer()
    const telemetry = installTelemetry()
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    const cancelAttempt = chatStreamStore.cancel(key)
    stream.write(frame(suspendedEvent('2', 'daemon offline')))
    await waitFor(
        () =>
            chatStreamStore.getSnapshot(key).suspendedReason ===
            'daemon offline'
    )

    assert.ok(cancelAttempt)
    chatStreamStore.cancelRequestFailed(key, cancelAttempt)

    // The rejected cancel says nothing about the daemon, and a resume starts
    // after the suspended event so that state is never re-sent: rolling the
    // turn back to 'streaming' would claim Working for a turn no device is
    // carrying, until some later live or terminal frame happened to correct it.
    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'suspended')
    assert.equal(snapshot.suspendedReason, 'daemon offline')
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer' }
    ])

    // A suspended turn's silence is already explained to the user, so the
    // rollback must not arm the stall hint on top of the reconnect wait.
    assert.equal(silence.armed(), false)
    silence.fire()
    assert.equal(chatStreamStore.getSnapshot(key).stalled, false)
    assert.deepEqual(
        telemetry.filter((event) => event.name === 'chat.sse.stalled'),
        []
    )
})

test('hands a turn that resumed under a pending cancel back as streaming', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    const cancelAttempt = chatStreamStore.cancel(key)
    stream.write(frame(suspendedEvent('1', 'daemon offline')))
    await waitFor(
        () =>
            chatStreamStore.getSnapshot(key).suspendedReason ===
            'daemon offline'
    )

    // The daemon came back and carried the turn further while the cancel was
    // still in flight. That clears the suspend even though the status stays
    // 'cancelling', so the rollback must land on the live state, not the stale
    // one it was in two frames ago.
    stream.write(frame(tokenEvent('2', 'back on the air')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    assert.equal(chatStreamStore.getSnapshot(key).status, 'cancelling')
    assert.equal(chatStreamStore.getSnapshot(key).suspendedReason, null)

    assert.ok(cancelAttempt)
    chatStreamStore.cancelRequestFailed(key, cancelAttempt)

    assert.equal(chatStreamStore.getSnapshot(key).status, 'streaming')
})

test('a stale cancel failure cannot roll back a newer accepted cancellation', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    const olderAttempt = chatStreamStore.cancel(key)
    const newerAttempt = chatStreamStore.cancel(key)
    assert.ok(olderAttempt)
    assert.ok(newerAttempt)
    assert.equal(
        chatStreamStore.cancelRequestSucceeded(key, newerAttempt),
        true
    )
    assert.equal(chatStreamStore.cancelRequestFailed(key, olderAttempt), false)

    assert.equal(chatStreamStore.getSnapshot(key).status, 'cancelling')
})

test('overlapping failed cancel requests roll back only after the last one settles', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    const olderAttempt = chatStreamStore.cancel(key)
    const newerAttempt = chatStreamStore.cancel(key)
    assert.ok(olderAttempt)
    assert.ok(newerAttempt)
    assert.equal(chatStreamStore.cancelRequestFailed(key, olderAttempt), false)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'cancelling')

    assert.equal(chatStreamStore.cancelRequestFailed(key, newerAttempt), true)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'streaming')
})

test('a stale cancel failure cannot roll back a later turn cancellation', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    const oldFailedAttempt = chatStreamStore.cancel(key)
    const oldAcceptedAttempt = chatStreamStore.cancel(key)
    assert.ok(oldFailedAttempt)
    assert.ok(oldAcceptedAttempt)
    stream.write(frame(doneEvent('1')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')

    assert.equal(
        chatStreamStore.cancelRequestSucceeded(key, oldAcceptedAttempt),
        false
    )

    chatStreamStore.beginAssistantTurn(key, params, 'msg-2')
    const currentAttempt = chatStreamStore.cancel(key)
    assert.ok(currentAttempt)

    assert.equal(
        chatStreamStore.cancelRequestFailed(key, oldFailedAttempt),
        false
    )
    assert.equal(chatStreamStore.getSnapshot(key).status, 'cancelling')
})

test('a stale cross-tab cancel cannot cancel a later turn', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(doneEvent('1')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    chatStreamStore.beginAssistantTurn(key, params, 'msg-2')

    assert.equal(chatStreamStore.cancelMatchingTurn(key, 'msg-1'), null)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'connecting')
    assert.equal(chatStreamStore.getSnapshot(key).streamingAssistantId, 'msg-2')
})

test('reconnects a suspended turn without downgrading it to connecting', async () => {
    installFastReconnectTimers()
    const dropped = controlledTextStream()
    const resumed = controlledTextStream()
    const calls = installFetch([dropped.stream, resumed.stream])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )
    await waitFor(() => calls.length === 1)
    dropped.write(frame(suspendedEvent('1', 'daemon offline')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'suspended')

    dropped.close()

    // Our own transport coming back says nothing about the daemon, and the
    // resumed stream starts after the suspended event, so it would never be
    // re-sent: the state has to survive the ladder or the tab silently reverts
    // to claiming it is merely connecting.
    await waitFor(() => calls.length === 2)
    assert.equal(calls[1]?.lastEventId, '1')
    assert.equal(chatStreamStore.getSnapshot(key).status, 'suspended')
    assert.equal(fallbackCalls, 0)

    resumed.write(frame(doneEvent('2')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
})

test('hints at a live turn that has gone silent and clears it on the next data frame', async () => {
    const silence = installStallTimer()
    const telemetry = installTelemetry()
    const stream = controlledTextStream()
    installFetch([stream.stream])

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )
    assert.equal(chatStreamStore.getSnapshot(key).stalled, false)

    silence.fire()
    assert.equal(chatStreamStore.getSnapshot(key).stalled, true)
    assert.equal(telemetry.length, 1)
    assert.equal(telemetry[0]?.name, 'chat.sse.stalled')
    assert.equal(telemetry[0]?.messageId, 'msg-1')
    assert.equal(typeof telemetry[0]?.silentMs, 'number')

    stream.write(frame(tokenEvent('1', 'back to work')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    assert.equal(chatStreamStore.getSnapshot(key).stalled, false)
    assert.equal(telemetry.length, 1)

    silence.fire()
    assert.equal(chatStreamStore.getSnapshot(key).stalled, true)
    assert.equal(telemetry.length, 2)
})

test('never hints at a session with no turn in flight', async () => {
    const silence = installStallTimer()
    const telemetry = installTelemetry()
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.getOrStart(params)
    assert.equal(silence.armed(), false)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    assert.equal(silence.armed(), true)

    stream.write(frame(doneEvent('1')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')

    assert.equal(silence.armed(), false)
    silence.fire()
    assert.equal(chatStreamStore.getSnapshot(key).stalled, false)
    assert.deepEqual(telemetry, [])
})

test('abandons a pending turn whose send never reached the server', async () => {
    const stream = controlledTextStream()
    const calls = installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.markTurnPending(key, params)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'connecting')
    await waitFor(() => calls.length === 1)

    chatStreamStore.abandonPendingTurn(key)

    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'idle')
    assert.equal(snapshot.streamingAssistantId, null)
    assert.equal(snapshot.streamStartedAt, null)

    // The reader doubles as this session's idle listener, so it must survive
    // the rollback and still deliver a turn started from another tab.
    stream.write(frame(tokenEvent('1', 'started elsewhere')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    assert.equal(calls.length, 1)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'streaming')
})

test('leaves a turn the server already accepted alone', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    assert.equal(chatStreamStore.getSnapshot(key).status, 'connecting')

    chatStreamStore.abandonPendingTurn(key)

    let snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'connecting')
    assert.equal(snapshot.streamingAssistantId, 'msg-1')

    stream.write(frame(tokenEvent('1', 'real answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    stream.write(frame(doneEvent('2')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')

    snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.streamErrors.length, 0)
})

test('hands the turn back when the cancel request never reached the server', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const params = streamParams(() => undefined)

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )
    const cancelAttempt = chatStreamStore.cancel(key)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'cancelling')

    assert.ok(cancelAttempt)
    chatStreamStore.cancelRequestFailed(key, cancelAttempt)

    // Nothing durable was recorded server-side, so 'cancelling' would never
    // converge; the turn is still running and its blocks are still the answer.
    let snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.status, 'streaming')
    assert.equal(snapshot.streamingAssistantId, 'msg-1')
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer' }
    ])

    stream.write(frame(doneEvent('2')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')

    snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.streamErrors.length, 0)
})

const streamParams = (
    onFallback: () => void,
    sessionId = 'session-1'
): StartStreamParams => ({
    agentId: 'agent-1',
    sessionId,
    baseUrl: 'http://api.test',
    getToken: async () => 'token',
    onFallback
})

const installTelemetry = (): Record<string, unknown>[] => {
    const events: Record<string, unknown>[] = []
    chatStreamStore.setTelemetry((event) => {
        events.push({ ...event })
    })
    return events
}

interface StallTimerHarness {
    armed: () => boolean
    fire: () => void
}

// Holds the store's silence deadline instead of waiting three minutes for it.
// Every other timer keeps its real delay, and the deadline is only released by
// fire(), so "a data frame cleared the hint" cannot race a re-armed timer.
const installStallTimer = (): StallTimerHarness => {
    const pending = new Map<number, () => void>()
    let nextId = 1
    globalThis.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
    ) => {
        if (timeout !== STALL_HINT_MS)
            return originalSetTimeout(handler, timeout, ...args)
        const id = nextId
        nextId += 1
        const invoke = handler as (...rest: unknown[]) => void
        pending.set(id, () => invoke(...args))
        return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = ((handle?: unknown) => {
        if (typeof handle === 'number' && pending.delete(handle)) return
        originalClearTimeout(handle as Parameters<typeof clearTimeout>[0])
    }) as typeof clearTimeout
    return {
        armed: (): boolean => pending.size > 0,
        fire: (): void => {
            const callbacks = [...pending.values()]
            pending.clear()
            for (const callback of callbacks) callback()
        }
    }
}

const installFastReconnectTimers = (): void => {
    globalThis.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
    ) =>
        originalSetTimeout(
            handler,
            typeof timeout === 'number' && timeout < 30_000 ? 0 : timeout,
            ...args
        )) as typeof setTimeout
}

interface FetchCall {
    url: string
    lastEventId: string | null
}

type FetchOutcome =
    | string
    | ReadableStream<Uint8Array>
    | Error
    | { status: number }

const installFetch = (bodies: FetchOutcome[]): FetchCall[] => {
    const calls: FetchCall[] = []
    globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> => {
        calls.push({
            url: String(input),
            lastEventId: readLastEventId(init?.headers)
        })
        const body = bodies.shift() ?? ''
        if (body instanceof Error) throw body
        if (typeof body !== 'string' && !(body instanceof ReadableStream))
            return new Response(null, { status: body.status })
        const stream = typeof body === 'string' ? readableText(body) : body
        return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
        })
    }) as typeof fetch
    return calls
}

const readLastEventId = (headers: HeadersInit | undefined): string | null => {
    if (!headers) return null
    if (headers instanceof Headers) return headers.get('Last-Event-ID')
    if (Array.isArray(headers)) {
        const header = headers.find(([name]) => name === 'Last-Event-ID')
        return header?.[1] ?? null
    }
    return headers['Last-Event-ID'] ?? headers['last-event-id'] ?? null
}

const readableText = (body: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start(controller) {
            if (body) controller.enqueue(encoder.encode(body))
            controller.close()
        }
    })

const controlledTextStream = (): {
    stream: ReadableStream<Uint8Array>
    write: (body: string) => void
    close: () => void
    fail: (error: Error) => void
} => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
        start(nextController) {
            controller = nextController
        }
    })
    return {
        stream,
        write: (body: string) => {
            if (!controller) throw new Error('stream controller unavailable')
            controller.enqueue(encoder.encode(body))
        },
        close: () => {
            if (!controller) throw new Error('stream controller unavailable')
            controller.close()
        },
        fail: (error: Error) => {
            if (!controller) throw new Error('stream controller unavailable')
            controller.error(error)
        }
    }
}

const frame = (event: ChatStreamEvent): string =>
    `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(
        event
    )}\n\n`

const tokenEvent = (
    eventId: string,
    text: string,
    messageId = 'msg-1'
): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'token',
    text
})

const thinkingEvent = (
    eventId: string,
    text: string,
    messageId = 'msg-1'
): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'thinking',
    text
})

const toolCallEvent = (
    eventId: string,
    messageId = 'msg-1'
): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'tool_call',
    toolCallId: `call-${eventId}`,
    toolName: 'bash',
    args: { command: 'ls' }
})

const toolResultEvent = (
    eventId: string,
    messageId = 'msg-1'
): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'tool_result',
    toolCallId: `call-${eventId}`,
    result: 'ok'
})

const replaceEvent = (
    eventId: string,
    text: string,
    messageId = 'msg-1'
): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'replace',
    text,
    reason: 'output_moderated'
})

const suspendedEvent = (
    eventId: string,
    reason: string,
    messageId = 'msg-1'
): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'suspended',
    daemonId: 'dmn-1',
    daemonExecRef: messageId,
    reason
})

const doneEvent = (eventId: string, messageId = 'msg-1'): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'done',
    finalMessageId: messageId
})

const errorEvent = (
    eventId: string,
    code: string,
    messageId = 'msg-1'
): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'error',
    error: { code, message: `${code} happened`, retryable: false }
})

const cancelledEvent = (
    eventId: string,
    messageId = 'msg-1'
): ChatStreamEvent => ({
    ...baseEvent(eventId, messageId),
    type: 'error',
    error: {
        code: 'cancelled_by_user',
        message: 'cancelled by user',
        retryable: false
    }
})

const baseEvent = (eventId: string, messageId = 'msg-1') => ({
    eventId,
    messageId,
    sessionId: 'session-1',
    seq: Number(eventId),
    createdAt: '2026-04-28T00:00:00.000Z'
})

const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 1_000
): Promise<void> => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) return
        await new Promise<void>((resolve) => originalSetTimeout(resolve, 5))
    }
    assert.fail('timed out waiting for condition')
}

const sleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => originalSetTimeout(resolve, ms))

// #674. Recovery used to be invisible: the API adopts or resumes an orphaned
// turn and rebuilds it, and the tab saw nothing but silence. `turn_status` is
// the informational row that explains that silence — so what these pin is that
// it changes the LABEL and nothing else: not the status, not the ladder, not
// the composer lock, and above all not the turn's terminal.

const turnStatusEvent = (
    eventId: string,
    phase: 'recovering' | 'resuming',
    messageId = 'msg-1'
): ChatStreamEvent =>
    ({
        ...baseEvent(eventId, messageId),
        type: 'turn_status',
        phase
    }) as ChatStreamEvent

test('turn_status sets a recovery hint without touching the turn', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    let fallbackCalls = 0
    const params = streamParams(() => {
        fallbackCalls += 1
    })

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    stream.write(frame(turnStatusEvent('2', 'recovering')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).recoveryPhase === 'recovering'
    )

    const snapshot = chatStreamStore.getSnapshot(key)
    // The hint is additive. Everything that decides whether the turn is alive,
    // resumable, or still owns the composer must read exactly what it read
    // before the row arrived.
    assert.equal(snapshot.status, 'streaming')
    assert.equal(snapshot.streamingAssistantId, 'msg-1')
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer' }
    ])
    assert.equal(snapshot.streamErrors.length, 0)
    assert.equal(snapshot.error, null)
    assert.equal(snapshot.suspendedReason, null)
    assert.equal(fallbackCalls, 0)

    stream.write(frame(doneEvent('3')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    assert.equal(fallbackCalls, 0)
})

test('the resuming phase is reported distinctly from recovering', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )
    stream.write(frame(turnStatusEvent('1', 'resuming')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).recoveryPhase === 'resuming'
    )

    // A daemon picking its runner stream back up is a different story from
    // adoption rebuilding the answer from a transcript, and the label says so.
    assert.equal(chatStreamStore.getSnapshot(key).status, 'connecting')
})

test('any event carrying real progress clears the recovery hint', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    const progress = [
        tokenEvent('p1', 'recovered text'),
        thinkingEvent('p2', 'still reasoning'),
        toolCallEvent('p3'),
        toolResultEvent('p4'),
        replaceEvent('p5', 'rebuilt answer')
    ]

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )

    for (const [index, event] of progress.entries()) {
        stream.write(frame(turnStatusEvent(`s${index}`, 'recovering')))
        await waitFor(
            () =>
                chatStreamStore.getSnapshot(key).recoveryPhase === 'recovering'
        )

        stream.write(frame(event))
        // Output is better evidence than a promise of output: once the turn is
        // producing again, "Recovering…" is stale and must not linger.
        await waitFor(
            () => chatStreamStore.getSnapshot(key).recoveryPhase === null
        )
    }
})

test('a suspension supersedes the recovery hint rather than stacking with it', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )
    stream.write(frame(turnStatusEvent('1', 'resuming')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).recoveryPhase === 'resuming'
    )

    stream.write(frame(suspendedEvent('2', 'daemon offline')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'suspended')

    // A resume that ended in another suspension is a newer, more specific fact
    // about the same turn; showing both would tell the user two things at once.
    const snapshot = chatStreamStore.getSnapshot(key)
    assert.equal(snapshot.recoveryPhase, null)
    assert.equal(snapshot.suspendedReason, 'daemon offline')
})

// The production daemon sequence, end to end over the real store and real SSE
// frames: the tab learns the device dropped, the API announces the resume, the
// resumed attach drops again, and the daemon re-dials. Every resume in that
// ladder has to be visible, every suspension has to take the presentation back,
// and none of it may disturb the cursor the reconnect resumes from — the label
// is a label, not a state machine.
test('suspended -> resuming -> suspended -> resuming stays visible on both resumes', async () => {
    installFastReconnectTimers()
    const dropped = controlledTextStream()
    const resumed = controlledTextStream()
    const calls = installFetch([dropped.stream, resumed.stream])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )
    dropped.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    const labelNow = (): string | null => {
        const snapshot = chatStreamStore.getSnapshot(key)
        return recoveryLabelKey(snapshot.status, snapshot.recoveryPhase)
    }

    dropped.write(frame(suspendedEvent('2', 'daemon offline')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'suspended')
    assert.equal(labelNow(), null, 'nothing is recovering yet')

    // First re-dial. The store deliberately keeps status 'suspended' here so
    // the ladder, the stall watch and the composer lock read what they always
    // read — the label is the only thing that moves.
    dropped.write(frame(turnStatusEvent('3', 'resuming')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).recoveryPhase === 'resuming'
    )
    assert.equal(labelNow(), 'web.chatStream.resuming')
    assert.equal(chatStreamStore.getSnapshot(key).status, 'suspended')
    assert.equal(
        chatStreamStore.getSnapshot(key).suspendedReason,
        'daemon offline'
    )

    // The resumed attach suspends again: the newer fact wins back.
    dropped.write(frame(suspendedEvent('4', 'daemon offline')))
    await waitFor(() => chatStreamStore.getSnapshot(key).recoveryPhase === null)
    assert.equal(labelNow(), null)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'suspended')

    // Second re-dial. This is the one the API used to swallow on the durable
    // side and the UI used to hide on this side.
    dropped.write(frame(turnStatusEvent('5', 'resuming')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).recoveryPhase === 'resuming'
    )
    assert.equal(labelNow(), 'web.chatStream.resuming')

    // Cursor and terminal semantics are untouched by any of it: a drop here
    // resumes from the last row seen, and the turn still ends on its own done.
    dropped.close()
    await waitFor(() => calls.length === 2)
    assert.equal(calls[1]?.lastEventId, '5')
    assert.equal(chatStreamStore.getSnapshot(key).streamingAssistantId, 'msg-1')

    resumed.write(frame(tokenEvent('6', ' and the rest')))
    await waitFor(() => chatStreamStore.getSnapshot(key).recoveryPhase === null)
    // Real output is better evidence than a promise of output.
    assert.equal(labelNow(), null)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'streaming')
    assert.deepEqual(chatStreamStore.getSnapshot(key).streamingBlocks, [
        { kind: 'token', text: 'partial answer and the rest' }
    ])

    resumed.write(frame(doneEvent('7')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    assert.equal(fallbackCalls, 0)
})

test('every terminal clears the recovery hint', async () => {
    for (const terminal of [
        doneEvent('t1'),
        cancelledEvent('t2'),
        {
            ...baseEvent('t3'),
            type: 'error' as const,
            error: {
                code: 'server_restart',
                message: 'stream interrupted by server restart',
                retryable: true
            }
        }
    ]) {
        const stream = controlledTextStream()
        installFetch([stream.stream])
        chatStreamStore.beginAssistantTurn(
            key,
            streamParams(() => undefined),
            'msg-1'
        )
        stream.write(frame(turnStatusEvent('r', 'recovering')))
        await waitFor(
            () =>
                chatStreamStore.getSnapshot(key).recoveryPhase === 'recovering'
        )

        stream.write(frame(terminal as ChatStreamEvent))
        await waitFor(
            () => chatStreamStore.getSnapshot(key).recoveryPhase === null
        )
        chatStreamStore.clear()
    }
})

test('a new turn does not inherit the previous turn recovery hint', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-1'
    )
    stream.write(frame(turnStatusEvent('1', 'recovering')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).recoveryPhase === 'recovering'
    )

    // The recovered turn never terminalized in this tab (the user sent again
    // over it); the hint belongs to that turn, not to the session.
    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => undefined),
        'msg-2'
    )
    assert.equal(chatStreamStore.getSnapshot(key).recoveryPhase, null)
})

// A type this bundle does not know: the row a NEWER server sends to an older
// tab, and the shape `usage` already has here. It reaches the fall-through
// in applyEventToSnapshot, whose contract is to hand the snapshot back as-is.
const unknownEvent = (eventId: string, messageId = 'msg-1'): ChatStreamEvent =>
    ({
        ...baseEvent(eventId, messageId),
        type: 'not_a_type_this_bundle_knows'
    }) as unknown as ChatStreamEvent

// The fall-through writes nothing, so it has no signal of its own to wait on.
// The thinking row behind it is the synchronisation point — frames are
// ingested in wire order, so its block appearing proves the unknown row was
// already applied, and the two blocks being adjacent is what shows it
// contributed nothing between them.
test('an unrecognised event type leaves the snapshot untouched', async () => {
    const stream = controlledTextStream()
    installFetch([stream.stream])
    let fallbackCalls = 0
    const params = streamParams(() => {
        fallbackCalls += 1
    })

    chatStreamStore.beginAssistantTurn(key, params, 'msg-1')
    stream.write(frame(tokenEvent('1', 'partial answer')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    stream.write(frame(unknownEvent('2')))
    stream.write(frame(thinkingEvent('3', 'still reasoning')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 2
    )

    const snapshot = chatStreamStore.getSnapshot(key)
    assert.deepEqual(snapshot.streamingBlocks, [
        { kind: 'token', text: 'partial answer' },
        { kind: 'thinking', text: 'still reasoning' }
    ])
    assert.equal(snapshot.status, 'streaming')
    assert.equal(snapshot.streamingAssistantId, 'msg-1')
    assert.equal(snapshot.streamErrors.length, 0)
    assert.equal(snapshot.recoveryPhase, null)
    assert.equal(fallbackCalls, 0)

    // And it is not a terminal: the turn still finishes on its own done.
    stream.write(frame(doneEvent('4')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    assert.equal(fallbackCalls, 0)
})

// The other half of "not a terminal", on the transport rather than the snapshot:
// a turn_status must advance the resume cursor like any mid-turn row, so a drop
// right after one resumes from it instead of replaying the whole turn.
test('turn_status advances the resume cursor and keeps the turn resumable', async () => {
    installFastReconnectTimers()
    const dropped = controlledTextStream()
    const resumed = controlledTextStream()
    const calls = installFetch([dropped.stream, resumed.stream])
    let fallbackCalls = 0

    chatStreamStore.beginAssistantTurn(
        key,
        streamParams(() => {
            fallbackCalls += 1
        }),
        'msg-1'
    )
    dropped.write(frame(turnStatusEvent('9', 'recovering')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).recoveryPhase === 'recovering'
    )
    dropped.close()

    await waitFor(() => calls.length === 2)
    assert.equal(calls[1]?.lastEventId, '9')

    resumed.write(frame(doneEvent('10')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    assert.equal(fallbackCalls, 0)
})

// The client half of the checkpoint-attach contract.
//
// A cold attach no longer replays a running turn from its first event: the
// message page hands over the turn's checkpointed content plus the
// stream-event id that content is the fold of, and the store renders the
// content and resumes the SSE from the id. The deliverable is not the
// speedup, it is that the user sees the SAME transcript either way.
//
// So: for a corpus of turn shapes, cut the event log at EVERY position, build
// the checkpoint the server would have written there (the fold of the prefix,
// obtained by running this very store over it — the fold is definitionally
// what the store does), and assert the rendered content is byte-identical to
// the full replay. The server's side of the pairing — that its checkpoints
// really are the fold of the rows they name — is proved in
// apps/api/test/chat-checkpoint-cursor.test.ts.
//
// The cut is honoured through the real protocol, not around it: the run reads
// the request the store actually made and answers it. A store that declined
// the checkpoint and asked for a replay gets the whole log, which is what
// makes the fallback cases part of this proof rather than a hole in it.
const attachCorpus: Array<{ name: string; events: ChatStreamEvent[] }> = [
    {
        name: 'tokens only',
        events: [
            tokenEvent('1', 'Let me '),
            tokenEvent('2', 'answer '),
            tokenEvent('3', 'that '),
            tokenEvent('4', 'for you.')
        ]
    },
    {
        name: 'tool heavy',
        events: [
            tokenEvent('1', 'Looking it up. '),
            toolCallEvent('2'),
            toolResultEvent('3'),
            tokenEvent('4', 'Found it. '),
            toolCallEvent('5'),
            toolResultEvent('6'),
            tokenEvent('7', 'Done.')
        ]
    },
    {
        name: 'thinking interleaved',
        events: [
            thinkingEvent('1', 'weighing '),
            thinkingEvent('2', 'options '),
            tokenEvent('3', 'Here goes. '),
            thinkingEvent('4', 'second thoughts '),
            tokenEvent('5', 'Actually this.')
        ]
    },
    {
        name: 'with replace',
        events: [
            tokenEvent('1', 'here is how to do '),
            thinkingEvent('2', 'is this ok '),
            toolCallEvent('3'),
            tokenEvent('4', 'the bad thing'),
            replaceEvent('5', 'I cannot help with that.'),
            tokenEvent('6', ' Anything else?')
        ]
    },
    {
        name: 'replace to nothing',
        events: [
            tokenEvent('1', 'a draft answer'),
            replaceEvent('2', ''),
            tokenEvent('3', 'a second attempt')
        ]
    },
    {
        name: 'suspend and resume',
        events: [
            tokenEvent('1', 'starting '),
            suspendedEvent('2', 'sprite_suspended'),
            tokenEvent('3', 'resumed '),
            tokenEvent('4', 'and finished.')
        ]
    },
    {
        name: 'adoption relabels mid turn',
        events: [
            tokenEvent('1', 'pre-restart output '),
            turnStatusEvent('2', 'recovering'),
            tokenEvent('3', 'adopted tail '),
            toolCallEvent('4'),
            toolResultEvent('5')
        ]
    },
    {
        name: 'terminates mid attach',
        events: [
            tokenEvent('1', 'almost '),
            tokenEvent('2', 'there '),
            tokenEvent('3', 'done now.'),
            doneEvent('4')
        ]
    },
    {
        name: 'errors mid attach',
        events: [
            tokenEvent('1', 'partial output '),
            toolCallEvent('2'),
            errorEvent('3', 'upstream_failed')
        ]
    }
]

for (const shape of attachCorpus)
    test(`checkpoint attach renders the same transcript as a full replay (${shape.name})`, async () => {
        const full = await renderAttach(shape.events, null)
        for (let cut = 1; cut <= shape.events.length; cut += 1) {
            const atCut = shape.events[cut - 1]!
            if (
                atCut.type !== 'token' &&
                atCut.type !== 'thinking' &&
                atCut.type !== 'tool_call' &&
                atCut.type !== 'tool_result' &&
                atCut.type !== 'replace'
            )
                continue
            // What the server would have checkpointed at this cut: the
            // fold of the events up to it, as the message page ships it.
            const prefix = await renderAttach(shape.events.slice(0, cut), null)
            const checkpoint = {
                messageId: 'msg-1',
                eventId: atCut.eventId,
                blocks: prefix.contentBlocks
            }
            const attached = await renderAttach(shape.events, {
                cut,
                checkpoint
            })
            assert.equal(
                attached.rendered,
                full.rendered,
                `${shape.name}: attaching after event ${checkpoint.eventId} rendered a different transcript`
            )
            assert.equal(
                attached.status,
                full.status,
                `${shape.name}: attaching after event ${checkpoint.eventId} ended in a different status`
            )
        }
    })

// A runtime outlives the page that seeded it: LRU eviction aborts the reader
// but keeps the entry, and leaving a session leaves it in the map. So the
// checkpoint has to reach an entry that ALREADY EXISTS, not just a fresh one
// — otherwise the case this change exists for (revisit a session whose turn
// started on another tab or device) attaches with no cursor and no replay id
// at all, and the server replays the whole turn.
test('a retained runtime picks up a checkpoint supplied on a later visit', async () => {
    // First visit: no turn running, so nothing to replay and no checkpoint.
    const idle = controlledTextStream()
    let calls = installFetch([idle.stream])
    chatStreamStore.getOrStart(streamParams(() => undefined))
    await waitFor(() => calls.length === 1)
    assert.equal(calls[0]?.lastEventId, null)
    assert.doesNotMatch(calls[0]?.url ?? '', /replayMessageId/)
    // The reader stops the way LRU eviction stops it: aborted, entry kept.
    idle.close()
    await waitFor(
        () => chatStreamStore.getSnapshot(key).status === 'idle',
        3000
    )

    // Second visit. A turn started elsewhere in the meantime, so the message
    // page now reports one, with a checkpoint.
    const live = controlledTextStream()
    calls = installFetch([live.stream])
    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-9',
        replayCheckpoint: {
            messageId: 'msg-9',
            eventId: '41',
            blocks: [{ type: 'text', text: 'remote turn so far. ' }]
        }
    })

    const seeded = chatStreamStore.getSnapshot(key)
    assert.deepEqual(
        seeded.streamingBlocks,
        [{ kind: 'token', text: 'remote turn so far. ' }],
        'the retained entry must take the new checkpoint'
    )
    assert.equal(seeded.streamingAssistantId, 'msg-9')
    await waitFor(() => calls.length === 1)
    assert.equal(calls[0]?.lastEventId, '41')
    assert.match(calls[0]?.url ?? '', /[?&]lastEventId=41(?:&|$)/)
})

// A page that offers a checkpoint while a turn is already streaming changes
// nothing. getOrStart refuses to act on a live entry, hydrate refuses one
// that already has a cursor, and adoptReplayTarget refuses to store under
// either — this locks the behaviour the three of them add up to.
test('a live runtime ignores a checkpoint offered underneath it', async () => {
    const live = controlledTextStream()
    const calls = installFetch([live.stream])
    chatStreamStore.getOrStart(streamParams(() => undefined))
    await waitFor(() => calls.length === 1)

    live.write(frame(tokenEvent('7', 'live output ', 'msg-9')))
    await waitFor(
        () => chatStreamStore.getSnapshot(key).streamingBlocks.length === 1
    )

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-9',
        replayCheckpoint: {
            messageId: 'msg-9',
            eventId: '3',
            blocks: [{ type: 'text', text: 'stale page snapshot. ' }]
        }
    })

    assert.deepEqual(chatStreamStore.getSnapshot(key).streamingBlocks, [
        { kind: 'token', text: 'live output ' }
    ])
    assert.equal(calls.length, 1, 'no second connection was opened')
    live.write(frame(tokenEvent('8', 'and more.', 'msg-9')))
    await waitFor(() =>
        chatStreamStore
            .getSnapshot(key)
            .streamingBlocks.some(
                (block) =>
                    block.kind === 'token' &&
                    block.text === 'live output and more.'
            )
    )
})

// Refusing to STORE under a live reader is its own guard, and this is the
// sequence that shows it. The reader must be live and still have NO event id:
// a single delivered token would set lastEventId, and hydrate's own check
// would then cover the rest of the path and hide this one.
//
// So the offer lands while the entry is live and position-less, the turn it
// names then ends, and the same stale offer comes back. If the first offer
// had been stored, the terminal check could not save us — it declines to
// overwrite rather than clearing — and hydrate would seed a finished turn.
test('a checkpoint offered to a live position-less reader is never stored', async () => {
    const live = controlledTextStream()
    const calls = installFetch([live.stream, ''])
    chatStreamStore.getOrStart(streamParams(() => undefined))
    await waitFor(() => calls.length === 1)

    // Mid-turn page result, arriving while the reader is up and silent.
    const stale = {
        messageId: 'msg-a',
        eventId: '41',
        blocks: [{ type: 'text' as const, text: 'turn A output. ' }]
    }
    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-a',
        replayCheckpoint: stale
    })
    assert.equal(chatStreamStore.getSnapshot(key).streamingBlocks.length, 0)

    live.write(frame(doneEvent('42', 'msg-a')))
    live.close()
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    await sleep(20)

    // The same page result again, now that the turn it describes is over.
    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-a',
        replayCheckpoint: stale
    })

    const after = chatStreamStore.getSnapshot(key)
    assert.equal(after.streamingAssistantId, null)
    assert.equal(after.streamingBlocks.length, 0)
    assert.equal(after.status, 'idle')
})

// The terminal memory has to be a set, not the newest id. A page fetch can
// land arbitrarily late, and the reader keeps going: by the time its result
// is offered, the turn it describes may be several turns back.
test('a checkpoint for a turn that finished several turns ago is refused', async () => {
    const live = controlledTextStream()
    const calls = installFetch([live.stream, ''])
    chatStreamStore.getOrStart(streamParams(() => undefined))
    await waitFor(() => calls.length === 1)

    // Turn A finishes, then a whole turn B runs and finishes behind it.
    live.write(frame(doneEvent('10', 'msg-a')))
    live.write(frame(tokenEvent('11', 'turn B output. ', 'msg-b')))
    live.write(frame(doneEvent('12', 'msg-b')))
    live.close()
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    await sleep(20)

    // The page result for A, only now coming back.
    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-a',
        replayCheckpoint: {
            messageId: 'msg-a',
            eventId: '9',
            blocks: [{ type: 'text', text: 'turn A output. ' }]
        }
    })

    const after = chatStreamStore.getSnapshot(key)
    assert.equal(after.streamingAssistantId, null)
    assert.equal(after.streamingBlocks.length, 0)
    assert.equal(after.status, 'idle')
})

// The ordering guard. A page clears its inflight state one effect AFTER the
// store sees the terminal, so a re-render in that window offers a checkpoint
// for a turn that has just finished — into an entry that is idle by then.
// Taking it would flash a completed answer back into a live bubble.
test('a checkpoint for a turn that just finished is not re-seeded', async () => {
    const stream = controlledTextStream()
    const calls = installFetch([stream.stream])
    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-9',
        replayCheckpoint: {
            messageId: 'msg-9',
            eventId: '41',
            blocks: [{ type: 'text', text: 'the answer. ' }]
        }
    })
    await waitFor(() => calls.length === 1)
    stream.write(frame(doneEvent('42', 'msg-9')))
    // Closed as well as terminated: the reader runs to EOF, and until it
    // exits getOrStart refuses to do anything at all, which would hide the
    // guard under test behind its own admission check.
    stream.close()
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    // Status flips on the terminal frame, one tick before the reader sees EOF
    // and releases the entry. A terminal turn schedules no reconnect, so once
    // it has let go nothing else will touch the entry.
    await sleep(20)
    assert.equal(chatStreamStore.getSnapshot(key).streamingAssistantId, null)

    // The stale render, arriving after the terminal with the same pair.
    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-9',
        replayCheckpoint: {
            messageId: 'msg-9',
            eventId: '41',
            blocks: [{ type: 'text', text: 'the answer. ' }]
        }
    })

    const after = chatStreamStore.getSnapshot(key)
    assert.equal(after.streamingAssistantId, null)
    assert.equal(after.streamingBlocks.length, 0)
    assert.equal(after.status, 'idle')
})

// The corpus above builds its checkpoints from this store's own fold, so it
// cannot produce the one block shape only the SERVER emits: a `replace` that
// supersedes the answer with nothing leaves an empty text block behind, where
// the live reducer appends none. The working indicator represents that empty
// fold, while the paired cursor skips the superseded answer; replaying from
// event one would expose it again until the replace row arrived.
test('a checkpoint holding only an emptied answer skips the superseded prefix', async () => {
    const stream = controlledTextStream()
    const calls = installFetch([stream.stream])

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-1',
        replayCheckpoint: {
            messageId: 'msg-1',
            eventId: '2',
            blocks: [{ type: 'text', text: '' }]
        }
    })

    const seeded = chatStreamStore.getSnapshot(key)
    assert.equal(seeded.streamingBlocks.length, 0)
    assert.equal(seeded.status, 'connecting')
    await waitFor(() => calls.length === 1)
    assert.equal(calls[0]?.lastEventId, '2')
    assert.match(calls[0]?.url ?? '', /[?&]lastEventId=2(?:&|$)/)
    assert.doesNotMatch(calls[0]?.url ?? '', /replayMessageId/)

    // Only the tail after the empty replacement is applied; the superseded
    // draft and its replace row are already represented by the checkpoint.
    stream.write(frame(tokenEvent('3', 'a second attempt', 'msg-1')))
    await waitFor(() =>
        chatStreamStore
            .getSnapshot(key)
            .streamingBlocks.some(
                (block) =>
                    block.kind === 'token' && block.text === 'a second attempt'
            )
    )
    assert.deepEqual(chatStreamStore.getSnapshot(key).streamingBlocks, [
        { kind: 'token', text: 'a second attempt' }
    ])
})

// A checkpoint that names a turn the page did not report as inflight is a
// response that disagrees with itself. Seeding from it would show one turn's
// content under another turn's stream, so it is refused and the attach falls
// back to the replay.
test('a checkpoint for a different message is refused', async () => {
    const stream = controlledTextStream()
    const calls = installFetch([stream.stream])

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-1',
        replayCheckpoint: {
            messageId: 'msg-2',
            eventId: '9',
            blocks: [{ type: 'text', text: 'someone else output' }]
        }
    })

    assert.equal(chatStreamStore.getSnapshot(key).streamingBlocks.length, 0)
    await waitFor(() => calls.length === 1)
    assert.equal(calls[0]?.lastEventId, null)
    assert.match(calls[0]?.url ?? '', /[?&]replayMessageId=msg-1(?:&|$)/)
})

// The checkpoint is consumed once. A reconnect must resume from wherever the
// stream actually got to, not re-seed content the blocks already hold.
test('a reconnect after a checkpoint attach resumes from the live cursor', async () => {
    installFastReconnectTimers()
    const first = controlledTextStream()
    const calls = installFetch([
        first.stream,
        frame(tokenEvent('7', 'after reconnect.', 'msg-1'))
    ])

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-1',
        replayCheckpoint: {
            messageId: 'msg-1',
            eventId: '5',
            blocks: [{ type: 'text', text: 'checkpointed head. ' }]
        }
    })

    const seeded = chatStreamStore.getSnapshot(key)
    assert.deepEqual(seeded.streamingBlocks, [
        { kind: 'token', text: 'checkpointed head. ' }
    ])
    assert.equal(seeded.status, 'streaming')
    await waitFor(() => calls.length === 1)
    assert.equal(calls[0]?.lastEventId, '5')
    assert.match(calls[0]?.url ?? '', /[?&]lastEventId=5(?:&|$)/)
    assert.doesNotMatch(calls[0]?.url ?? '', /replayMessageId/)

    first.write(frame(tokenEvent('6', 'tail. ', 'msg-1')))
    await waitFor(() =>
        chatStreamStore
            .getSnapshot(key)
            .streamingBlocks.some(
                (block) =>
                    block.kind === 'token' &&
                    block.text === 'checkpointed head. tail. '
            )
    )
    first.close()

    await waitFor(() => calls.length >= 2)
    // From event 6, the last one actually delivered — not back to the
    // checkpoint's 5, which would re-send a row the blocks already hold.
    assert.equal(calls[1]?.lastEventId, '6')
    await waitFor(() =>
        chatStreamStore
            .getSnapshot(key)
            .streamingBlocks.some(
                (block) =>
                    block.kind === 'token' &&
                    block.text === 'checkpointed head. tail. after reconnect.'
            )
    )
})

// #721. The entry that adopts a checkpoint is not always a fresh one. A
// runtime outlives its reader — LRU eviction aborts it and keeps the entry,
// leaving a session keeps it too — so the entry taking a turn started
// elsewhere is often the same one that watched the PREVIOUS turn end. Its
// terminal is per-turn state, and adopting an unfinished turn ends it, exactly
// as beginAssistantTurn does for a turn started here.
//
// It used to survive the adoption, and then it decided the next question asked
// of it: the first drop before the new turn's first frame read the old
// terminal in isResumableTurn and was refused the ladder outright — no
// disconnect recorded, no reconnect, no fallback — leaving the bubble on the
// seeded content until a reload.
//
// The window that drop lands in is not a race. The tail of a turn sitting in a
// long tool call carries no data frame for as long as the tool runs, and a
// rolling API deploy bounces connections straight through it.
interface PreFirstFrameDrop {
    name: string
    reason: string
    open: () => { body: FetchOutcome; drop: () => void }
}

const preFirstFrameDrops: PreFirstFrameDrop[] = [
    {
        name: 'EOF',
        reason: 'eof',
        open: () => {
            const stream = controlledTextStream()
            return { body: stream.stream, drop: (): void => stream.close() }
        }
    },
    {
        name: 'reader exception',
        reason: 'reader_exception',
        open: () => {
            const stream = controlledTextStream()
            return {
                body: stream.stream,
                drop: (): void => stream.fail(new Error('network error'))
            }
        }
    },
    {
        // Rejected before there is a reader to drop, which is what a bounced
        // connection looks like when the bounce beats the response.
        name: 'fetch rejection',
        reason: 'reader_exception',
        open: () => ({
            body: new Error('network error'),
            drop: (): void => undefined
        })
    }
]

for (const variant of preFirstFrameDrops)
    test(`a checkpoint adopted after a previous turn's terminal still reconnects when it drops before its first frame (${variant.name})`, async () => {
        installFastReconnectTimers()
        const telemetry = installTelemetry()

        // Turn A, watched by this runtime all the way to its terminal.
        const finished = controlledTextStream()
        let calls = installFetch([finished.stream])
        chatStreamStore.getOrStart(streamParams(() => undefined))
        await waitFor(() => calls.length === 1)
        finished.write(frame(tokenEvent('9', 'turn A answer.', 'msg-a')))
        finished.write(frame(doneEvent('10', 'msg-a')))
        await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
        // The reader stops the way LRU eviction stops it: entry kept. A
        // finished turn schedules nothing, so nothing else touches it after.
        finished.close()
        await new Promise<void>((resolve) => setImmediate(resolve))

        // Turn B started on another tab; the message page comes back with it.
        const dropped = variant.open()
        const resumed = controlledTextStream()
        let fallbackCalls = 0
        calls = installFetch([dropped.body, resumed.stream])
        chatStreamStore.getOrStart({
            ...streamParams(() => {
                fallbackCalls += 1
            }),
            replayMessageId: 'msg-b',
            replayCheckpoint: {
                messageId: 'msg-b',
                eventId: '41',
                blocks: [{ type: 'text', text: 'turn B so far. ' }]
            }
        })

        const seeded = chatStreamStore.getSnapshot(key)
        assert.equal(seeded.streamingAssistantId, 'msg-b')
        assert.deepEqual(seeded.streamingBlocks, [
            { kind: 'token', text: 'turn B so far. ' }
        ])
        await waitFor(() => calls.length >= 1)
        assert.equal(calls[0]?.lastEventId, '41')
        dropped.drop()

        // The ladder, not a dead end — and it resumes from turn B's own
        // checkpoint cursor, because no event of B has landed yet.
        await waitFor(() => calls.length >= 2)
        assert.equal(calls[1]?.lastEventId, '41')
        assert.match(calls[1]?.url ?? '', /[?&]lastEventId=41(?:&|$)/)
        assert.doesNotMatch(calls[1]?.url ?? '', /replayMessageId/)
        assert.equal(fallbackCalls, 0)
        assert.deepEqual(
            chatStreamStore.getSnapshot(key).streamingBlocks,
            [{ kind: 'token', text: 'turn B so far. ' }],
            'the reconnect neither drops nor doubles the seeded content'
        )
        assert.deepEqual(
            telemetry.filter((event) => event.name === 'chat.sse.disconnected'),
            [
                {
                    name: 'chat.sse.disconnected',
                    reason: variant.reason,
                    status: null,
                    resuming: true,
                    attempt: 1,
                    agentId: 'agent-1',
                    sessionId: 'session-1',
                    messageId: 'msg-b'
                }
            ]
        )

        // The tail lands once, on top of the seed, and finishes the turn.
        resumed.write(frame(tokenEvent('42', 'and the rest.', 'msg-b')))
        await waitFor(() =>
            chatStreamStore
                .getSnapshot(key)
                .streamingBlocks.some(
                    (block) =>
                        block.kind === 'token' &&
                        block.text === 'turn B so far. and the rest.'
                )
        )
        assert.deepEqual(chatStreamStore.getSnapshot(key).streamingBlocks, [
            { kind: 'token', text: 'turn B so far. and the rest.' }
        ])
        resumed.write(frame(doneEvent('43', 'msg-b')))
        await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
        assert.equal(
            chatStreamStore.getSnapshot(key).streamingAssistantId,
            null
        )
        assert.equal(chatStreamStore.getSnapshot(key).streamErrors.length, 0)
    })

test('a checkpoint adopted after an acknowledged cancellation starts a resumable turn', async () => {
    installFastReconnectTimers()
    const cancelled = controlledTextStream()
    let calls = installFetch([cancelled.stream])
    chatStreamStore.getOrStart(streamParams(() => undefined))
    await waitFor(() => calls.length === 1)
    cancelled.write(frame(tokenEvent('9', 'turn A answer.', 'msg-a')))
    cancelled.write(frame(cancelledEvent('10', 'msg-a')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'cancelled')
    cancelled.close()
    await new Promise<void>((resolve) => setImmediate(resolve))

    chatStreamStore.acknowledgePersistedMessage(key, 'msg-a')
    assert.equal(chatStreamStore.getSnapshot(key).status, 'idle')

    const dropped = controlledTextStream()
    const resumed = controlledTextStream()
    calls = installFetch([dropped.stream, resumed.stream])
    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-b',
        replayCheckpoint: {
            messageId: 'msg-b',
            eventId: '41',
            blocks: [{ type: 'text', text: 'turn B so far. ' }]
        }
    })

    assert.equal(chatStreamStore.getSnapshot(key).status, 'streaming')
    await waitFor(() => calls.length === 1)
    dropped.close()
    await waitFor(() => calls.length === 2)
    assert.equal(calls[1]?.lastEventId, '41')

    resumed.write(frame(doneEvent('42', 'msg-b')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
})

// The other half of that boundary: the entry shape it runs on — idle, retained,
// its reader gone — is also the shape a late page result arrives at, so the
// completed-turn memory, not the entry's shape, is what decides. A checkpoint
// for a turn that finished several turns back is refused as it always was, and
// the refusal leaves the previous terminal exactly where it was: an EOF behind
// it still ends the runtime instead of climbing a ladder for a turn that is
// over.
test('a stale checkpoint refused by the completed set does not open the turn boundary', async () => {
    installFastReconnectTimers()
    const live = controlledTextStream()
    let calls = installFetch([live.stream])
    chatStreamStore.getOrStart(streamParams(() => undefined))
    await waitFor(() => calls.length === 1)

    // Turn A finishes, then a whole turn B runs and finishes behind it.
    live.write(frame(tokenEvent('9', 'turn A answer.', 'msg-a')))
    live.write(frame(doneEvent('10', 'msg-a')))
    live.write(frame(tokenEvent('11', 'turn B answer.', 'msg-b')))
    live.write(frame(doneEvent('12', 'msg-b')))
    await waitFor(() => chatStreamStore.getSnapshot(key).status === 'idle')
    live.close()
    await new Promise<void>((resolve) => setImmediate(resolve))

    // The page result for A, only now coming back, to an entry that is idle
    // and retained.
    const idle = controlledTextStream()
    let fallbackCalls = 0
    calls = installFetch([idle.stream, ''])
    chatStreamStore.getOrStart({
        ...streamParams(() => {
            fallbackCalls += 1
        }),
        replayMessageId: 'msg-a',
        replayCheckpoint: {
            messageId: 'msg-a',
            eventId: '9',
            blocks: [{ type: 'text', text: 'turn A answer.' }]
        }
    })

    const after = chatStreamStore.getSnapshot(key)
    assert.equal(after.streamingAssistantId, null)
    assert.equal(after.streamingBlocks.length, 0)
    assert.equal(after.status, 'idle')
    await waitFor(() => calls.length === 1)
    assert.equal(calls[0]?.lastEventId, null)
    assert.doesNotMatch(calls[0]?.url ?? '', /replayMessageId/)

    // And the terminal A left behind still stands.
    idle.close()
    await sleep(20)
    assert.equal(calls.length, 1)
    assert.equal(fallbackCalls, 0)
    assert.equal(chatStreamStore.getSnapshot(key).status, 'idle')
})

interface AttachResult {
    rendered: string
    contentBlocks: ChatContentBlock[]
    status: string
}

// Drive one attach to completion and report what the bubble ends up showing.
// `attach` null means the plain cold-load replay; otherwise the store is
// offered the checkpoint and this answers whatever request it then makes.
const renderAttach = async (
    events: ChatStreamEvent[],
    attach: { cut: number; checkpoint: ReplayCheckpoint } | null
): Promise<AttachResult> => {
    chatStreamStore.clear()
    const stream = controlledTextStream()
    const calls = installFetch([stream.stream])

    chatStreamStore.getOrStart({
        ...streamParams(() => undefined),
        replayMessageId: 'msg-1',
        replayCheckpoint: attach?.checkpoint ?? null
    })

    await waitFor(() => calls.length === 1)
    // Answer the request the store actually made. Taking the checkpoint means
    // asking for the tail; declining it means asking for the whole turn, and
    // the fallback has to produce the same transcript too.
    const tookCheckpoint =
        attach !== null && calls[0]?.lastEventId === attach.checkpoint.eventId
    const served = tookCheckpoint ? events.slice(attach.cut) : events
    for (const event of served) stream.write(frame(event))

    const read = (): string => {
        const snapshot = chatStreamStore.getSnapshot(key)
        return JSON.stringify(
            streamingBlocksToContentBlocks(snapshot.streamingBlocks)
        )
    }
    const rendered = await settled(read)
    const snapshot = chatStreamStore.getSnapshot(key)
    stream.close()
    chatStreamStore.clear()
    return {
        rendered,
        contentBlocks: streamingBlocksToContentBlocks(snapshot.streamingBlocks),
        status: snapshot.status
    }
}

// The reveal path is synchronous under node:test (no requestAnimationFrame,
// so the smoother is a passthrough), but the stream read is not. Wait for the
// rendered content to stop moving rather than for a count this test would
// have to derive from the reducer it is checking.
const settled = async (
    read: () => string,
    timeoutMs = 2000
): Promise<string> => {
    const start = Date.now()
    let previous = read()
    let stable = 0
    while (stable < 2) {
        if (Date.now() - start > timeoutMs)
            throw new Error('attach did not settle')
        await sleep(10)
        const current = read()
        if (current === previous) stable += 1
        else {
            previous = current
            stable = 0
        }
    }
    return previous
}
