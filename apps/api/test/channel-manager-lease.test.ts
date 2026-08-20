import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import { ChannelManagerService } from '../src/modules/channels/channel-manager.service'

const LEASE_TICK_MS = 15_000

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'fake',
    label: 'lease test',
    status: 'active',
    configJson: { note: null },
    credentialsCiphertext: null,
    keyVersion: 1,
    externalId: null,
    origin: null,
    lastConnectedAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    reconnectAttempts: 0,
    nextReconnectAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
})

const flushMicrotasks = async (rounds = 6): Promise<void> => {
    for (let i = 0; i < rounds; i++)
        await new Promise((resolve) => setImmediate(resolve))
}

interface LeaseHarness {
    manager: ChannelManagerService
    channels: ChannelRow[]
    starts: number
    stops: number
    acquireCalls: number
    renewCalls: number
    forceAcquireCalls: number
    releaseCalls: string[]
    releaseByHolderCalls: number
    setAcquireResult: (value: boolean) => void
    setStartError: (err: Error | null) => void
    setManagesConnection: (value: boolean) => void
}

const makeLeaseHarness = (channels: ChannelRow[]): LeaseHarness => {
    const state = {
        acquireResult: true,
        startError: null as Error | null,
        managesConnection: true
    }
    const harness = {
        channels,
        starts: 0,
        stops: 0,
        acquireCalls: 0,
        renewCalls: 0,
        forceAcquireCalls: 0,
        releaseCalls: [] as string[],
        releaseByHolderCalls: 0
    }
    const repo = {
        listSchedulable: async () =>
            channels.filter(
                (c) => c.status === 'active' || c.status === 'error'
            ),
        update: async () => null,
        markChannelConnected: async () => {},
        markChannelError: async () => null,
        renewChannelLeases: async (_holder: string, ids: string[]) => {
            if (ids.length > 0) harness.renewCalls += 1
            return state.acquireResult ? ids : []
        },
        tryAcquireChannelLease: async () => {
            harness.acquireCalls += 1
            return state.acquireResult
        },
        forceAcquireChannelLease: async () => {
            harness.forceAcquireCalls += 1
        },
        releaseChannelLease: async (channelId: string) => {
            harness.releaseCalls.push(channelId)
        },
        releaseChannelLeasesByHolder: async () => {
            harness.releaseByHolderCalls += 1
        }
    }
    const provider = {
        name: 'fake',
        managesConnection: () => state.managesConnection,
        validateConfig: (config: unknown) => config,
        start: async () => {
            harness.starts += 1
            if (state.startError) throw state.startError
            return {
                status: 'connected' as const,
                stop: async () => {
                    harness.stops += 1
                }
            }
        }
    }
    const bridge = {
        buildContext: () => ({}),
        handleInbound: async () => {},
        replayRecoverableInboundEvents: async () => 0,
        reconcilePendingReplies: async () => 0,
        sweepOutboundDeliveries: async () => 0
    }
    const manager = new ChannelManagerService(
        repo as never,
        { get: () => provider } as never,
        bridge as never,
        { event: () => {}, error: () => {} } as never,
        { get: () => undefined } as never
    )
    return {
        manager,
        ...harness,
        setAcquireResult: (value: boolean) => {
            state.acquireResult = value
        },
        setStartError: (err: Error | null) => {
            state.startError = err
        },
        setManagesConnection: (value: boolean) => {
            state.managesConnection = value
        },
        get starts() {
            return harness.starts
        },
        get stops() {
            return harness.stops
        },
        get acquireCalls() {
            return harness.acquireCalls
        },
        get renewCalls() {
            return harness.renewCalls
        },
        get forceAcquireCalls() {
            return harness.forceAcquireCalls
        },
        get releaseCalls() {
            return harness.releaseCalls
        },
        get releaseByHolderCalls() {
            return harness.releaseByHolderCalls
        }
    }
}

test('tick starts channel only after acquiring the lease', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const h = makeLeaseHarness([makeChannel()])

    h.manager.onModuleInit()
    await flushMicrotasks()

    assert.equal(h.acquireCalls, 1)
    assert.equal(h.starts, 1)
})

test('tick does not start channel when lease is held elsewhere', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const h = makeLeaseHarness([makeChannel()])
    h.setAcquireResult(false)

    h.manager.onModuleInit()
    await flushMicrotasks()

    assert.equal(h.acquireCalls, 1)
    assert.equal(h.starts, 0)
})

test('tick stops channel when the lease is lost', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const h = makeLeaseHarness([makeChannel()])

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts, 1)

    h.setAcquireResult(false)
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()

    assert.equal(h.stops, 1)
    assert.equal(h.starts, 1)
})

test('tick restarts on config fingerprint change but not on status churn', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const channel = makeChannel()
    const channels = [channel]
    const h = makeLeaseHarness(channels)

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts, 1)

    channels[0] = {
        ...channel,
        lastErrorAt: new Date(),
        updatedAt: new Date(Date.now() + 1000)
    }
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.equal(h.starts, 1, 'status-only churn must not restart')
    assert.equal(h.stops, 0)

    channels[0] = {
        ...channel,
        configJson: { note: 'changed' },
        updatedAt: new Date(Date.now() + 2000)
    }
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.equal(h.stops, 1, 'config change stops the old connection')
    assert.equal(h.starts, 2, 'config change starts a new connection')
})

test('onModuleDestroy releases held leases', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const h = makeLeaseHarness([makeChannel()])

    h.manager.onModuleInit()
    await flushMicrotasks()
    await h.manager.onModuleDestroy()

    assert.equal(h.releaseByHolderCalls, 1)
    assert.equal(h.stops, 1)
})

test('reload force-acquires and starts locally', async () => {
    const channel = makeChannel()
    const h = makeLeaseHarness([channel])

    await h.manager.reload(channel)

    assert.equal(h.forceAcquireCalls, 1)
    assert.equal(h.starts, 1)
})

test('reload on a paused channel only stops', async () => {
    const channel = makeChannel({ status: 'paused' })
    const h = makeLeaseHarness([channel])

    await h.manager.reload(channel)

    assert.equal(h.forceAcquireCalls, 0)
    assert.equal(h.starts, 0)
})

test('tick stops and releases a channel that got paused', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const channel = makeChannel()
    const channels = [channel]
    const h = makeLeaseHarness(channels)

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts, 1)

    channels[0] = { ...channel, status: 'paused' }
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()

    assert.equal(h.stops, 1)
    assert.deepEqual(h.releaseCalls, [channel.id])
})

test('webhook-style channels are neither leased nor started', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const h = makeLeaseHarness([makeChannel()])
    h.setManagesConnection(false)

    h.manager.onModuleInit()
    await flushMicrotasks()
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()

    assert.equal(h.acquireCalls, 0, 'no lease upserts for webhook channels')
    assert.equal(h.renewCalls, 0)
    assert.equal(h.starts, 0, 'no noop handle to start')
})

test('reload skips webhook-style channels', async () => {
    const channel = makeChannel()
    const h = makeLeaseHarness([channel])
    h.setManagesConnection(false)

    await h.manager.reload(channel)

    assert.equal(h.forceAcquireCalls, 0)
    assert.equal(h.starts, 0)
})

test('tick tears down a handle whose channel switched to webhook mode', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const channel = makeChannel()
    const h = makeLeaseHarness([channel])

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts, 1, 'ws-mode channel started')

    // e.g. lark subscriptionMode websocket -> webhook updated on another
    // instance: this owner must notice and stop its now-pointless connection.
    h.setManagesConnection(false)
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()

    assert.equal(h.stops, 1)
    assert.deepEqual(h.releaseCalls, [channel.id])
    assert.equal(h.starts, 1, 'never restarted as webhook')
})

test('held leases renew in one batch per tick instead of per-channel upserts', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const h = makeLeaseHarness([
        makeChannel({ id: 'chn-1' }),
        makeChannel({ id: 'chn-2' }),
        makeChannel({ id: 'chn-3' })
    ])

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts, 3)
    assert.equal(h.acquireCalls, 3, 'initial acquisition is per-channel')

    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()

    assert.equal(h.acquireCalls, 3, 'no per-channel upserts once engaged')
    assert.equal(h.renewCalls, 1, 'one batched renewal for all held leases')
})
