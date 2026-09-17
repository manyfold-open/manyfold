import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { ChatMessage, ChatStreamEvent } from '@manyfold/shared'
import {
    chatStreamStore,
    type StartStreamParams,
    type ChatStreamTelemetryEvent
} from '../src/lib/chatStreamStore'

const encoder = new TextEncoder()
const key = chatStreamStore.keyOf('agent', 'session')
const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
}
const fixture = (
    t: TestContext,
    fallback?: StartStreamParams['onFallback']
) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 })
    t.mock.method(performance, 'now', () => Date.now())
    const streams: Array<{
        controller: ReadableStreamDefaultController<Uint8Array>
        signal: AbortSignal
    }> = []
    const requests: Array<RequestInit | undefined> = []
    const telemetry: ChatStreamTelemetryEvent[] = []
    let failing = false
    t.mock.method(
        globalThis,
        'fetch',
        async (_input: unknown, init?: RequestInit) => {
            requests.push(init)
            if (failing) throw new TypeError('fixture disconnected')
            const signal = init?.signal as AbortSignal
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        streams.push({ controller, signal })
                        signal.addEventListener(
                            'abort',
                            () =>
                                controller.error(
                                    new DOMException('aborted', 'AbortError')
                                ),
                            { once: true }
                        )
                    }
                }),
                { status: 200 }
            )
        }
    )
    chatStreamStore.setTelemetry((event) => telemetry.push(event))
    t.after(() => {
        chatStreamStore.clear()
        chatStreamStore.setTelemetry(null)
    })
    const params: StartStreamParams = {
        agentId: 'agent',
        sessionId: 'session',
        baseUrl: 'http://fixture.test',
        getToken: async () => '',
        initialLastEventId: '1',
        onFallback: fallback
    }
    const tick = async (ms: number) => {
        t.mock.timers.tick(ms)
        await flush()
    }
    const push = async (text: string) => {
        streams.at(-1)!.controller.enqueue(encoder.encode(text))
        await flush()
    }
    return {
        params,
        streams,
        requests,
        telemetry,
        tick,
        push,
        snapshot: () => chatStreamStore.getSnapshot(key),
        start: async (messageId?: string) => {
            if (messageId)
                chatStreamStore.beginAssistantTurn(key, params, messageId)
            else chatStreamStore.getOrStart(params)
            await flush()
        },
        disconnect: async (rejectFetch = true) => {
            failing = rejectFetch
            streams
                .at(-1)!
                .controller.error(new TypeError('fixture transport reset'))
            await flush()
        },
        allowFetch: () => {
            failing = false
        }
    }
}
const event = (type: 'token' | 'suspended' | 'done', id = 'message') => {
    const base = {
        eventId: '2',
        seq: 2,
        messageId: id,
        sessionId: 'session',
        createdAt: '2026-09-17T00:00:00Z'
    }
    const value: ChatStreamEvent =
        type === 'token'
            ? { ...base, type, text: 'fixture' }
            : type === 'done'
              ? { ...base, type, finalMessageId: id }
              : {
                    ...base,
                    type,
                    reason: 'daemon_offline',
                    daemonId: 'daemon',
                    daemonExecRef: 'exec'
                }
    return `data: ${JSON.stringify(value)}\n\n`
}
const terminalPage = (id: string) => ({
    messages: [{ id } as ChatMessage],
    inflightAssistantMessageId: null
})

test('outage budget stops cursor-only retries and bounds an unsettled final refetch', async (t) => {
    const signals: AbortSignal[] = []
    const h = fixture(t, (signal) => {
        signals.push(signal!)
        return new Promise(() => {})
    })
    await h.start()
    await h.disconnect()
    for (let i = 0; i < 10; i++) await h.tick(30_000)
    assert.equal(h.snapshot().reconnectRequired, true)
    assert.equal(h.snapshot().stalled, true)
    assert.equal(h.snapshot().status, 'idle', 'a cursor-only listener does not invent an active turn')
    assert.equal(h.snapshot().streamingAssistantId, null)
    const count = h.requests.length
    chatStreamStore.getOrStart(h.params)
    await h.tick(60 * 60_000)
    assert.equal(h.requests.length, count)
    assert.ok(signals.length > 0 && signals.every((signal) => signal.aborted))
    h.allowFetch()
    chatStreamStore.reconnect(key)
    chatStreamStore.reconnect(key)
    await flush()
    assert.equal(h.requests.length, count + 1)
    assert.equal(h.snapshot().reconnectRequired, false)
    assert.ok(
        h.requests.every((request) => request?.method === 'GET'),
        'manual reconnect never resends the turn'
    )
})

test('healthy keepalives restore transport without pretending a silent tool turn completed', async (t) => {
    const h = fixture(t)
    await h.start('message')
    await h.push(event('token'))
    await h.disconnect(false)
    await h.tick(500)
    await h.tick(15_000)
    await h.push(': keepalive 15000\n\n')
    assert.equal(
        h.telemetry.filter((item) => item.name === 'chat.sse.reconnected')
            .length,
        0
    )
    await h.tick(15_000)
    await h.push(': keepalive 30000\n\n')
    assert.equal(h.telemetry.at(-1)?.name, 'chat.sse.reconnected')
    await h.tick(6 * 60_000)
    assert.equal(h.snapshot().reconnectRequired, false)
    assert.equal(h.snapshot().streamingAssistantId, 'message')
    assert.equal(
        h.snapshot().stalled,
        true,
        'business silence keeps its independent hint'
    )
    assert.equal(h.streams.at(-1)?.signal.aborted, false)
    assert.equal(h.requests.length, 2)
})

test('HTTP 200 and arbitrary comments do not reset a failed transport budget', async (t) => {
    const h = fixture(t)
    await h.start('message')
    await h.disconnect(false)
    await h.tick(500)
    await h.push(': hello\n\n')
    await h.tick(300_000)
    assert.equal(h.snapshot().reconnectRequired, true)
    assert.equal(h.streams.at(-1)?.signal.aborted, true)
    assert.equal(h.snapshot().streamingAssistantId, 'message')
})

for (const status of ['suspended', 'cancelling'] as const) {
    test(`outage stops automatic work without changing ${status} turn semantics`, async (t) => {
        const h = fixture(t)
        await h.start('message')
        if (status === 'suspended') await h.push(event('suspended'))
        else chatStreamStore.cancel(key)
        await h.disconnect()
        await h.tick(300_000)
        assert.equal(h.snapshot().status, status)
        assert.equal(h.snapshot().streamingAssistantId, 'message')
        assert.equal(h.snapshot().reconnectRequired, true)
    })
}

test('a persisted terminal cancels the reader and deadline; stale checkpoint cannot resurrect it', async (t) => {
    const h = fixture(t)
    await h.start('message')
    await h.disconnect(false)
    await h.tick(500)
    chatStreamStore.acknowledgeMessagePage(key, terminalPage('message'))
    assert.equal(h.streams.at(-1)?.signal.aborted, true)
    const count = h.requests.length
    await h.tick(300_000)
    assert.equal(h.requests.length, count)
    assert.equal(h.snapshot().status, 'idle')
    assert.equal(h.snapshot().reconnectRequired, false)
    chatStreamStore.getOrStart({
        ...h.params,
        replayMessageId: 'message',
        replayCheckpoint: { messageId: 'message', eventId: '1', blocks: [] }
    })
    await flush()
    assert.equal(h.snapshot().streamingAssistantId, null)
})

test('idle page recovery cannot finish a pending POST or a newly admitted turn', async (t) => {
    const h = fixture(t)
    await h.start()
    await h.disconnect()
    chatStreamStore.markTurnPending(key, h.params)
    chatStreamStore.acknowledgeMessagePage(key, terminalPage('old'))
    assert.equal(h.snapshot().status, 'connecting')
    chatStreamStore.beginAssistantTurn(key, h.params, 'new')
    chatStreamStore.acknowledgeMessagePage(key, terminalPage('old'))
    assert.equal(h.snapshot().streamingAssistantId, 'new')
})

test('new turn and route detach abort stale page consumers without late outage writes', async (t) => {
    const signals: AbortSignal[] = []
    const fallback: StartStreamParams['onFallback'] = (signal) => {
        signals.push(signal!)
        return new Promise(() => {})
    }
    const h = fixture(t, fallback)
    await h.start('old')
    await h.disconnect()
    await h.tick(300_000)
    chatStreamStore.beginAssistantTurn(key, h.params, 'new')
    assert.ok(signals.every((signal) => signal.aborted))
    assert.equal(h.snapshot().reconnectRequired, false)
    await flush()
    await h.tick(300_000)
    assert.equal(h.snapshot().reconnectRequired, true)
    chatStreamStore.detachFallback(key, fallback)
    assert.ok(signals.every((signal) => signal.aborted))
})

test('thawing a delayed retry checks the deadline before attaching', async (t) => {
    const h = fixture(t)
    await h.start('message')
    await h.disconnect()
    const count = h.requests.length
    t.mock.timers.setTime(1_000 + 10 * 60_000)
    await h.tick(500)
    assert.equal(h.requests.length, count)
    assert.equal(h.snapshot().reconnectRequired, true)
})

test('LRU retirement releases timers but a revisit cannot reset the expired outage', async t => {
    let fallbacks = 0
    const h = fixture(t, () => { fallbacks++ })
    await h.start('message')
    await h.disconnect(false)
    await h.tick(500)
    const retired = h.streams.at(-1)!
    for (let i = 0; i < 4; i++) {
        const sessionId = `other-${i}`
        chatStreamStore.beginAssistantTurn(chatStreamStore.keyOf('agent', sessionId), { ...h.params, sessionId, onFallback: undefined }, `message-${i}`)
        await flush()
    }
    assert.equal(retired.signal.aborted, true)
    await h.tick(300_000)
    assert.equal(fallbacks, 0)
    const requests = h.requests.length
    chatStreamStore.getOrStart(h.params)
    await flush()
    assert.equal(h.requests.length, requests)
    assert.equal(h.snapshot().reconnectRequired, true)
})

test('only valid HTTP trace correlation from the current reader reaches disconnect telemetry', async (t) => {
    const h = fixture(t)
    const traceId = '1234567890abcdef1234567890abcdef'
    await h.start('message')
    await h.push(`: trace ${traceId} 1234567890abcdef\n\n`)
    await h.disconnect(false)
    assert.equal(h.telemetry.at(-1)?.span_id, '1234567890abcdef')
    await h.tick(500)
    await h.push(`: trace ${traceId} fedcba0987654321\n\n`)
    await h.disconnect()
    assert.equal(h.telemetry.at(-1)?.span_id, 'fedcba0987654321')
    assert.equal(h.telemetry.at(-1)?.trace_id, traceId)
})

for (const status of [400, 503]) {
    test(`a retired fetch delivering HTTP ${status} cannot disturb its healthy successor`, async (t) => {
        const h = fixture(t)
        await h.start('message')
        const currentFetch = globalThis.fetch
        let deliver!: (response: Response) => void
        let deferred = true
        t.mock.method(
            globalThis,
            'fetch',
            (...args: Parameters<typeof fetch>) => {
                if (deferred) {
                    deferred = false
                    return new Promise<Response>((resolve) => {
                        deliver = resolve
                    })
                }
                return currentFetch(...args)
            }
        )
        await h.disconnect(false)
        await h.tick(500)
        assert.ok(deliver)
        await h.tick(300_000)
        assert.equal(h.snapshot().reconnectRequired, true)
        chatStreamStore.reconnect(key)
        await flush()
        await h.push(
            ': trace 1234567890abcdef1234567890abcdef fedcba0987654321\n\n'
        )
        await h.push(event('token'))
        const snapshot = h.snapshot()
        const observed = [...h.telemetry]
        const requests = h.requests.length
        let cancelled = false
        deliver(
            new Response(
                new ReadableStream({
                    cancel() {
                        cancelled = true
                    }
                }),
                { status }
            )
        )
        await flush()
        assert.deepEqual(h.snapshot(), snapshot)
        assert.deepEqual(h.telemetry, observed)
        assert.equal(cancelled, true)
        await h.tick(30_000)
        assert.equal(h.requests.length, requests)
        assert.equal(h.snapshot().reconnectRequired, false)
    })
}
