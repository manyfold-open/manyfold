import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import { ChannelManagerService } from '../src/modules/channels/channel-manager.service'

const LEASE_TICK_MS = 15_000

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'lark',
    label: 'lark test',
    status: 'active',
    configJson: { subscriptionMode: 'websocket' },
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

type HandleStatus = 'connected' | 'connecting'
type StatusCallback = (
    status: 'connected' | 'connecting' | 'error',
    detail?: { message?: string }
) => void

interface ReconnectHarness {
    manager: ChannelManagerService
    channels: ChannelRow[]
    telemetryEvents: { name: string; attrs: Record<string, unknown> }[]
    starts: () => number
    stops: () => number
    setStartError: (err: Error | null) => void
    sendStatus: StatusCallback
}

// The fake repo applies markChannelError/markChannelConnected/
// armChannelReconnect to the rows the same way the real repository does,
// because the reconnect flow is driven entirely by that persisted state
// (status + next_reconnect_at) across ticks.
const makeHarness = (
    channels: ChannelRow[],
    opts: {
        managesConnection?: boolean
        handleStatus?: HandleStatus
    } = {}
): ReconnectHarness => {
    const state = {
        startError: null as Error | null,
        starts: 0,
        stops: 0,
        onStatus: null as StatusCallback | null
    }
    const telemetryEvents: { name: string; attrs: Record<string, unknown> }[] =
        []
    const findIndex = (id: string): number =>
        channels.findIndex((c) => c.id === id)
    const repo = {
        listSchedulable: async () =>
            channels.filter(
                (c) => c.status === 'active' || c.status === 'error'
            ),
        renewChannelLeases: async (_holder: string, ids: string[]) => ids,
        update: async () => null,
        markChannelConnected: async (id: string) => {
            const i = findIndex(id)
            if (i < 0) return
            channels[i] = {
                ...channels[i],
                status: 'active',
                lastConnectedAt: new Date(),
                lastErrorAt: null,
                lastErrorMessage: null,
                reconnectAttempts: 0,
                nextReconnectAt: null
            }
        },
        markChannelError: async (id: string, message: string) => {
            const i = findIndex(id)
            if (i < 0) return null
            const attempts = channels[i].reconnectAttempts + 1
            const backoffS = Math.min(
                600,
                30 * 2 ** Math.min(channels[i].reconnectAttempts, 6)
            )
            channels[i] = {
                ...channels[i],
                status: 'error',
                lastErrorAt: new Date(),
                lastErrorMessage: message,
                reconnectAttempts: attempts,
                nextReconnectAt: new Date(Date.now() + backoffS * 1000)
            }
            return attempts
        },
        armChannelReconnect: async (id: string) => {
            const i = findIndex(id)
            if (i < 0 || channels[i].status !== 'error') return null
            const before = channels[i].reconnectAttempts
            const backoffS = Math.min(600, 30 * 2 ** Math.min(before, 6))
            channels[i] = {
                ...channels[i],
                reconnectAttempts: before + 1,
                nextReconnectAt: new Date(Date.now() + backoffS * 1000)
            }
            return before + 1
        },
        tryAcquireChannelLease: async () => true,
        forceAcquireChannelLease: async () => {},
        releaseChannelLease: async () => {},
        releaseChannelLeasesByHolder: async () => {}
    }
    const provider = {
        name: 'lark',
        managesConnection: () => opts.managesConnection !== false,
        validateConfig: (config: unknown) => config,
        start: async (
            _ctx: unknown,
            _onInbound: unknown,
            onStatus?: StatusCallback
        ) => {
            state.starts += 1
            state.onStatus = onStatus ?? null
            if (state.startError) throw state.startError
            return {
                status: opts.handleStatus ?? ('connected' as const),
                stop: async () => {
                    state.stops += 1
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
    const telemetry = {
        event: (name: string, attrs: Record<string, unknown>) => {
            telemetryEvents.push({ name, attrs })
        },
        error: () => {}
    }
    const manager = new ChannelManagerService(
        repo as never,
        { get: () => provider } as never,
        bridge as never,
        telemetry as never,
        { get: () => undefined } as never
    )
    return {
        manager,
        channels,
        telemetryEvents,
        starts: () => state.starts,
        stops: () => state.stops,
        setStartError: (err) => {
            state.startError = err
        },
        sendStatus: (status, detail) => {
            state.onStatus?.(status, detail)
        }
    }
}

test('start failure persists backoff and the tick retries after it elapses', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness([makeChannel()])
    h.setStartError(new Error('handshake timeout'))

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts(), 1, 'first attempt ran')
    assert.equal(h.channels[0].status, 'error')
    assert.equal(h.channels[0].reconnectAttempts, 1)
    assert.ok(h.channels[0].nextReconnectAt, 'backoff persisted')

    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.equal(h.starts(), 1, 'tick within the backoff window must not retry')

    h.setStartError(null)
    t.mock.timers.tick(LEASE_TICK_MS)
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.equal(h.starts(), 2, 'tick past the 30s backoff retried')
    assert.equal(h.channels[0].status, 'active', 'recovery persisted')
    assert.equal(h.channels[0].reconnectAttempts, 0, 'attempts reset')
    assert.equal(h.channels[0].nextReconnectAt, null)
})

test('an errored channel found at bootstrap is restarted (survives restarts)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness([
        makeChannel({
            status: 'error',
            lastErrorMessage: 'left over from a previous process',
            reconnectAttempts: 3,
            nextReconnectAt: new Date(Date.now() - 1000)
        })
    ])

    h.manager.onModuleInit()
    await flushMicrotasks()

    assert.equal(h.starts(), 1, 'stranded error channel was picked up')
    assert.equal(h.channels[0].status, 'active')
})

test('backoff never gives up: retries continue past 10 failures at the cap', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness([
        makeChannel({
            status: 'error',
            reconnectAttempts: 12,
            nextReconnectAt: new Date(Date.now() - 1000)
        })
    ])
    h.setStartError(new Error('still down'))

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts(), 1, 'attempt 13 still ran')
    // +2 per cycle: the due tick arms before starting, the failure reports.
    assert.equal(h.channels[0].reconnectAttempts, 14)

    const delayMs = (h.channels[0].nextReconnectAt?.getTime() ?? 0) - Date.now()
    assert.ok(
        delayMs <= 600_000 && delayMs > 500_000,
        `backoff capped at 600s, got ${delayMs}ms`
    )
})

test('a zombie engaged handle on an errored channel is bounced when due', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness([makeChannel()])

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts(), 1, 'channel started healthy')

    // Simulate a provider whose connection died after start() returned
    // (discord gateway.connect rejection): status flips to error via the
    // status callback while the handle stays engaged.
    h.channels[0] = {
        ...h.channels[0],
        status: 'error',
        reconnectAttempts: 1,
        nextReconnectAt: new Date(Date.now() - 1000)
    }
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()

    assert.equal(h.stops(), 1, 'zombie handle stopped')
    assert.equal(h.starts(), 2, 'channel restarted')
    assert.equal(h.channels[0].status, 'active')
})

test('an engaged errored channel inside its backoff window is left alone', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness([makeChannel()])

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts(), 1)

    h.channels[0] = {
        ...h.channels[0],
        status: 'error',
        reconnectAttempts: 1,
        nextReconnectAt: new Date(Date.now() + 60_000)
    }
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()

    assert.equal(h.stops(), 0, 'in-handle recovery gets first shot')
    assert.equal(h.starts(), 1)
    assert.equal(h.channels[0].reconnectAttempts, 1, 'no arm inside the window')
})

test('errored channels of webhook-style providers are not auto-reconnected', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness(
        [
            makeChannel({
                provider: 'telegram',
                configJson: {},
                status: 'error',
                nextReconnectAt: null
            })
        ],
        { managesConnection: false }
    )

    h.manager.onModuleInit()
    await flushMicrotasks()
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()

    assert.equal(
        h.starts(),
        0,
        'restarting a noop handle would fake the channel healthy'
    )
    assert.equal(h.channels[0].status, 'error')
})

// Regression for #375: a handle that stays 'connecting' (weixin long poll,
// matrix initial sync) never reaches a terminal status, so nothing used to
// re-arm next_reconnect_at — the tick bounced it every 15s forever with the
// backoff ladder never engaging.
test('a connecting-forever handle is armed once per window, not hot-bounced', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness(
        [
            makeChannel({
                status: 'error',
                reconnectAttempts: 0,
                nextReconnectAt: new Date(Date.now() - 1000)
            })
        ],
        { handleStatus: 'connecting' }
    )

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts(), 1, 'due channel started')
    assert.equal(h.channels[0].reconnectAttempts, 1, 'backoff re-armed')
    assert.equal(h.channels[0].status, 'error', 'no terminal status reported')
    const window1 = (h.channels[0].nextReconnectAt?.getTime() ?? 0) - Date.now()
    assert.ok(
        window1 > 25_000 && window1 <= 30_000,
        `first window ~30s, got ${window1}ms`
    )

    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.equal(h.stops(), 0, 'tick inside the armed window must not bounce')
    assert.equal(h.starts(), 1)

    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.equal(h.stops(), 1, 'bounced once the window elapsed')
    assert.equal(h.starts(), 2)
    assert.equal(h.channels[0].reconnectAttempts, 2, 'ladder climbs')
    const window2 = (h.channels[0].nextReconnectAt?.getTime() ?? 0) - Date.now()
    assert.ok(
        window2 > 55_000 && window2 <= 60_000,
        `second window ~60s, got ${window2}ms`
    )
})

test('stranded telemetry fires when the arm crosses the threshold', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness(
        [
            makeChannel({
                status: 'error',
                reconnectAttempts: 9,
                lastErrorMessage: 'poll dead',
                nextReconnectAt: new Date(Date.now() - 1000)
            })
        ],
        { handleStatus: 'connecting' }
    )

    h.manager.onModuleInit()
    await flushMicrotasks()
    const stranded = h.telemetryEvents.filter(
        (e) => e.name === 'channel.connection.stranded'
    )
    assert.equal(stranded.length, 1, 'arm crossing the threshold reported')
    assert.equal(stranded[0].attrs.attempts, 10)
    assert.equal(
        stranded[0].attrs.errorMessage,
        'poll dead',
        'arm preserves the original cause'
    )

    t.mock.timers.tick(600_000)
    await flushMicrotasks()
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.ok(h.channels[0].reconnectAttempts > 10, 'later arms happened')
    assert.equal(
        h.telemetryEvents.filter(
            (e) => e.name === 'channel.connection.stranded'
        ).length,
        1,
        'does not re-fire past the threshold'
    )
})

test('no further arms after the channel connects during its window', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness(
        [
            makeChannel({
                status: 'error',
                reconnectAttempts: 0,
                nextReconnectAt: new Date(Date.now() - 1000)
            })
        ],
        { handleStatus: 'connecting' }
    )

    h.manager.onModuleInit()
    await flushMicrotasks()
    assert.equal(h.starts(), 1)
    assert.equal(h.channels[0].reconnectAttempts, 1)

    h.sendStatus('connected')
    await flushMicrotasks()
    assert.equal(h.channels[0].status, 'active', 'late connect persisted')
    assert.equal(h.channels[0].reconnectAttempts, 0)
    assert.equal(h.channels[0].nextReconnectAt, null)

    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.equal(h.starts(), 1, 'healthy channel is left alone')
    assert.equal(h.stops(), 0)
    assert.equal(h.channels[0].reconnectAttempts, 0, 'no arms on active')
})

test('stranded telemetry fires once when attempts cross the threshold', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
    const h = makeHarness([
        makeChannel({
            status: 'error',
            reconnectAttempts: 9,
            nextReconnectAt: new Date(Date.now() - 1000)
        })
    ])
    h.setStartError(new Error('still down'))

    h.manager.onModuleInit()
    await flushMicrotasks()

    const stranded = h.telemetryEvents.filter(
        (e) => e.name === 'channel.connection.stranded'
    )
    assert.equal(stranded.length, 1, 'threshold crossing reported')
    assert.equal(stranded[0].attrs.attempts, 10)

    h.channels[0] = {
        ...h.channels[0],
        nextReconnectAt: new Date(Date.now() - 1000)
    }
    t.mock.timers.tick(LEASE_TICK_MS)
    await flushMicrotasks()
    assert.equal(
        h.telemetryEvents.filter(
            (e) => e.name === 'channel.connection.stranded'
        ).length,
        1,
        'does not re-fire past the threshold'
    )
})
