import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import {
    HostDaemonAccess,
    HostDaemonOfflineError,
    isTransportLoss
} from '../src/modules/agents/adapters/host-daemon-access'
import { DaemonRpcResponseError } from '../src/modules/daemon/daemon-registry.service'

// ADR-0038: withHost is the one way to work on a machine — hold it awake, get
// its daemon (brought up when the platform owns it), run the work with an RPC
// that survives the reconnect a thaw causes, let go. Reachable means the API
// holds a socket (the rpc lease), never that a heartbeat is recent.

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'sbx_1',
        userId: 'user-1',
        kind: 'hosted',
        providerId: 'rtp_1',
        providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sprite-1' },
        name: 'sandbox-001',
        status: 'ready',
        generation: 1,
        ...overrides
    }) as RuntimeHostRow

const daemon = (overrides: Partial<HostDaemonRow> = {}): HostDaemonRow =>
    ({
        hostId: 'sbx_1',
        cliVersion: '5.0.0',
        clientFeatures: [],
        lastSeenAt: new Date(),
        rpcInstanceId: 'api-1',
        rpcConnectedAt: new Date(Date.now() - 60_000),
        rpcLastSeenAt: new Date(),
        ...overrides
    }) as HostDaemonRow

const build = (opts: {
    daemon?: HostDaemonRow | null
    rpc?: (call: { method: string }) => Promise<Record<string, unknown>>
    reconnect?: boolean
} = {}) => {
    const events: string[] = []
    let row = opts.daemon === undefined ? daemon() : opts.daemon
    const registry = {
        rpc: async (call: { method: string }) => {
            events.push(`rpc:${call.method}`)
            return opts.rpc ? opts.rpc(call) : {}
        }
    }
    const awake = {
        hold: (_host: RuntimeHostRow, reason: string) => {
            events.push(`hold:${reason}`)
            return {
                settled: Promise.resolve(true),
                release: async () => {
                    events.push(`release:${reason}`)
                },
                detach: () => {}
            }
        }
    }
    const runnerManager = {
        ensureHostDaemon: async () => {
            events.push('ensure')
            return row && row.rpcInstanceId ? { handle: { daemonId: 'sbx_1', started: false, generation: 'g' } } : { handle: null, fallbackReason: 'runner_unavailable' }
        },
        awaitReconnect: async () => {
            events.push('await-reconnect')
            if (!opts.reconnect) return null
            row = daemon({ rpcConnectedAt: new Date() })
            return { daemonId: 'sbx_1', started: false, generation: 'g2' }
        }
    }
    const access = new HostDaemonAccess(
        { findByHostId: async () => row } as never,
        registry as never,
        awake as never,
        runnerManager as never
    )
    return { access, events, setRow: (r: HostDaemonRow | null) => { row = r } }
}

test('withHost holds the machine, ensures its daemon, runs the work and lets go', async () => {
    const { access, events } = build()
    const out = await access.withHost(
        { host: host(), daemon: null, placement: 'sprites', reason: 'files' },
        async (session) => {
            assert.equal(session.daemonId, 'sbx_1')
            await session.rpc({ method: 'fs.list', payload: {} })
            return 'done'
        }
    )
    assert.equal(out, 'done')
    assert.deepEqual(events, ['hold:files', 'ensure', 'rpc:fs.list', 'release:files'])
})

test('a hosted machine the API holds no socket to is brought up; a self-owned one is offline', async () => {
    const hosted = build({ daemon: daemon({ rpcInstanceId: null, rpcConnectedAt: null }) })
    await assert.rejects(
        hosted.access.withHost({ host: host(), daemon: null, placement: 'sprites', reason: 'x' }, async () => 1),
        (err: unknown) => err instanceof HostDaemonOfflineError && err.reason === 'runner_unavailable'
    )
    assert.deepEqual(hosted.events, ['hold:x', 'ensure', 'release:x'], 'the bring-up ran under the hold')

    const local = build({ daemon: daemon({ hostId: 'dh_1', lastSeenAt: new Date(), rpcInstanceId: null, rpcConnectedAt: null }) })
    const result = await local.access.ensure({
        host: host({ id: 'dh_1', kind: 'local', providerId: null, providerRef: null }),
        daemon: null,
        placement: 'daemon'
    })
    assert.equal(result.online, false, 'a fresh heartbeat without a socket is not reachable')
    assert.equal(result.fallbackReason, 'runner_unavailable')
    assert.deepEqual(local.events, [], 'nothing is brought up on a user\'s own computer')
})

test('a read path that must not wake the machine reads the lease and holds nothing', async () => {
    const asleep = build({ daemon: daemon({ rpcInstanceId: null, rpcConnectedAt: null }) })
    const res = await asleep.access.ensure({ host: host(), daemon: null, placement: 'sprites', wake: false })
    assert.equal(res.online, false)
    assert.deepEqual(asleep.events, [])
    const live = build()
    assert.equal((await live.access.ensure({ host: host(), daemon: null, placement: 'sprites', wake: false })).online, true)
})

test('an RPC lost to a closed or replaced socket is retried once on the fresh lease', async () => {
    let attempts = 0
    const { access, events } = build({
        reconnect: true,
        rpc: async () => {
            attempts += 1
            if (attempts === 1) throw new Error('daemon sbx_1 is not connected')
            return { ok: true }
        }
    })
    const out = await access.withHost(
        { host: host(), daemon: null, placement: 'sprites', reason: 'auth' },
        (session) => session.rpc({ method: 'auth.list', payload: {} })
    )
    assert.deepEqual(out, { ok: true })
    assert.deepEqual(events, ['hold:auth', 'ensure', 'rpc:auth.list', 'await-reconnect', 'rpc:auth.list', 'release:auth'])
})

test('a daemon that never comes back surfaces the original loss; a daemon-side error is never retried', async () => {
    const gone = build({ reconnect: false, rpc: async () => { throw new Error('connection closed') } })
    await assert.rejects(
        gone.access.withHost({ host: host(), daemon: null, placement: 'sprites', reason: 'r' }, (s) => s.rpc({ method: 'fs.list', payload: {} })),
        /connection closed/
    )
    assert.equal(gone.events.filter((e) => e === 'rpc:fs.list').length, 1)

    const refused = build({ reconnect: true, rpc: async () => { throw new DaemonRpcResponseError('no such path') } })
    await assert.rejects(
        refused.access.withHost({ host: host(), daemon: null, placement: 'sprites', reason: 'r' }, (s) => s.rpc({ method: 'fs.list', payload: {} })),
        DaemonRpcResponseError
    )
    assert.ok(!refused.events.includes('await-reconnect'))
})

test('a timeout is retried only when the caller says the call is quick', async () => {
    const slow = build({ reconnect: true, rpc: async () => { throw new Error('rpc auth.list timed out') } })
    await assert.rejects(
        slow.access.withHost({ host: host(), daemon: null, placement: 'sprites', reason: 'r' }, (s) => s.rpc({ method: 'auth.list', payload: {} })),
        /timed out/
    )
    assert.ok(!slow.events.includes('await-reconnect'))
    let n = 0
    const quick = build({ reconnect: true, rpc: async () => { n += 1; if (n === 1) throw new Error('rpc workspace.ensure timed out'); return {} } })
    await quick.access.withHost({ host: host(), daemon: null, placement: 'sprites', reason: 'r' }, (s) => s.rpc({ method: 'workspace.ensure', payload: {}, retryOnTimeout: true }))
    assert.equal(n, 2)
})

test('isTransportLoss names exactly the registry\'s lost-generation shapes', () => {
    for (const m of ['connection closed', 'connection replaced', 'daemon x is not connected', 'daemon x is offline; no active websocket', 'lease is stale'])
        assert.equal(isTransportLoss(new Error(m), false), true, m)
    assert.equal(isTransportLoss(new Error('rpc fs.list timed out'), false), false)
    assert.equal(isTransportLoss(new Error('rpc fs.list timed out'), true), true)
    assert.equal(isTransportLoss(new DaemonRpcResponseError('connection closed'), true), false)
    assert.equal(isTransportLoss(new Error('workspace directory does not exist'), true), false)
})
