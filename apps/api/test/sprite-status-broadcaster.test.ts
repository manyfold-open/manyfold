import type {
    SpriteStatusEvent,
    SpriteStatusUpdate
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { SpriteStatusBroadcaster } from '../src/modules/agents/sprite-status/sprite-status-broadcaster'
import {
    SpriteStatusBus,
    type SpriteStatusDeliveryOpts
} from '../src/modules/agents/sprite-status/sprite-status-bus'

const update = (agentId: string): SpriteStatusUpdate => ({
    agentId,
    spriteName: 'nca-u-1-main',
    spriteStatus: 'running',
    k8sPodPhase: null,
    at: '2026-06-12T00:00:00.000Z'
})

const quotaWarning = {
    type: 'quota-warning' as const,
    code: 'concurrent' as const,
    usage: 3,
    limit: 3,
    planName: 'pro',
    at: '2026-06-12T00:00:00.000Z'
}

test('emit reaches a local subscriber', () => {
    const net = makeNetwork()
    const a = makeNode(net)
    const events: SpriteStatusEvent[] = []

    a.subscribe('u-1', {
        send: (event) => events.push(event),
        close: () => undefined
    })
    a.emit('u-1', update('agent-1'))

    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, 'update')
})

test('emit on one instance reaches a subscriber on another instance', () => {
    const net = makeNetwork()
    const emitter = makeNode(net)
    const receiver = makeNode(net)
    const events: SpriteStatusEvent[] = []

    receiver.subscribe('u-1', {
        send: (event) => events.push(event),
        close: () => undefined
    })
    emitter.emit('u-1', update('agent-1'))

    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, 'update')
    assert.equal((events[0] as { agentId?: string }).agentId, 'agent-1')
})

test('subscribers on both instances each receive the event exactly once', () => {
    const net = makeNetwork()
    const a = makeNode(net)
    const b = makeNode(net)
    const eventsA: SpriteStatusEvent[] = []
    const eventsB: SpriteStatusEvent[] = []

    a.subscribe('u-1', {
        send: (event) => eventsA.push(event),
        close: () => undefined
    })
    b.subscribe('u-1', {
        send: (event) => eventsB.push(event),
        close: () => undefined
    })
    a.emit('u-1', update('agent-1'))

    assert.equal(eventsA.length, 1)
    assert.equal(eventsB.length, 1)
})

// WHY: the sandbox detail panel dropped its 5s polling — host-update events on
// this stream are now the only live freshness path for host-level status, so
// they must ride the same local + cross-instance fan-out as agent updates.
test('emitHostUpdate reaches local and remote subscribers as host-update', () => {
    const net = makeNetwork()
    const emitter = makeNode(net)
    const receiver = makeNode(net)
    const localEvents: SpriteStatusEvent[] = []
    const remoteEvents: SpriteStatusEvent[] = []

    emitter.subscribe('u-1', {
        send: (event) => localEvents.push(event),
        close: () => undefined
    })
    receiver.subscribe('u-1', {
        send: (event) => remoteEvents.push(event),
        close: () => undefined
    })
    emitter.emitHostUpdate('u-1', {
        hostId: 'host-1',
        spriteStatus: 'running',
        at: '2026-06-12T00:00:00.000Z'
    })

    for (const events of [localEvents, remoteEvents]) {
        assert.equal(events.length, 1)
        assert.equal(events[0]?.type, 'host-update')
        assert.equal(
            (events[0] as { hostId?: string }).hostId,
            'host-1'
        )
    }
})

test('emit only reaches subscribers of the same user', () => {
    const net = makeNetwork()
    const emitter = makeNode(net)
    const receiver = makeNode(net)
    const events: SpriteStatusEvent[] = []

    receiver.subscribe('u-2', {
        send: (event) => events.push(event),
        close: () => undefined
    })
    emitter.emit('u-1', update('agent-1'))

    assert.equal(events.length, 0)
})

test('adminOnly quota warning skips non-admin subscribers on every instance', () => {
    const net = makeNetwork()
    const emitter = makeNode(net)
    const receiver = makeNode(net)
    const adminEvents: SpriteStatusEvent[] = []
    const memberEvents: SpriteStatusEvent[] = []

    receiver.subscribe('u-1', {
        send: (event) => adminEvents.push(event),
        close: () => undefined,
        isAdmin: true
    })
    receiver.subscribe('u-1', {
        send: (event) => memberEvents.push(event),
        close: () => undefined
    })
    emitter.emitQuotaWarning('u-1', quotaWarning, { adminOnly: true })
    emitter.emitQuotaWarning('u-1', quotaWarning)

    assert.equal(adminEvents.length, 2)
    assert.equal(memberEvents.length, 1)
})

test('unsubscribe stops delivery from remote emits', () => {
    const net = makeNetwork()
    const emitter = makeNode(net)
    const receiver = makeNode(net)
    const events: SpriteStatusEvent[] = []

    const unsubscribe = receiver.subscribe('u-1', {
        send: (event) => events.push(event),
        close: () => undefined
    })
    emitter.emit('u-1', update('agent-1'))
    unsubscribe()
    emitter.emit('u-1', update('agent-1'))

    assert.equal(events.length, 1)
})

test('bus skips self-origin notifications and forwards foreign ones', async () => {
    let onNotify: ((payload: string) => void) | null = null
    const sent: Array<{ channel: string; payload: string }> = []
    const client = {
        listen: async (channel: string, fn: (payload: string) => void) => {
            assert.equal(channel, 'sprite_status_events')
            onNotify = fn
            return { unlisten: async () => undefined }
        },
        notify: async (channel: string, payload: string) => {
            sent.push({ channel, payload })
        }
    }
    const bus = new SpriteStatusBus({ $client: client } as never)
    bus.onApplicationBootstrap()
    await waitFor(() => onNotify !== null)

    const got: Array<{
        userId: string
        event: SpriteStatusEvent
        opts: SpriteStatusDeliveryOpts
    }> = []
    bus.onEvent((userId, event, opts) => got.push({ userId, event, opts }))

    bus.publish('u-1', { type: 'update', ...update('agent-1') })
    await waitFor(() => sent.length === 1)
    assert.equal(sent[0]?.channel, 'sprite_status_events')

    onNotify!(sent[0]!.payload)
    assert.equal(got.length, 0)

    const foreign = JSON.stringify({
        ...(JSON.parse(sent[0]!.payload) as Record<string, unknown>),
        o: 'another-instance'
    })
    onNotify!(foreign)
    assert.equal(got.length, 1)
    assert.equal(got[0]?.userId, 'u-1')
    assert.equal(got[0]?.event.type, 'update')
    assert.equal(got[0]?.opts.adminOnly, false)

    onNotify!('not json')
    assert.equal(got.length, 1)

    await bus.onApplicationShutdown()
})

test('bus carries the adminOnly flag across instances', async () => {
    let onNotify: ((payload: string) => void) | null = null
    const sent: string[] = []
    const client = {
        listen: async (_channel: string, fn: (payload: string) => void) => {
            onNotify = fn
            return { unlisten: async () => undefined }
        },
        notify: async (_channel: string, payload: string) => {
            sent.push(payload)
        }
    }
    const bus = new SpriteStatusBus({ $client: client } as never)
    bus.onApplicationBootstrap()
    await waitFor(() => onNotify !== null)

    const got: SpriteStatusDeliveryOpts[] = []
    bus.onEvent((_userId, _event, opts) => got.push(opts))

    bus.publish('u-1', quotaWarning, { adminOnly: true })
    await waitFor(() => sent.length === 1)
    const foreign = JSON.stringify({
        ...(JSON.parse(sent[0]!) as Record<string, unknown>),
        o: 'another-instance'
    })
    onNotify!(foreign)

    assert.equal(got.length, 1)
    assert.equal(got[0]?.adminOnly, true)

    await bus.onApplicationShutdown()
})

type BusHandler = (
    userId: string,
    event: SpriteStatusEvent,
    opts: SpriteStatusDeliveryOpts
) => void

// Models the real bus contract: publish fans out to every other node and
// never echoes back to the publishing node (self-origin filtering).
class FakeBus {
    private readonly handlers: BusHandler[] = []

    constructor(private readonly net: FakeBus[]) {
        net.push(this)
    }

    onEvent(handler: BusHandler): void {
        this.handlers.push(handler)
    }

    publish(
        userId: string,
        event: SpriteStatusEvent,
        opts: SpriteStatusDeliveryOpts = {}
    ): void {
        for (const node of this.net) {
            if (node === this) continue
            node.deliver(userId, event, opts)
        }
    }

    deliver(
        userId: string,
        event: SpriteStatusEvent,
        opts: SpriteStatusDeliveryOpts
    ): void {
        for (const handler of this.handlers) handler(userId, event, opts)
    }
}

const makeNetwork = (): FakeBus[] => []

const makeNode = (net: FakeBus[]): SpriteStatusBroadcaster =>
    new SpriteStatusBroadcaster(new FakeBus(net) as unknown as SpriteStatusBus)

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 1000
): Promise<void> => {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs)
            throw new Error('waitFor timed out')
        await sleep(5)
    }
}
