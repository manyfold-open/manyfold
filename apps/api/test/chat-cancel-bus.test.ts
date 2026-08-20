import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatCancelBus } from '../src/modules/chat/chat-cancel-bus'
import { ChatService } from '../src/modules/chat/chat.service'

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

interface ServiceHarness {
    service: ChatService
    marked: string[]
    notified: string[]
    telemetryEvents: Array<{ name: string; props: unknown }>
    fireBusCancel: (messageId: string) => void
    trackAdapter: (messageId: string) => AbortController
}

const makeService = (opts: { inflight?: string } = {}): ServiceHarness => {
    const marked: string[] = []
    const notified: string[] = []
    const telemetryEvents: Array<{ name: string; props: unknown }> = []
    const handlers: Array<(messageId: string) => void> = []
    const repo = {
        getSession: async () => sessionRow,
        latestInflightMessageId: async () => opts.inflight ?? null,
        markCancelRequested: async (messageId: string) => {
            marked.push(messageId)
        },
        getMessageById: async (messageId: string) => ({
            id: messageId,
            sessionId: 'session-1'
        })
    }
    const bus = {
        onCancelRequested: (handler: (messageId: string) => void) => {
            handlers.push(handler)
        },
        notify: (messageId: string) => {
            notified.push(messageId)
        }
    }
    const service = new ChatService(
        {} as never,
        repo as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            event: (name: string, props: unknown) =>
                telemetryEvents.push({ name, props })
        } as never,
        undefined as never,
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
        bus as never
    )
    return {
        service,
        marked,
        notified,
        telemetryEvents,
        fireBusCancel: (messageId) => {
            for (const handler of handlers) handler(messageId)
        },
        trackAdapter: (messageId) => {
            const controller = new AbortController()
            ;(
                service as unknown as {
                    runningAdapters: Map<string, AbortController>
                }
            ).runningAdapters.set(messageId, controller)
            return controller
        }
    }
}

// The #402 gap-2 regression: a cancel landing on a non-owner instance used to
// write cancel_requested_at (which only the daemon path reads) and return —
// sprite and external-provider turns never saw it.
test('cancel with no local adapter marks the message and broadcasts to peers', async () => {
    const harness = makeService({ inflight: 'msg-1' })
    await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
    assert.deepEqual(harness.marked, ['msg-1'])
    assert.deepEqual(harness.notified, ['msg-1'])
    assert.deepEqual(
        harness.telemetryEvents.map((e) => e.name),
        ['chat.cancel.broadcast']
    )
})

test('cancelMessage with no local adapter marks and broadcasts the named turn', async () => {
    const harness = makeService()
    await harness.service.cancelMessage('user-1', 'agent-1', 'msg-a2a')
    assert.deepEqual(harness.marked, ['msg-a2a'])
    assert.deepEqual(harness.notified, ['msg-a2a'])
})

test('a bus-delivered cancel aborts the locally running adapter', () => {
    const harness = makeService()
    const controller = harness.trackAdapter('msg-2')
    harness.fireBusCancel('msg-2')
    assert.equal(controller.signal.aborted, true)
    assert.deepEqual(
        harness.telemetryEvents.map((e) => e.name),
        ['chat.cancel.bus_abort']
    )
})

test('a bus-delivered cancel for a turn this instance does not own is ignored', () => {
    const harness = makeService()
    const controller = harness.trackAdapter('msg-3')
    harness.fireBusCancel('msg-other')
    assert.equal(controller.signal.aborted, false)
    assert.deepEqual(harness.telemetryEvents, [])
})

test('a locally running adapter is aborted directly without a broadcast', async () => {
    const harness = makeService({ inflight: 'msg-4' })
    const controller = harness.trackAdapter('msg-4')
    await harness.service.cancelStream('user-1', 'agent-1', 'session-1')
    assert.equal(controller.signal.aborted, true)
    assert.deepEqual(harness.marked, [])
    assert.deepEqual(harness.notified, [])
})

// --- ChatCancelBus payload routing over a fake pg client ---

interface BusHarness {
    bus: ChatCancelBus
    dispatch: (payload: string) => void
    notifies: string[]
    startListening: () => Promise<void>
}

const makeBus = (): BusHarness => {
    let listener: ((payload: string) => void) | null = null
    const notifies: string[] = []
    const client = {
        listen: async (
            _channel: string,
            onNotify: (payload: string) => void
        ) => {
            listener = onNotify
            return { unlisten: async () => {} }
        },
        notify: async (_channel: string, payload: string) => {
            notifies.push(payload)
        }
    }
    const bus = new ChatCancelBus({ $client: client } as never)
    return {
        bus,
        notifies,
        dispatch: (payload) => listener?.(payload),
        startListening: async () => {
            bus.onApplicationBootstrap()
            const deadline = Date.now() + 1_000
            while (listener === null && Date.now() < deadline)
                await new Promise((resolve) => setImmediate(resolve))
            assert.ok(listener, 'expected the bus to LISTEN on bootstrap')
        }
    }
}

test('bus delivers peer cancel payloads to handlers', async () => {
    const harness = makeBus()
    await harness.startListening()
    const received: string[] = []
    harness.bus.onCancelRequested((messageId) => received.push(messageId))
    harness.dispatch(JSON.stringify({ o: 'another-instance', m: 'msg-9' }))
    assert.deepEqual(received, ['msg-9'])
})

test('bus filters its own notifications and malformed payloads', async () => {
    const harness = makeBus()
    await harness.startListening()
    const received: string[] = []
    harness.bus.onCancelRequested((messageId) => received.push(messageId))
    harness.bus.notify('msg-self')
    const deadline = Date.now() + 1_000
    while (harness.notifies.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setImmediate(resolve))
    // Replay this instance's own payload back at it, as pg LISTEN would.
    harness.dispatch(harness.notifies[0])
    harness.dispatch('not json')
    harness.dispatch(JSON.stringify({ o: 'peer' }))
    assert.deepEqual(received, [])
})
