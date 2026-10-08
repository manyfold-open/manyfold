import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
    DAEMON_FEATURE_EXEC_FILES,
    DAEMON_FEATURE_SERVICES,
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
import { HostBringUpService } from '../src/modules/hosts/bring-up/host-bring-up.service'
import { spritesErrorFacts } from '../src/modules/hosts/providers/sprites.provider'
import {
    HostCliTooOldError,
    HostCliUpdatingError
} from '../src/modules/hosts/bring-up/host-cli.service'
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
    // The API its daemon config names; omitted = a config that does not say.
    registeredApiUrl?: string
    version?: string | null
    herdr?: boolean
    // Whether a started daemon dials in (the fake heartbeat) — and, for a
    // wake, whether the thawed process reconnects on its own.
    connects?: boolean
    reconnectsOnWake?: boolean
    // The awake hold's own exec thawed the machine: its daemon dials back in
    // right after the power read, with no wake needed.
    reconnectsOnThaw?: boolean
    // The machine boots after the wake and its supervised daemon dials in this
    // long after it, on the clock the bring-up polls by: the test mocks Date
    // and `tick` advances it by each poll's delay.
    dialsInAfterWakeMs?: number
    tick?: (ms: number) => void
    logTail?: string
    registerExit?: number
    registerOutput?: string
    // A bootstrap that throws before anything ran (the exec endpoint).
    inspectError?: Error
    rpc?: (args: { method: string; payload: Record<string, unknown> }) => Promise<Record<string, unknown>>
    // The CLI update an admission asks for when the daemon lacks a feature.
    hostCli?: { ensure: (host: RuntimeHostRow, need: { features?: readonly string[] }) => Promise<HostDaemonRow> }
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
    let wokeAt: number | null = null

    const dialIn = (supervised = false) => {
        state.daemon = daemonRow({
            hostId: state.host.id,
            cliVersion: state.version ?? CLI_AT_FLOOR,
            rpcConnectedAt: NOW(),
            // Under its supervised loop the daemon runs services.
            ...(supervised
                ? { startupMethod: 'container', clientFeatures: [DAEMON_FEATURE_SERVICES] }
                : {})
        })
    }

    const supervised: Array<{ name: string; command: string[]; env: Record<string, string> }> = []
    const adapter = {
        kind: providerKind,
        capabilities: { suspend: providerKind === 'sprites', publicService: true },
        ...(providerKind === 'sprites'
            ? {
                  superviseDaemon: async (
                      args: { generation: number },
                      process: { name: string; command: string[]; env: Record<string, string> }
                  ) => {
                      if (args.generation < state.host.generation)
                          throw new StaleGenerationError(state.host.id, args.generation, state.host.generation)
                      supervised.push(process)
                      if (opts.connects !== false) dialIn(true)
                  }
              }
            : {}),
        power: async () => {
            calls.push('power')
            if (opts.reconnectsOnThaw) dialIn()
            return opts.power ?? 'running'
        },
        wake: async ({ generation }: { generation: number }) => {
            calls.push('wake')
            if (generation < state.host.generation)
                throw new StaleGenerationError(state.host.id, generation, state.host.generation)
            if (opts.reconnectsOnWake) dialIn()
            wokeAt = Date.now()
        },
        create: async () => {
            throw new Error('create is provisioning’s')
        },
        destroy: async () => {
            calls.push('destroy')
        },
        describeError: spritesErrorFacts,
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
                        `apiUrl=${opts.registeredApiUrl ?? ''}`,
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
            if (s.includes('daemon stop')) {
                calls.push('start')
                state.started += 1
                // A pod's boot loop restarts the daemon it stopped; a
                // sprite's comes back under its supervised loop.
                if (providerKind === 'k8s' && opts.connects !== false) dialIn()
                return { exitCode: 0, stdout: '1', stderr: '' }
            }
            if (s.includes('tail -n 6')) {
                calls.push('tail')
                return { exitCode: 0, stdout: opts.logTail ?? '(no runner log)', stderr: '' }
            }
            throw new Error(`unexpected bootstrap script: ${s.slice(0, 60)}`)
        }
    }

    class TestRunnerManager extends HostBringUpService {
        protected override delay(ms: number): Promise<void> {
            opts.tick?.(ms)
            if (
                opts.dialsInAfterWakeMs !== undefined &&
                wokeAt !== null &&
                Date.now() - wokeAt >= opts.dialsInAfterWakeMs &&
                !state.daemon?.rpcConnectedAt
            )
                dialIn(true)
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
        awake as never,
        opts.hostCli as never
    )

    return { service, state, adapter, execs, calls, powers, mints, revoked, rpcs, holds, releases, supervised, bumps: () => bumps, dialIn }
}

const scriptsOf = (h: ReturnType<typeof buildHarness>) => h.execs.map((e) => e.script)

const withPublicApi = async (base: string, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env.PUBLIC_API_BASE_URL
    process.env.PUBLIC_API_BASE_URL = base
    try {
        await fn()
    } finally {
        if (previous === undefined) delete process.env.PUBLIC_API_BASE_URL
        else process.env.PUBLIC_API_BASE_URL = previous
    }
}

test('a local host whose daemon is online is admitted with no adapter call', async () => {
    const h = buildHarness({
        host: { id: 'dh_1', kind: 'local', providerId: null, providerRef: null },
        daemon: daemonRow({ hostId: 'dh_1' })
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host })
    assert.equal(res.handle?.hostId, 'dh_1')
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
    assert.equal(res.handle?.hostId, 'sbx_1')
    assert.equal(res.handle?.started, false)
    assert.deepEqual(h.calls, [])
    assert.equal(h.bumps(), 0)
})

test('a cold machine is inspected, installed, registered with a bound token, started, then awaited', async () => {
    const h = buildHarness({ installed: false, registered: false, version: null })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, agentId: 'agt_1', waitOnlineMs: 50 })
    assert.equal(res.handle?.hostId, 'sbx_1')
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

// Every shell on a sprite reads MF_API_URL and MF_DEPLOY_ENV from a profile
// block, so `mf` run by an agent or in a terminal talks to the API its daemon
// does. Registering writes it: in a subshell that reads nothing, because the
// token rides the same exec's stdin. A pod's shells get both from its env.
test('registering a sprite daemon writes the shell env block first, reading nothing from stdin', async () => {
    const h = buildHarness({ installed: true, registered: false })
    await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    const register = h.execs.find((e) => e.script.includes('daemon register'))!
    const [shellEnv, command] = register.script.split("\n) </dev/null >/dev/null 2>&1 || echo 'mf shell env not written' >&2\n")
    assert.ok(command, 'the block runs in its own subshell before the register')
    assert.match(shellEnv, /export MF_API_URL=/)
    assert.match(shellEnv, /export MF_DEPLOY_ENV=/)
    assert.match(command, /daemon register --token -/)
    assert.ok(!shellEnv.includes('ldt_secret_value'))
    const syntax = spawnSync('bash', ['-n'], { input: register.script })
    assert.equal(syntax.status, 0, syntax.stderr.toString())

    const pod = buildHarness({ providerKind: 'k8s', registered: false })
    await pod.service.ensureHostDaemon({ host: pod.state.host, waitOnlineMs: 50 })
    const podRegister = pod.execs.find((e) => e.script.includes('daemon register'))!
    assert.doesNotMatch(podRegister.script, /MF_API_URL/)
})

test('the inspect probes the ADR-0014 profile layout of the machine kind', async () => {
    const sprite = buildHarness({ registered: true })
    await sprite.service.ensureHostDaemon({ host: sprite.state.host, waitOnlineMs: 50 })
    const spriteProbe = profilePaths('$HOME/.manyfold', RUNNER_PROFILE).daemonConfigPath
    assert.ok(scriptsOf(sprite)[0].includes(`test -f "${spriteProbe}"`))
    assert.ok(scriptsOf(sprite)[0].includes(`grep -o '"apiUrl": *"[^"]*"' "${spriteProbe}"`))

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
    assert.equal(res.handle?.hostId, 'pdh_1')
    assert.deepEqual(h.calls, ['power', 'inspect', 'register', 'start'])
    assert.equal('expiresInDays' in h.mints[0], false)
    assert.equal(h.mints[0].hostId, 'pdh_1')
    const register = h.execs.find((e) => e.script.includes('daemon register'))!
    assert.match(register.script, new RegExp(`MF_PROFILE=${POD_RUNNER_PROFILE} MF_CONFIG_DIR=${K8S_HOME_BASE}/.manyfold`))
    const start = h.execs.find((e) => e.script.includes('pkill'))!
    assert.ok(!start.script.includes('setsid'), 'no detached start: the boot loop restarts the daemon')
    assert.deepEqual(h.holds, [], 'a pod does not suspend, so nothing holds it awake')
})

// A daemon started by an exec does not come back when the sprite's
// environment restarts; the sprite's own service supervisor starts its
// services again. So the daemon runs as a sprites service — a loop that
// restarts it, since the service stays "running" while the daemon's own
// services are alive — marked as supervised, which makes it take updates by
// exiting and run services (services.v1) as on a pod.
test('a sprite daemon is stopped for its supervised loop to take over, not started detached', async () => {
    const h = buildHarness({ registered: true, daemon: offlineDaemon() })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.equal(res.handle?.hostId, 'sbx_1')
    const start = scriptsOf(h).find((s) => s.includes('daemon stop'))!
    assert.ok(!start.includes('setsid') && !start.includes('daemon start'), 'the exec only stops what runs')
    assert.equal(h.supervised.length, 1)
    const [loop] = h.supervised
    assert.equal(loop.name, 'mf-daemon')
    assert.deepEqual(loop.env, { MF_PROFILE: RUNNER_PROFILE, MF_DAEMON_SUPERVISOR: 'container' })
    assert.deepEqual(loop.command.slice(0, 2), ['bash', '-lc'])
    assert.match(loop.command[2], /while :; do/)
    assert.match(loop.command[2], /"\$HOME\/\.local\/bin\/mf" daemon start --foreground >>"\$log"/)
    assert.ok(!loop.command[2].includes('--api-url'), 'the daemon dials the API its registration saved')
})

// The loop is real shell: it restarts a daemon that exits, and a stop of the
// service (SIGTERM to the loop) takes the running daemon down with it.
test('the supervised loop restarts an exiting daemon and ends with its daemon on TERM', async () => {
    const h = buildHarness({ registered: true, daemon: offlineDaemon() })
    await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    const loop = h.supervised[0].command[2]
        .replace('"$HOME/.local/bin/mf" daemon start --foreground', 'sh -c "echo started >> \\"$MARKS\\"; exit 3"')
        .replace('sleep 5 &', 'sleep 0.2 &')
    const dir = spawnSync('mktemp', ['-d']).stdout.toString().trim()
    spawnSync('mkdir', ['-p', `${dir}/.manyfold`])
    try {
        const run = spawnSync('bash', ['-c', `(${loop}) & pid=$!; sleep 1; kill -TERM $pid; wait $pid; echo "loop=$?"`], {
            env: { ...process.env, HOME: dir, MARKS: `${dir}/marks` },
            encoding: 'utf8',
            timeout: 10_000
        })
        assert.match(run.stdout, /loop=0/)
        const marks = spawnSync('cat', [`${dir}/marks`], { encoding: 'utf8' }).stdout.trim().split('\n')
        assert.ok(marks.length >= 2, `restarted after an exit (${marks.length} starts)`)
        const log = spawnSync('cat', [`${dir}/.manyfold/runner.log`], { encoding: 'utf8' }).stdout
        assert.match(log, /mf-daemon: daemon exited \(3\); restarting in 5s/)
    } finally {
        spawnSync('rm', ['-rf', dir])
    }
})

// A daemon an older bring-up started by an exec runs no services: a service
// framework on its sandbox needs it under the supervised loop, which a CLI
// update would not give it.
test('a connected sprite daemon started by an exec is handed to its supervised loop when services are needed', async () => {
    const ensured: unknown[] = []
    const h = buildHarness({
        registered: true,
        daemon: daemonRow({ startupMethod: 'manual', clientFeatures: [] }),
        hostCli: {
            ensure: async (_host, need) => {
                ensured.push(need)
                throw new Error('an update cannot give a manual daemon services')
            }
        }
    })
    const res = await h.service.ensureHostDaemon({
        host: h.state.host,
        requiredFeatures: [DAEMON_FEATURE_SERVICES],
        waitOnlineMs: 50
    })
    assert.equal(res.handle?.hostId, 'sbx_1')
    assert.equal(h.supervised.length, 1, 'the loop took the daemon over')
    assert.ok(scriptsOf(h).some((s) => s.includes('daemon stop')))
    assert.deepEqual(ensured, [], 'no CLI update was asked for')
    assert.equal(h.state.daemon?.startupMethod, 'container')
})

test('a suspended sprite with a registered daemon is woken, and a fresh lease is enough', async () => {
    const h = buildHarness({
        daemon: offlineDaemon(),
        power: 'suspended',
        registered: true,
        reconnectsOnWake: true
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.equal(res.handle?.hostId, 'sbx_1')
    assert.deepEqual(h.calls, ['power', 'wake'], 'no bootstrap when the thawed daemon dials back in')
    assert.deepEqual(h.powers, ['suspended'])
    assert.equal(h.bumps(), 0)
})

// Seen on staging [2026-09-29]: the hold's exec had thawed the sprite, the
// listing said running, and the bring-up restarted a daemon that reconnected
// in the same second — ending the 13 streams it still carried.
test('a thawed machine whose registered daemon dials back in is not restarted', async () => {
    const h = buildHarness({
        daemon: offlineDaemon(),
        power: 'running',
        registered: true,
        reconnectsOnThaw: true
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.equal(res.handle?.hostId, 'sbx_1')
    assert.deepEqual(h.calls, ['power'], 'no inspect, no restart')
    assert.equal(h.bumps(), 0)
})

test('a suspended sprite whose daemon does not come back after the wake is bootstrapped', async () => {
    const h = buildHarness({ daemon: offlineDaemon(), power: 'suspended', registered: true })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
    assert.equal(res.handle?.started, true)
    assert.deepEqual(h.calls, ['power', 'wake', 'inspect', 'start'])
    assert.deepEqual(h.mints, [], 'a registered machine is not registered again')
})

// Seen on prod [2026-10-04]: a sprite woken from cold dialed back in 43s after
// the wake, and the bring-up that stopped waiting at 15s timed out inspecting
// the machine while it was still booting.
test('a stopped sprite whose supervised daemon is still booting is waited for, not restarted', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-04T22:50:10Z') })
    const h = buildHarness({
        daemon: offlineDaemon({ startupMethod: 'container' }),
        power: 'stopped',
        registered: true,
        dialsInAfterWakeMs: 45_000,
        tick: (ms) => t.mock.timers.tick(ms)
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host })
    assert.equal(res.handle?.hostId, 'sbx_1')
    assert.deepEqual(h.calls, ['power', 'wake'], 'no inspect and no restart while it boots')
    assert.equal(h.bumps(), 0)
})

test('only a stopped machine whose daemon a supervisor restarts gets the cold wait', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-04T22:50:10Z') })
    for (const [power, startupMethod] of [
        ['suspended', 'container'],
        ['stopped', 'manual']
    ] as const) {
        const h = buildHarness({
            daemon: offlineDaemon({ startupMethod }),
            power,
            registered: true,
            dialsInAfterWakeMs: 45_000,
            tick: (ms) => t.mock.timers.tick(ms)
        })
        const res = await h.service.ensureHostDaemon({ host: h.state.host })
        assert.equal(res.handle?.started, true, `${power}, ${startupMethod}`)
        assert.deepEqual(h.calls, ['power', 'wake', 'inspect', 'start'], `${power}, ${startupMethod}`)
    }
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

// Seen on a local stack [2026-09-28]: `daemon start` keeps dialing the address
// saved at register time, so a sandbox registered before this deployment's
// public URL moved never connects again unless it is registered anew.
test('a daemon registered against another API address is registered again before it starts', async () => {
    await withPublicApi('https://api.example.com', async () => {
        const h = buildHarness({ registered: true, registeredApiUrl: 'https://old-tunnel.example.com/api' })
        const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
        assert.equal(res.handle?.hostId, 'sbx_1')
        assert.deepEqual(h.calls, ['power', 'inspect', 'register', 'start'])
        const register = h.execs.find((e) => e.script.includes('daemon register'))!
        assert.match(register.script, /--api-url https:\/\/api\.example\.com\/api daemon register/)
        assert.equal(h.mints.length, 1)
    })
})

test('a daemon registered against this API is left as it is', async () => {
    await withPublicApi('https://api.example.com/', async () => {
        const h = buildHarness({ registered: true, registeredApiUrl: 'https://api.example.com/api/' })
        await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 50 })
        assert.deepEqual(h.calls, ['power', 'inspect', 'start'])
        assert.equal(h.mints.length, 0)
    })
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
    assert.equal(res.handle?.hostId, 'sbx_1')
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

// WHY: the register's output is the only account of why a new runner never
// connected (an API the machine cannot reach, a rejected token), and the
// caller turns it into the error the user sees.
test('a failed register says what the CLI printed, on one line', async () => {
    const h = buildHarness({
        registered: false,
        registerExit: 1,
        registerOutput: 'cli Error: Unable to connect.\n  Is the computer able to access the url?'
    })
    const res = await h.service.ensureHostDaemon({ host: h.state.host, waitOnlineMs: 20 })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_unavailable')
    assert.equal(
        res.registerFailure,
        'cli Error: Unable to connect. Is the computer able to access the url?'
    )

    const quiet = buildHarness({ registered: false, registerExit: 1, registerOutput: '' })
    const silent = await quiet.service.ensureHostDaemon({ host: quiet.state.host, waitOnlineMs: 20 })
    assert.equal(silent.registerFailure, undefined)
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
    assert.equal(res.handle?.hostId, 'sbx_1')
    assert.deepEqual(h.calls, ['power', 'wake'])
    assert.deepEqual(h.holds, ['ensure-agt_1'], 'held before the machine is touched')
})

test('a socket is a socket: an rpc lease is admitted even when the heartbeat is stale', async () => {
    const h = buildHarness({ daemon: daemonRow({ lastSeenAt: new Date(Date.now() - 120_000) }) })
    const res = await h.service.ensureHostDaemon({ host: h.state.host })
    assert.equal(res.handle?.hostId, 'sbx_1')
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
    assert.equal(handle?.hostId, 'sbx_1')
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
    assert.match(scriptsOf(capable).find((s) => s.includes('daemon stop'))!, /daemon stop --keep-execs/)

    const plain = buildHarness({ registered: true, daemon: offlineDaemon() })
    await plain.service.ensureHostDaemon({ host: plain.state.host, waitOnlineMs: 50 })
    assert.match(scriptsOf(plain).find((s) => s.includes('daemon stop'))!, /daemon stop >/)
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
    for (const res of results) assert.equal(res.handle?.hostId, 'sbx_1')
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

// A hosted machine's daemon is the platform's to keep current (R11): one
// lacking what the work needs is updated during the admission, under its hold.
test('a hosted daemon lacking a required feature is updated under the hold, then admitted', async () => {
    const seen: Array<{ features: readonly string[]; releasedBefore: number }> = []
    const h: ReturnType<typeof buildHarness> = buildHarness({
        daemon: daemonRow({ clientFeatures: [] }),
        hostCli: {
            ensure: async (_host, need) => {
                // Looked at after a tick: a hold released when the admission
                // promise was made, not when it settled, is gone by then.
                await new Promise((resolve) => setTimeout(resolve, 0))
                seen.push({ features: need.features ?? [], releasedBefore: h.releases.length })
                return daemonRow({ clientFeatures: ['exec.roots.v1'], rpcInstanceId: 'api-2' })
            }
        }
    })
    const res = await h.service.ensureHostDaemon({
        host: h.state.host,
        requiredFeatures: ['exec.roots.v1']
    })
    assert.deepEqual(seen, [{ features: ['exec.roots.v1'], releasedBefore: 0 }])
    assert.equal(res.handle?.started, true)
    assert.match(String(res.handle?.generation), /^api-2:/)
    assert.equal(h.releases.length, 1, 'the hold is released once the update is done')
})

test('an update that cannot bring the feature answers runner_cli_too_old', async () => {
    const h = buildHarness({
        daemon: daemonRow({ clientFeatures: [] }),
        hostCli: {
            ensure: async (host) => {
                throw new HostCliTooOldError(host, 'already on the latest', {
                    cliVersion: '4.8.0',
                    latestCliVersion: '4.8.0'
                })
            }
        }
    })
    const res = await h.service.ensureHostDaemon({
        host: h.state.host,
        requiredFeatures: ['exec.roots.v1']
    })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_cli_too_old')
    // Why the update did not help, which used to reach only the log.
    assert.deepEqual(res.cliRefusal, {
        message: 'already on the latest',
        cliVersion: '4.8.0',
        latestCliVersion: '4.8.0'
    })
})

// A daemon finishing its current work before it updates is a retry-soon, not
// a CLI too old to use.
test('a daemon draining for its update answers runner_updating', async () => {
    const h = buildHarness({
        daemon: daemonRow({ clientFeatures: [] }),
        hostCli: {
            ensure: async (host) => {
                throw new HostCliUpdatingError(host)
            }
        }
    })
    const res = await h.service.ensureHostDaemon({
        host: h.state.host,
        requiredFeatures: ['exec.roots.v1']
    })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_updating')
})

test('an update that failed for another reason stays retryable', async () => {
    const h = buildHarness({
        daemon: daemonRow({ clientFeatures: [] }),
        hostCli: {
            ensure: async () => {
                throw new Error('daemon upgrade failed: socket closed')
            }
        }
    })
    const res = await h.service.ensureHostDaemon({
        host: h.state.host,
        requiredFeatures: ['exec.roots.v1']
    })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_unavailable')
})

test('a self-owned computer lacking a feature is told its CLI is too old, and not updated', async () => {
    let asked = false
    const h = buildHarness({
        host: { id: 'dh_1', kind: 'local', providerId: null, providerRef: null },
        daemon: daemonRow({ hostId: 'dh_1', clientFeatures: [] }),
        hostCli: {
            ensure: async () => {
                asked = true
                throw new Error("a self-owned computer is its user's to update")
            }
        }
    })
    const res = await h.service.ensureHostDaemon({
        host: h.state.host,
        requiredFeatures: ['auth-context.v1']
    })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_cli_too_old')
    assert.equal(asked, false)
})

test('a host that is failed, deleting or retired is never brought up', async () => {
    for (const status of ['failed', 'deleting', 'retired'] as const) {
        const h = buildHarness({ host: { status } })
        const res = await h.service.ensureHostDaemon({ host: h.state.host })
        assert.equal(res.handle, null)
        assert.deepEqual(h.calls, [])
    }
})

// The provider's health check found this sandbox's machine broken. The hold
// is itself a wake, so the refusal comes before it, and with a reason no
// retry loop takes for a runner that is merely slow to come up.
test('a sandbox in maintenance is refused before any hold or provider call', async () => {
    const h = buildHarness({ host: { status: 'maintenance' } })
    const res = await h.service.ensureHostDaemon({ host: h.state.host })
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'sandbox_maintenance')
    assert.deepEqual(h.calls, [])
    assert.deepEqual(h.holds, [])
})

test('the floor the bring-up enforces is the shared minimum', () => {
    assert.ok(DAEMON_MIN_CLI_VERSION.length > 0)
})
