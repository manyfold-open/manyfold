import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import {
    HostDaemonAccess,
    HostDaemonOfflineError,
    isTransportLoss,
    type HostExecRequest
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
    // What the bring-up answers, in place of its lease-based default.
    resolution?: Record<string, unknown>
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
            if (opts.resolution) return opts.resolution
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
            assert.equal(session.hostId, 'sbx_1')
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

test('a sandbox whose CLI an update could not bring up to the work says why, and on which version', async () => {
    const { access } = build({
        daemon: daemon({ cliVersion: '4.8.0' }),
        resolution: {
            handle: null,
            fallbackReason: 'runner_cli_too_old',
            cliRefusal: {
                message: 'sandbox-001 already runs the latest Manyfold CLI (4.8.0), which does not support this yet',
                cliVersion: '4.8.0',
                latestCliVersion: '4.8.0'
            }
        }
    })
    await assert.rejects(
        access.withHost({ host: host(), daemon: null, placement: 'sprites', reason: 'files', requiredFeatures: ['fs.roots.v1'] }, async () => 1),
        (err: unknown) => {
            assert.ok(err instanceof HostDaemonOfflineError)
            // Not "no update carrying what it needs is published yet".
            assert.equal(err.message, 'sandbox-001 already runs the latest Manyfold CLI (4.8.0), which does not support this yet')
            assert.equal(err.cliVersion, '4.8.0')
            assert.equal(err.latestCliVersion, '4.8.0')
            return true
        }
    )
    const unexplained = build({
        daemon: daemon({ cliVersion: '4.8.0' }),
        resolution: { handle: null, fallbackReason: 'runner_cli_too_old' }
    })
    await assert.rejects(
        unexplained.access.withHost({ host: host(), daemon: null, placement: 'sprites', reason: 'files' }, async () => 1),
        /the Manyfold CLI on sandbox-001 \(4\.8\.0\) is too old for this/
    )
})

test('a machine whose register failed carries what the CLI said to the caller', async () => {
    const { access } = build({
        daemon: null,
        resolution: {
            handle: null,
            fallbackReason: 'runner_unavailable',
            registerFailure: 'cli Error: Unable to connect.'
        }
    })
    await assert.rejects(
        access.withHost({ host: host(), daemon: null, placement: 'sprites', reason: 'provision-sandbox' }, async () => 1),
        (err: unknown) => {
            assert.ok(err instanceof HostDaemonOfflineError)
            assert.equal(err.reason, 'runner_unavailable')
            assert.equal(err.registerFailure, 'cli Error: Unable to connect.')
            return true
        }
    )
})

test('a read path that must not wake the machine reads the lease and holds nothing', async () => {
    const asleep = build({ daemon: daemon({ rpcInstanceId: null, rpcConnectedAt: null }) })
    const res = await asleep.access.ensure({ host: host(), daemon: null, placement: 'sprites', wake: false })
    assert.equal(res.online, false)
    assert.deepEqual(asleep.events, [])
    const live = build()
    assert.equal((await live.access.ensure({ host: host(), daemon: null, placement: 'sprites', wake: false })).online, true)
})

// WHY: taking the hold is itself an exec into the VM, and an exec resumes a
// sleeping sprite. A read that must not start billed running time (an MCP
// import, an auth-profile list) used to take one before looking.
test('withHost that must not wake a sleeping machine takes no hold and reports it offline', async () => {
    const { access, events } = build()
    await assert.rejects(
        access.withHost(
            { host: host({ powerState: 'suspended' }), daemon: null, placement: 'sprites', reason: 'mcp-import', wake: false },
            async () => 'never'
        ),
        HostDaemonOfflineError
    )
    assert.deepEqual(events, [])
})

test('withHost that must not wake still works on a running machine it holds a socket to', async () => {
    const { access, events } = build()
    const out = await access.withHost(
        { host: host({ powerState: 'running' }), daemon: null, placement: 'sprites', reason: 'mcp-import', wake: false },
        async () => 'read'
    )
    assert.equal(out, 'read')
    assert.deepEqual(events, ['hold:mcp-import', 'release:mcp-import'])
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

// A session exec over a registry whose streamRpc is scripted per attempt.
const buildExec = (attempts: Array<(call: Record<string, unknown>) => Promise<Record<string, unknown>>>) => {
    const calls: Array<Record<string, unknown>> = []
    const registry = {
        streamRpc: (call: Record<string, unknown> & { onEvent: (kind: string, data: string) => void }) => {
            calls.push(call)
            const next = attempts.shift()
            if (!next) throw new Error('unexpected exec attempt')
            call.onEvent('stdout', `attempt ${calls.length}\n`)
            return { refId: String(call.refIdOverride), result: next(call), cancel: () => {} }
        }
    }
    const awake = {
        hold: () => ({ settled: Promise.resolve(true), release: async () => {}, detach: () => {} })
    }
    const runnerManager = {
        ensureHostDaemon: async () => ({ handle: { daemonId: 'sbx_1', started: false, generation: 'g' } }),
        awaitReconnect: async () => ({ daemonId: 'sbx_1', started: false, generation: 'g2' })
    }
    const access = new HostDaemonAccess(
        { findByHostId: async () => daemon() } as never,
        registry as never,
        awake as never,
        runnerManager as never
    )
    const run = (req: HostExecRequest) =>
        access.withHost(
            { host: host(), daemon: null, placement: 'sprites', reason: 'test' },
            (session) => session.exec(req)
        )
    return { run, calls }
}

// WHY: a command whose socket a thaw replaced is still running on the machine.
// Sending it again under a new refId would start a second one; the daemon
// attaches to, or replays, the one it already has under the same refId.
test('an exec lost to a closed socket goes again under the same refId, with only that answer kept', async () => {
    const { run, calls } = buildExec([
        async () => {
            throw new Error('daemon connection closed')
        },
        async () => ({ exitCode: 0 })
    ])

    const result = await run({ cmd: ['true'], timeoutMs: 1_000 })

    assert.equal(calls.length, 2)
    assert.equal(calls[0].method, 'exec.start')
    assert.ok(calls[0].refIdOverride)
    assert.equal(calls[1].refIdOverride, calls[0].refIdOverride)
    assert.deepEqual(result, { exitCode: 0, stdout: 'attempt 2\n', stderr: '' })
})

// Seen on staging [2026-10-07]: two reconnects 8s apart cut an install and
// its first reattach; giving up there read a running install as a failed one.
test('an exec keeps following its refId across every reconnect until it answers', async () => {
    const { run, calls } = buildExec([
        async () => {
            throw new Error('daemon connection closed')
        },
        async () => {
            throw new Error('connection replaced')
        },
        async () => ({ exitCode: 0 })
    ])

    const result = await run({ cmd: ['true'], timeoutMs: 60_000 })

    assert.equal(calls.length, 3)
    assert.ok(calls.every((call) => call.refIdOverride === calls[0].refIdOverride))
    assert.deepEqual(result, { exitCode: 0, stdout: 'attempt 3\n', stderr: '' })
})

test('an exec whose socket never settles is given up after a bounded number of sends', async () => {
    const lost = async () => {
        throw new Error('daemon connection closed')
    }
    const { run, calls } = buildExec(Array.from({ length: 8 }, () => lost))

    await assert.rejects(run({ cmd: ['true'], timeoutMs: 60_000 }), /connection closed/)

    assert.equal(calls.length, 5)
})

test('an exec the daemon failed, or one that timed out, is never sent twice', async () => {
    const refused = buildExec([
        async () => {
            throw new DaemonRpcResponseError('exec.start refused')
        }
    ])
    await assert.rejects(refused.run({ cmd: ['true'], timeoutMs: 1_000 }), /refused/)
    assert.equal(refused.calls.length, 1)

    const slow = buildExec([
        async () => {
            throw new Error('rpc exec.start timed out after 6000ms')
        }
    ])
    await assert.rejects(slow.run({ cmd: ['sleep', '9'], timeoutMs: 1_000 }), /timed out/)
    assert.equal(slow.calls.length, 1)
})

test('an exec carries its directory and the roots that admit it', async () => {
    const { run, calls } = buildExec([async () => ({ exitCode: 0 })])

    await run({
        cmd: ['bash', '-lc', 'pwd'],
        timeoutMs: 1_000,
        dir: '/work/repo',
        roots: ['/work/repo'],
        env: { A: '1' }
    })

    const payload = calls[0].payload as Record<string, unknown>
    assert.equal(payload.dir, '/work/repo')
    assert.deepEqual(payload.roots, ['/work/repo'])
    assert.deepEqual(payload.env, { A: '1' })
})
