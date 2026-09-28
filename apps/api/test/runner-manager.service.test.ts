import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DAEMON_FEATURE_EXEC_FILES,
    DAEMON_MIN_CLI_VERSION,
    K8S_HOME_BASE,
    POD_RUNNER_PROFILE,
    RUNNER_PROFILE,
    profilePaths
} from '@manyfold/shared'
import type {
    HostDaemonRow,
    RuntimeHostPowerState,
    RuntimeHostRow,
    RuntimeProvider
} from '@manyfold/db'
import { SpritesError } from '@manyfold/sprites'
import { RunnerManagerService } from '../src/modules/chat/runner/runner-manager.service'
import { StaleGenerationError } from '../src/modules/hosts/providers/sandbox-provider'
import { CLI_AT_FLOOR, CLI_BELOW_FLOOR } from './helpers/cli-floor'

// The host daemon bring-up (ADR-0037 R11): Agent → Runtime → Host →
// host_daemons. Online → the handle. A hosted host that is not online goes
// through its provider adapter — power, wake, then a bootstrap that installs
// mf, registers with a token BOUND to the host and starts the daemon — and
// waits for the daemon to dial in. A local host's daemon is the user's to
// start. Nothing is ever looked up by name.

const NOW = () => new Date()

interface Exec {
    script: string
    stdin?: string
}

interface HarnessOptions {
    host?: Partial<RuntimeHostRow>
    // null = never registered; a row whose lastSeenAt is old = offline.
    daemon?: HostDaemonRow | null
    providerKind?: 'sprites' | 'k8s'
    power?: RuntimeHostPowerState
    // The machine as the inspect finds it.
    installed?: boolean
    registered?: boolean
    version?: string | null
    herdr?: boolean
    // Whether a started daemon dials in (the fake heartbeat) — and, for a
    // wake, whether the thawed process reconnects on its own.
    connects?: boolean
    reconnectsOnWake?: boolean
    logTail?: string
    registerExit?: number
    registerOutput?: string
    // A bootstrap that throws before anything ran (the exec endpoint).
    inspectError?: Error
    rpc?: (args: { method: string; payload: Record<string, unknown> }) => Promise<Record<string, unknown>>
}

const hostRow = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'sbx_1',
        userId: 'user-1',
        kind: 'hosted',
        providerId: 'rtp_1',
        providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sprite-1' },
        name: 'sandbox-001',
        status: 'ready',
        failureReason: null,
        generation: 3,
        powerState: 'unknown',
        homeDir: '/home/sprite',
        workspaceBaseDir: '/home/sprite/.manyfold/workspaces',
        skillsDir: null,
        keepAwake: false,
        createdAt: NOW(),
        updatedAt: NOW(),
        ...overrides
    }) as RuntimeHostRow

const daemonRow = (overrides: Partial<HostDaemonRow> = {}): HostDaemonRow =>
    ({
        hostId: 'sbx_1',
        userId: 'user-1',
        daemonUuid: 'uuid-1',
        tokenId: 'ldt_1',
        hostname: 'sbx-1',
        os: 'linux',
        arch: 'x86_64',
        cliVersion: CLI_AT_FLOOR,
        herdrVersion: null,
        startupMethod: 'manual',
        clientFeatures: [],
        terminalPty: null,
        detectedFrameworks: [],
        registeredAt: NOW(),
        lastSeenAt: NOW(),
        lastIp: null,
        rpcInstanceId: 'api-1',
        rpcConnectionToken: 'api-1:tok',
        rpcInbox: 'inbox',
        rpcConnectedAt: new Date(Date.now() - 60_000),
        rpcLastSeenAt: NOW(),
        createdAt: NOW(),
        updatedAt: NOW(),
        ...overrides
    }) as HostDaemonRow

const offlineDaemon = (overrides: Partial<HostDaemonRow> = {}): HostDaemonRow =>
    daemonRow({
        lastSeenAt: new Date(Date.now() - 120_000),
        rpcLastSeenAt: new Date(Date.now() - 120_000),
        rpcInstanceId: null,
        rpcConnectionToken: null,
        rpcInbox: null,
        rpcConnectedAt: null,
        ...overrides
    })

const buildHarness = (opts: HarnessOptions = {}) => {
    const providerKind = opts.providerKind ?? 'sprites'
    const state = {
        host: hostRow({
            ...(providerKind === 'k8s'
                ? {
                      id: 'pdh_1',
                      providerRef: { kind: 'k8s', namespace: 'nca-user-1', ingressHost: null, podPhase: 'Running' },
                      homeDir: K8S_HOME_BASE,
                      workspaceBaseDir: `${K8S_HOME_BASE}/.manyfold/workspaces`
                  }
                : {}),
            ...opts.host
        }),
        daemon: opts.daemon === undefined ? null : opts.daemon,
        registered: opts.registered ?? false,
        installed: opts.installed ?? true,
        version: opts.version === undefined ? CLI_AT_FLOOR : opts.version,
        started: 0
    }
    const provider = { id: 'rtp_1', kind: providerKind, name: 'org' } as RuntimeProvider
    const execs: Exec[] = []
    const calls: string[] = []
    const powers: RuntimeHostPowerState[] = []
    const mints: Array<Record<string, unknown>> = []
    const revoked: string[] = []
    const rpcs: Array<{ method: string; payload: Record<string, unknown> }> = []
    // The awake lease as the runner manager asks for it (ADR-0038). The real
    // service returns the no-op hold for a machine that never sleeps; the fake
    // keeps that contract so a pod's tests can assert nothing held it.
    const holds: string[] = []
    const releases: string[] = []
    const awake = {
        hold: (host: RuntimeHostRow, reason: string) => {
            if (host.providerRef?.kind !== 'sprites')
                return { settled: Promise.resolve(true), release: async () => {}, detach: () => {} }
            holds.push(reason)
            return {
                settled: Promise.resolve(true),
                release: async () => {
                    releases.push(reason)
                },
                detach: () => {}
            }
        }
    }
    let bumps = 0

    const dialIn = () => {
        state.daemon = daemonRow({
            hostId: state.host.id,
            cliVersion: state.version ?? CLI_AT_FLOOR,
            rpcConnectedAt: NOW()
        })
    }

    const adapter = {
        kind: providerKind,
        capabilities: { suspend: providerKind === 'sprites', publicService: true },
        power: async () => {
            calls.push('power')
            return opts.power ?? 'running'
        },
        wake: async ({ generation }: { generation: number }) => {
            calls.push('wake')
            if (generation < state.host.generation)
                throw new StaleGenerationError(state.host.id, generation, state.host.generation)
            if (opts.reconnectsOnWake) dialIn()
        },
        create: async () => {
            throw new Error('create is provisioning’s')
        },
        destroy: async () => {
            calls.push('destroy')
        },
        bootstrap: async (args: { generation: number; script: string; stdin?: string }) => {
            if (args.generation < state.host.generation)
                throw new StaleGenerationError(state.host.id, args.generation, state.host.generation)
            execs.push({ script: args.script, stdin: args.stdin })
            const s = args.script
            if (s.includes('echo installed=')) {
                calls.push('inspect')
                if (opts.inspectError) throw opts.inspectError
                return {
                    exitCode: 0,
                    stdout: [
                        `installed=${state.installed ? 1 : 0}`,
                        `registered=${state.registered ? 1 : 0}`,
                        `version=${state.version ?? ''}`,
                        `herdr=${opts.herdr === false ? 0 : 1}`
                    ].join('\n'),
                    stderr: ''
                }
            }
            if (s.includes('daemon register')) {
                calls.push('register')
                const exitCode = opts.registerExit ?? 0
                if (exitCode === 0) state.registered = true
                return { exitCode, stdout: opts.registerOutput ?? 'registered', stderr: '' }
            }
            if (s.includes('MF_INSTALL_DIR') || s.includes('install.sh')) {
                calls.push(s.includes('herdr') ? 'install-herdr' : 'install-cli')
                if (!s.includes('herdr')) {
                    state.installed = true
                    state.version = CLI_AT_FLOOR
                }
                return { exitCode: 0, stdout: s.includes('herdr') ? 'MF_HERDR_OK' : '', stderr: '' }
            }
            if (s.includes('daemon start') || s.includes('pkill')) {
                calls.push('start')
                state.started += 1
                if (opts.connects !== false) dialIn()
                return { exitCode: 0, stdout: '1', stderr: '' }
            }
            if (s.includes('tail -n 6')) {
                calls.push('tail')
                return { exitCode: 0, stdout: opts.logTail ?? '(no runner log)', stderr: '' }
            }
            throw new Error(`unexpected bootstrap script: ${s.slice(0, 60)}`)
        }
    }

    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }

    const service = new TestRunnerManager(
        {
            findById: async () => state.host,
            patch: async (_id: string, patch: Partial<RuntimeHostRow>) => {
                if (patch.powerState) powers.push(patch.powerState)
                state.host = { ...state.host, ...patch }
                return state.host
            },
            bumpGeneration: async () => {
                bumps += 1
                state.host = { ...state.host, generation: state.host.generation + 1 }
                return state.host.generation
            }
        } as never,
        { findByHostId: async () => state.daemon } as never,
        { for: () => adapter } as never,
        { providerForHost: async () => provider } as never,
        {
            mint: async (args: Record<string, unknown>) => {
                mints.push(args)
                return {
                    tokenId: 'ldt_new',
                    plaintext: 'ldt_secret_value',
                    name: String(args.name),
                    hostId: args.hostId ?? null,
                    expiresAt: null,
                    createdAt: NOW()
                }
            },
            revoke: async (args: { tokenId: string }) => {
                revoked.push(args.tokenId)
                return state.host.id
            }
        } as never,
        {
            rpc: async (args: { method: string; payload: Record<string, unknown> }) => {
                rpcs.push(args)
                return opts.rpc ? opts.rpc(args) : {}
            },
            onConnected: () => () => {}
        } as never,
        awake as never
    )

    return { service, state, adapter, execs, calls, powers, mints, revoked, rpcs, holds, releases, bumps: () => bumps, dialIn }
}

const scriptsOf = (h: ReturnType<typeof buildHarness>) => h.execs.map((e) => e.script)

test('a local host whose daemon is online is admitted with no adapter call', async () => {
    const h = buildHarness({
        host: { id: 'dh_1', kind: 'local', providerId: null, providerRef: null },
        daemon: daemonRow({ hostId: 'dh_1' })
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host })
    assert.equal(res.handle?.daemonId, 'dh_1')
    assert.equal(res.handle?.started, false)
    assert.equal(res.handle?.generation, `api-1:${h.state.daemon!.rpcConnectedAt!.getTime()}`)
    assert.deepEqual(h.calls, [])
})

test('a local host whose daemon is offline is runner_unavailable: only the user can start it', async () => {
    const h = buildHarness({
        host: { id: 'dh_1', kind: 'local', providerId: null, providerRef: null },
        daemon: offlineDaemon({ hostId: 'dh_1' })
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_unavailable')
    assert.deepEqual(h.calls, [], 'nothing is ever brought up on a user\'s own computer')
    assert.deepEqual(h.mints, [])
})

test('an already-connected hosted daemon is a single-lookup no-op', async () => {
    const h = buildHarness({ daemon: daemonRow() })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, agentId: 'agt_1' })
    assert.equal(res.handle?.daemonId, 'sbx_1')
    assert.equal(res.handle?.started, false)
    assert.deepEqual(h.calls, [])
    assert.equal(h.bumps(), 0)
})

test('a cold machine is inspected, installed, registered with a bound token, started, then awaited', async () => {
    const h = buildHarness({ installed: false, registered: false, version: null })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, agentId: 'agt_1', waitOnlineMs: 50 })
    assert.equal(res.handle?.daemonId, 'sbx_1')
    assert.equal(res.handle?.started, true)
    assert.deepEqual(h.calls, ['power', 'inspect', 'install-cli', 'register', 'start'])
    assert.equal(h.bumps(), 1, 'the bootstrap runs under a fresh generation')
    assert.deepEqual(h.powers, ['running'], 'the power observation lands on the host')
    // The token is minted BOUND to the host (R5) and goes over stdin, never argv.
    assert.equal(h.mints.length, 1)
    assert.equal(h.mints[0].hostId, 'sbx_1')
    assert.equal(h.mints[0].expiresInDays, 90)
    const register = h.execs.find((e) => e.script.includes('daemon register'))!
    assert.equal(register.stdin, 'ldt_secret_value')
    assert.ok(!register.script.includes('ldt_secret_value'))
    assert.match(register.script, /--token -/)
    assert.match(register.script, new RegExp(`MF_PROFILE=${RUNNER_PROFILE}`))
    assert.match(register.script, /--name 'sandbox-001'/)
})

test('the inspect probes the ADR-0014 profile layout of the machine kind', async () => {
    const sprite = buildHarness({ registered: true })
    await sprite.service.ensureHostDaemon({ host: sprite.state.host, waitOnlineMs: 50 })
    const spriteProbe = profilePaths('$HOME/.manyfold', RUNNER_PROFILE).daemonConfigPath
    assert.ok(scriptsOf(sprite)[0].includes(`test -f "${spriteProbe}"`))

    const pod = buildHarness({ providerKind: 'k8s', registered: true })
    await pod.service.ensureHostDaemon({ host: pod.state.host, waitOnlineMs: 50 })
    const podProbe = profilePaths(`${K8S_HOME_BASE}/.manyfold`, POD_RUNNER_PROFILE).daemonConfigPath
    assert.ok(scriptsOf(pod)[0].includes(`test -f "${podProbe}"`))
})

// A pod's daemon is supervised by the image's boot loop (ADR-0035): stopping
// it IS starting it, its token never expires, and its profile lives on the PVC.
test('a pod host is restarted through its boot loop and registered without a token expiry', async () => {
    const h = buildHarness({ providerKind: 'k8s', registered: false })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.equal(res.handle?.daemonId, 'pdh_1')
    assert.deepEqual(h.calls, ['power', 'inspect', 'register', 'start'])
    assert.equal('expiresInDays' in h.mints[0], false)
    assert.equal(h.mints[0].hostId, 'pdh_1')
    const register = h.execs.find((e) => e.script.includes('daemon register'))!
    assert.match(register.script, new RegExp(`MF_PROFILE=${POD_RUNNER_PROFILE} MF_CONFIG_DIR=${K8S_HOME_BASE}/.manyfold`))
    const start = h.execs.find((e) => e.script.includes('pkill'))!
    assert.ok(!start.script.includes('setsid'), 'no detached start: the boot loop restarts the daemon')
    assert.deepEqual(h.holds, [], 'a pod does not suspend, so nothing holds it awake')
})

test('a suspended sprite with a registered daemon is woken, and a fresh lease is enough', async () => {
    const h = buildHarness({
        daemon: offlineDaemon(),
        power: 'suspended',
        registered: true,
        reconnectsOnWake: true
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.equal(res.handle?.daemonId, 'sbx_1')
    assert.deepEqual(h.calls, ['power', 'wake'], 'no bootstrap when the thawed daemon dials back in')
    assert.deepEqual(h.powers, ['suspended'])
    assert.equal(h.bumps(), 0)
})

test('a suspended sprite whose daemon does not come back after the wake is bootstrapped', async () => {
    const h = buildHarness({ daemon: offlineDaemon(), power: 'suspended', registered: true })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.equal(res.handle?.started, true)
    assert.deepEqual(h.calls, ['power', 'wake', 'inspect', 'start'])
    assert.deepEqual(h.mints, [], 'a registered machine is not registered again')
})

test('a daemon that never dials in degrades to null instead of throwing', async () => {
    const h = buildHarness({ registered: true, connects: false })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 20 })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_unavailable')
    assert.deepEqual(h.calls, ['power', 'inspect', 'start', 'tail'])
})

// A rejected credential is terminal on its own: the machine still has a
// config, so the inspect says registered=1 forever. The log tail is the only
// evidence, and it earns exactly one re-register.
test('a daemon whose credential is rejected is re-registered once', async () => {
    const h = buildHarness({
        registered: true,
        connects: false,
        logTail: 'ws closed code=4401 reason=unauthorized'
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 20 })
    assert.equal(res.handle, null)
    assert.deepEqual(h.calls, ['power', 'inspect', 'start', 'tail', 'register', 'start'])
    assert.equal(h.mints.length, 1)
})

test('a CLI below the floor is upgraded before the daemon is used', async () => {
    const h = buildHarness({ registered: true, version: CLI_BELOW_FLOOR })
    await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.deepEqual(h.calls, ['power', 'inspect', 'install-cli', 'start'])
})

test('a CLI too old to read the token from stdin is reinstalled and the register retried', async () => {
    let registers = 0
    const h = buildHarness({ registered: false })
    const original = h.adapter.bootstrap
    h.adapter.bootstrap = async (args) => {
        if (args.script.includes('daemon register') && registers++ === 0) {
            h.calls.push('register')
            return { exitCode: 2, stdout: '', stderr: 'error: token must start with ldt_' }
        }
        return original(args)
    }
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.equal(res.handle?.daemonId, 'sbx_1')
    assert.deepEqual(h.calls, ['power', 'inspect', 'register', 'install-cli', 'register', 'start'])
    assert.deepEqual(h.revoked, ['ldt_new'], 'the credential the old CLI never read is revoked')
    assert.equal(h.mints.length, 2)
})

test('a failed register revokes the token it minted; a register whose exec throws too', async () => {
    const failed = buildHarness({ registered: false, registerExit: 1, registerOutput: 'api unreachable' })
    const res = await failed.service.ensureHostDaemon({ host: failed.state.host, waitOnlineMs: 20 })
    assert.equal(res.handle, null)
    assert.deepEqual(failed.revoked, ['ldt_new'])

    const thrown = buildHarness({ registered: false })
    const original = thrown.adapter.bootstrap
    thrown.adapter.bootstrap = async (args) => {
        if (args.script.includes('daemon register')) throw new Error('socket hang up')
        return original(args)
    }
    await thrown.service.ensureHostDaemon({ host: thrown.state.host, waitOnlineMs: 20 })
    assert.deepEqual(thrown.revoked, ['ldt_new'])
})

test('a sandbox without herdr gets it installed after the CLI; one with it does not', async () => {
    const without = buildHarness({ registered: true, herdr: false })
    await without.service.ensureHostDaemon({ host: without.state.host, waitOnlineMs: 50 })
    assert.deepEqual(without.calls, ['power', 'inspect', 'install-herdr', 'start'])

    const withHerdr = buildHarness({ registered: true, herdr: true })
    await withHerdr.service.ensureHostDaemon({ host: withHerdr.state.host, waitOnlineMs: 50 })
    assert.deepEqual(withHerdr.calls, ['power', 'inspect', 'start'])
})

test('a bring-up holds the sprite awake from before the power check until the admission is done', async () => {
    const h = buildHarness({ registered: true })
    await h.service.ensureHostDaemon({ host: h.state.host, agentId: 'agt_1', waitOnlineMs: 50 })
    assert.deepEqual(h.holds, ['ensure-agt_1', 'start'], 'the admission hold, then the start hold on top of it')
    assert.deepEqual(h.releases.sort(), ['ensure-agt_1', 'start'])
})

test('a heartbeat is not a socket: presence within the window but no rpc lease is a wake, not an admission', async () => {
    // Staging 2026-09-27: the daemon closed its socket at :42, its last
    // heartbeat was seconds old, and every message until the window expired
    // failed with workspace_connection_closed instead of waking the sprite.
    const h = buildHarness({
        daemon: daemonRow({ lastSeenAt: NOW(), rpcInstanceId: null, rpcConnectionToken: null, rpcInbox: null, rpcConnectedAt: null }),
        power: 'suspended',
        registered: true,
        reconnectsOnWake: true
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, agentId: 'agt_1', waitOnlineMs: 50 })
    assert.equal(res.handle?.daemonId, 'sbx_1')
    assert.deepEqual(h.calls, ['power', 'wake'])
    assert.deepEqual(h.holds, ['ensure-agt_1'], 'held before the machine is touched')
})

test('a socket is a socket: an rpc lease is admitted even when the heartbeat is stale', async () => {
    const h = buildHarness({ daemon: daemonRow({ lastSeenAt: new Date(Date.now() - 120_000) }) })
    const res = await h.service.ensureHostDaemon({ host: h.state.host })
    assert.equal(res.handle?.daemonId, 'sbx_1')
    assert.deepEqual(h.calls, [])
})

test('a local host is reachable exactly when the API holds a socket to it', async () => {
    const stale = buildHarness({
        host: { id: 'dh_1', kind: 'local', providerId: null, providerRef: null },
        daemon: daemonRow({ hostId: 'dh_1', lastSeenAt: NOW(), rpcInstanceId: null, rpcConnectionToken: null, rpcInbox: null, rpcConnectedAt: null })
    })
    const res = await stale.service.ensureHostDaemon({ host: stale.state.host })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_unavailable')
    assert.deepEqual(stale.holds, [], 'nothing holds a self-owned computer')
})

test('awaitReconnect answers on the fresh lease a thawed daemon writes', async () => {
    const h = buildHarness({ daemon: offlineDaemon() })
    const since = new Date()
    const waiting = h.service.awaitReconnect(h.state.host, since, 500)
    h.dialIn()
    const handle = await waiting
    assert.equal(handle?.daemonId, 'sbx_1')
    assert.equal(await h.service.awaitReconnect(h.state.host, new Date(Date.now() + 60_000), 10), null, 'a lease older than `since` is not the reconnect')
})

// A daemon that runs execs as files (ADR-0029 §4) is stopped with
// --keep-execs so the daemon started right after adopts what it carried.
test('a capable daemon is stopped with --keep-execs, an older one plainly', async () => {
    const capable = buildHarness({
        registered: true,
        daemon: offlineDaemon({ clientFeatures: [DAEMON_FEATURE_EXEC_FILES] })
    })
    await capable.service.ensureHostDaemon({ host: capable.state.host, waitOnlineMs: 50 })
    assert.match(scriptsOf(capable).find((s) => s.includes('daemon start'))!, /daemon stop --keep-execs/)

    const plain = buildHarness({ registered: true, daemon: offlineDaemon() })
    await plain.service.ensureHostDaemon({ host: plain.state.host, waitOnlineMs: 50 })
    assert.match(scriptsOf(plain).find((s) => s.includes('daemon start'))!, /daemon stop >/)
})

test('an exec endpoint that cannot open is a classified failure, not a missing daemon', async () => {
    const h = buildHarness({
        inspectError: new SpritesError(
            'transient',
            'execSpriteStream handshake failed: HTTP 502',
            502,
            undefined,
            { execPhase: 'pre_open' }
        )
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'sprite_exec_unavailable')
    assert.deepEqual(res.execFailure, { failureClass: 'handshake_5xx', upstreamStatus: 502 })
    assert.deepEqual(h.calls, ['power', 'inspect'], 'nothing else pays the same failing handshake')
    assert.deepEqual(h.mints, [])
})

test('concurrent turns on one host share a single bring-up', async () => {
    const h = buildHarness({ registered: false })
    const results = await Promise.all([
        h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 }),
        h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 }),
        h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    ])
    for (const res of results) assert.equal(res.handle?.daemonId, 'sbx_1')
    assert.equal(h.calls.filter((c) => c === 'register').length, 1)
    assert.equal(h.mints.length, 1)
})

test('a bring-up superseded by a newer generation drops out instead of racing it', async () => {
    const h = buildHarness({ registered: true })
    const original = h.adapter.bootstrap
    h.adapter.bootstrap = async (args) => {
        if (args.script.includes('echo installed=')) {
            // Someone bumped the host (a delete, another bootstrap) meanwhile.
            h.state.host = { ...h.state.host, generation: h.state.host.generation + 1 }
        }
        return original(args)
    }
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 20 })
    assert.equal(res.handle, null)
    assert.ok(!h.calls.includes('start'))
})

test('a daemon lacking a required feature is refused rather than handed out', async () => {
    const h = buildHarness({ daemon: daemonRow({ clientFeatures: [] }) })
    const res = await h.service.ensureHostDaemon({
        host: h.state.host,
        requiredFeatures: ['auth-context.v1']
    })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_unavailable')
})

test('a host that is failed, deleting or retired is never brought up', async () => {
    for (const status of ['failed', 'deleting', 'retired'] as const) {
        const h = buildHarness({ host: { status } })
        const res = await h.service.ensureHostDaemon({ host: h.state.host })
        assert.equal(res.handle, null)
        assert.deepEqual(h.calls, [])
    }
})

test('the floor the bring-up enforces is the shared minimum', () => {
    assert.ok(DAEMON_MIN_CLI_VERSION.length > 0)
})
