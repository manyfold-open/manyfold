import assert from 'node:assert/strict'
import test from 'node:test'
import {
    parseRunnerStatus,
    RunnerManagerService,
    RUNNER_PROFILE,
    runnerHostName
} from '../src/modules/chat/runner/runner-manager.service'

// Two probe facts drive these contracts (real sprite, 2026-07-24):
// a sprite has no supervisor, so we start the runner ourselves; and its reverse
// WSS does NOT survive sprite suspension (`pong timeout` while the process is
// still alive), so ensureRunner runs on the TURN path and must be a cheap no-op
// when the runner is already connected and must DEGRADE (null), never throw,
// when it cannot be brought up — the caller falls back to sprite exec.

interface ExecCall {
    cmd: string
    stdin?: string
}

const buildHarness = (opts: {
    // sprite state: what the first inspect exec reports
    installed?: boolean
    registered?: boolean
    // host row visibility: null until the register call "creates" it
    hostIdAfterRegister?: string | null
    hostIdUpfront?: string | null
    onlineAfterStart?: boolean
    onlineUpfront?: boolean
    // what `mf --version` reports inside the sprite
    version?: string
    execExit?: (cmd: string) => number
    execThrowOn?: (cmd: string) => boolean
    // host-row root for the workspace-register gate + daemon-RPC behaviour
    workspaceBaseDir?: string | null
    workspaceEnsureFails?: boolean
}) => {
    const calls: ExecCall[] = []
    let hostId = opts.hostIdUpfront ?? null
    let online = opts.onlineUpfront ?? false
    let minted = 0
    const mintedPurposes: Array<string | undefined> = []
    const deleteUnboundCalls: Array<{ tokenId: string; userId: string }> = []
    const rpcCalls: Array<{
        daemonId: string
        method: string
        payload: Record<string, unknown>
    }> = []

    const exec = async (args: {
        cmd: string[]
        stdin?: string
        timeoutMs: number
    }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        const cmd = args.cmd.join(' ')
        calls.push({ cmd, stdin: args.stdin })
        if (opts.execThrowOn?.(cmd)) throw new Error('exec transport failed')
        const exitCode = opts.execExit ? opts.execExit(cmd) : 0
        if (cmd.includes('install.sh')) {
            return { exitCode, stdout: '', stderr: '' }
        }
        if (cmd.includes('test -x')) {
            return {
                exitCode,
                stdout: `installed=${opts.installed === false ? 0 : 1}\nregistered=${
                    opts.registered === false ? 0 : 1
                }\nversion=${opts.version ?? '0.34.0'}`,
                stderr: ''
            }
        }
        if (cmd.includes('daemon register')) {
            if (exitCode === 0) hostId = opts.hostIdAfterRegister ?? 'dh_runner'
            return {
                exitCode,
                stdout: exitCode === 0 ? '✓ daemon registered' : '',
                stderr: ''
            }
        }
        if (cmd.includes('daemon start')) {
            if (exitCode === 0 && opts.onlineAfterStart !== false) online = true
            return { exitCode, stdout: '', stderr: '' }
        }
        return { exitCode, stdout: '', stderr: '' }
    }

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        hostId ? [{ id: hostId, status: 'active' }] : []
                })
            })
        })
    }
    // Readiness is the HOST ROW (cross-instance), not a local socket map.
    const hosts = {
        isOnline: (row: { id: string }) => online && row.id === hostId,
        findById: async (id: string) =>
            hostId && id === hostId
                ? {
                      id: hostId,
                      workspaceBaseDir:
                          opts.workspaceBaseDir === undefined
                              ? '/home/sprite/.manyfold/workspaces'
                              : opts.workspaceBaseDir
                  }
                : null
    }
    const registry = {
        rpc: async (a: {
            daemonId: string
            method: string
            payload: Record<string, unknown>
        }) => {
            rpcCalls.push(a)
            if (opts.workspaceEnsureFails)
                throw new Error('workspace directory does not exist')
            return {}
        }
    }
    const tokens = {
        mint: async (a: { userId: string; name: string; purpose?: string }) => {
            minted++
            mintedPurposes.push(a.purpose)
            return {
                tokenId: 'ldt_id',
                plaintext: 'ldt_secret_value',
                name: a.name,
                expiresAt: null,
                createdAt: new Date()
            }
        },
        deleteUnbound: async (a: { tokenId: string; userId: string }) => {
            deleteUnboundCalls.push(a)
            return true
        }
    }
    // `delay` is overridden rather than injected: a function has no DI token,
    // and passing one as a constructor param broke the Nest container at boot.
    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    const service = new TestRunnerManager(
        db as never,
        hosts as never,
        tokens as never,
        registry as never
    )
    return {
        service,
        calls,
        exec,
        mintedCount: () => minted,
        mintedPurposes,
        deleteUnboundCalls,
        rpcCalls
    }
}

// A registered runner whose token is rejected (`ws closed code=4401
// reason=unauthorized`) is a DEAD END without this: the sprite still has a
// config, so inspect keeps reporting registered=1 and nothing ever mints a
// replacement. It happened on staging exactly 24h after registering, because the
// token TTL was 1 day and the token also authenticates every websocket connect.
const rejectedCredentialHarness = (
    logTail = 'ws closed code=4401 reason=unauthorized'
) => {
    const calls: string[] = []
    let registrations = 0
    let online = false
    const exec = async (a: { cmd: string[] }) => {
        const cmd = a.cmd.join(' ')
        calls.push(cmd)
        if (cmd.includes('tail -n'))
            return {
                exitCode: 0,
                stdout: logTail,
                stderr: ''
            }
        if (cmd.includes('test -x'))
            return {
                exitCode: 0,
                stdout: 'installed=1\nregistered=1\nversion=0.20.0',
                stderr: ''
            }
        if (cmd.includes('daemon register')) {
            registrations++
            // The fresh credential is what lets the next start connect.
            online = true
            return { exitCode: 0, stdout: 'daemon registered', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'dh_runner', status: 'active' }]
                })
            })
        })
    }
    const hosts = { isOnline: () => online }
    const tokens = {
        mint: async (x: { name: string }) => ({
            tokenId: 't',
            plaintext: 'ldt_fresh',
            name: x.name,
            expiresAt: null,
            createdAt: new Date()
        }),
        deleteUnbound: async () => true
    }
    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    return {
        service: new TestRunnerManager(
            db as never,
            hosts as never,
            tokens as never,
            { rpc: async () => ({}) } as never
        ),
        exec,
        calls,
        registrations: () => registrations
    }
}

test('a runner whose credential is rejected is re-registered once', async () => {
    const h = rejectedCredentialHarness()

    const res = await h.service.ensureRunner({
        agentId: 'agt_1',
        userId: 'user-1',
        spriteName: 'art-abc',
        exec: h.exec as never,
        waitOnlineMs: 50
    })

    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.equal(h.registrations(), 1, 'exactly one re-registration')
    // It must have LOOKED at the runner log to decide that — re-registering on
    // every failed bring-up would mint tokens for unrelated problems.
    assert.ok(h.calls.some((c) => c.includes('tail -n')))
})

test('old credential-bearing runner logs are scrubbed before warning and re-registration', async (t) => {
    const secret = 'sentinel-runner-private/+='
    const encoded = encodeURIComponent(secret)
    const h = rejectedCredentialHarness(
        `ws connected wss://api.test/api/daemon/ws?token=${encoded}\nws closed code=4401 reason=unauthorized`
    )
    const warnings: string[] = []
    const diagnostics = h.service as unknown as {
        logger: { warn(message: string): void }
        logRunnerTail(args: unknown): Promise<string | null>
    }
    const logger = diagnostics.logger
    const tails: string[] = []
    const readTail = diagnostics.logRunnerTail.bind(h.service)
    t.mock.method(diagnostics, 'logRunnerTail', async (args: unknown) => {
        const tail = await readTail(args)
        tails.push(tail ?? '')
        return tail
    })
    t.mock.method(logger, 'warn', (message: string) => warnings.push(message))
    const result = await h.service.ensureRunner({
        agentId: 'agt_1',
        userId: 'user-1',
        spriteName: 'art-abc',
        exec: h.exec as never,
        waitOnlineMs: 50
    })
    assert.equal(result.handle?.daemonId, 'dh_runner')
    assert.equal(h.registrations(), 1)
    assert(warnings.some(message => message.includes('credential rejected')))
    assert(tails.some(message => message.includes('4401')))
    assert(![...warnings, ...tails].some(message => message.includes(secret) || message.includes(encoded)))
})

const args = (exec: never, extra: Record<string, unknown> = {}) => ({
    agentId: 'agt_1',
    userId: 'user-1',
    spriteName: 'art-abc',
    exec,
    waitOnlineMs: 2000,
    ...extra
})

test('an already-connected runner is a single-lookup no-op', async () => {
    const h = buildHarness({ hostIdUpfront: 'dh_runner', onlineUpfront: true })

    const res = await h.service.ensureRunner(args(h.exec as never))

    assert.deepEqual(res.handle, {
        daemonId: 'dh_runner',
        started: false,
        generation: null
    })
    // WHY: this runs on every turn. Waking/inspecting the sprite when the runner
    // is already there would add a round trip to the hot path.
    assert.deepEqual(h.calls, [], 'no sprite exec at all')
    assert.equal(h.mintedCount(), 0, 'no token minted')
})

test('a cold sprite is inspected, installed, registered, started, then awaited', async () => {
    const h = buildHarness({ installed: false, registered: false })

    const res = await h.service.ensureRunner(args(h.exec as never))

    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.equal(res.handle?.started, true)
    const order = h.calls.map((c) =>
        c.cmd.includes('install.sh')
            ? 'install'
            : c.cmd.includes('test -x')
              ? 'inspect'
              : c.cmd.includes('daemon register')
                ? 'register'
                : c.cmd.includes('daemon start')
                  ? 'start'
                  : 'other'
    )
    assert.deepEqual(order, ['inspect', 'install', 'register', 'start'])
})

// The create path has the VM awake already and does not want to wait the
// ~60-75s a fresh daemon takes to dial in: prepareRunner installs, registers
// and starts, then holds the sprite awake for that connect and returns.
test('prepareRunner installs, registers and starts without waiting for the runner to connect', async () => {
    const h = buildHarness({
        installed: false,
        registered: false,
        onlineAfterStart: false
    })

    const outcome = await h.service.prepareRunner(args(h.exec as never))

    assert.equal(outcome, 'started')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const order = h.calls.map((c) =>
        c.cmd.includes('install.sh')
            ? 'install'
            : c.cmd.includes('test -x')
              ? 'inspect'
              : c.cmd.includes('daemon register')
                ? 'register'
                : c.cmd.includes('daemon start')
                  ? 'start'
                  : c.cmd.includes('/v1/tasks')
                    ? 'hold'
                    : 'other'
    )
    assert.deepEqual(order, ['inspect', 'install', 'register', 'start', 'hold'])
    assert.match(h.calls[4].cmd, /"expire":"5m"/)
})

test('prepareRunner leaves an already-connected runner alone', async () => {
    const h = buildHarness({ hostIdUpfront: 'dh_runner', onlineUpfront: true })

    const outcome = await h.service.prepareRunner(args(h.exec as never))

    assert.equal(outcome, 'live')
    assert.equal(h.calls.length, 1, 'one inspect, no start, no hold')
    assert.ok(h.calls[0].cmd.includes('test -x'))
})

test('the runner token goes over STDIN and never appears in argv', async () => {
    const h = buildHarness({ installed: true, registered: false })

    await h.service.ensureRunner(args(h.exec as never))

    const register = h.calls.find((c) => c.cmd.includes('daemon register'))
    assert.ok(register, 'register must have run')
    // WHY: the sprite's process list is readable by anything else in that VM,
    // and the CLI itself warns that argv tokens leak there.
    assert.equal(register!.stdin, 'ldt_secret_value')
    assert.match(register!.cmd, /--token -/)
    assert.doesNotMatch(register!.cmd, /(?:^|\s)(?:-y|--yes)(?:\s|$)/)
    for (const call of h.calls)
        assert.ok(
            !call.cmd.includes('ldt_secret_value'),
            `token leaked into argv: ${call.cmd}`
        )
})

test('a suspended sprite with an existing runner is only woken and restarted', async () => {
    // The realistic steady state: the runner registered on an earlier turn, so
    // its host row exists, but the WSS died when the sprite was suspended.
    const h = buildHarness({
        installed: true,
        registered: true,
        hostIdUpfront: 'dh_runner',
        onlineUpfront: false
    })

    const res = await h.service.ensureRunner(args(h.exec as never))

    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.equal(h.mintedCount(), 0, 'no second token for an existing runner')
    assert.ok(!h.calls.some((c) => c.cmd.includes('install.sh')))
    assert.ok(!h.calls.some((c) => c.cmd.includes('daemon register')))
})

test('a runner that never reconnects degrades to null instead of throwing', async () => {
    const h = buildHarness({
        installed: true,
        registered: true,
        onlineAfterStart: false
    })

    const res = await h.service.ensureRunner(args(h.exec as never))

    // WHY: the caller must be able to fall back to sprite exec. A throw here
    // would fail a turn that has a perfectly good execution path left.
    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'runner_unavailable')
})

test('a failing exec degrades to null', async () => {
    const h = buildHarness({
        installed: false,
        registered: false,
        execExit: (cmd) => (cmd.includes('install.sh') ? 1 : 0)
    })

    const res = await h.service.ensureRunner(args(h.exec as never))
    assert.equal(res.handle, null)
})

test('concurrent turns on one sprite share a single bring-up', async () => {
    const h = buildHarness({ installed: false, registered: false })

    const [a, b, c] = await Promise.all([
        h.service.ensureRunner(args(h.exec as never)),
        h.service.ensureRunner(args(h.exec as never)),
        h.service.ensureRunner(args(h.exec as never))
    ])

    assert.equal(a.handle?.daemonId, 'dh_runner')
    assert.deepEqual(b.handle, a.handle)
    assert.deepEqual(c.handle, a.handle)
    // WHY: without de-duplication three concurrent turns would each install the
    // CLI and mint a token, and `daemon register` would race with itself.
    assert.equal(
        h.calls.filter((x) => x.cmd.includes('daemon register')).length,
        1
    )
    assert.equal(h.mintedCount(), 1)
})

// A custom workspace (CreateAgentDto.workspace on a shared sandbox) lives
// outside the machine-scoped root the runner registered, and the daemon exec
// guard refuses a cwd it does not know. Staging 2026-08-04: a claude agent
// co-resident on a NarraNexus sandbox with workspace /home/sprite/.narranexus
// failed every runner turn with `claude_exec_failed: … outside allowed roots`
// — while the direct sprite exec the runner replaced would have run it. The
// runner has to be told about the workspace the same way a daemon-runtime
// attach is: workspace.ensure in register-existing mode.
test('a custom workspace is registered with the runner before dispatch', async () => {
    const h = buildHarness({ hostIdUpfront: 'dh_runner', onlineUpfront: true })

    const res = await h.service.ensureRunner(
        args(h.exec as never, { workspacePath: '/home/sprite/.narranexus' })
    )

    assert.deepEqual(res.handle, {
        daemonId: 'dh_runner',
        started: false,
        generation: null
    })
    assert.equal(res.workspace.outcome, 'ensured')
    assert.deepEqual(h.rpcCalls, [
        {
            daemonId: 'dh_runner',
            method: 'workspace.ensure',
            // create:false pins register-existing: the workspace already exists
            // on the sprite, and `create` would instead mean "make a managed
            // dir under the workspaces root".
            payload: { path: '/home/sprite/.narranexus', create: false },
            // The setup deadline, NOT the registry's generic 30s default: a
            // frozen socket inside the presence grace window must cost the turn
            // seconds before the sprite-exec fallback, not the full RPC budget
            // (#592: 8 of 10 production fallbacks burned 29–30.1s here).
            timeoutMs: 5_000
        }
    ])
})

test('a workspace under the runner-managed root skips the register RPC', async () => {
    const h = buildHarness({ hostIdUpfront: 'dh_runner', onlineUpfront: true })

    const res = await h.service.ensureRunner(
        args(h.exec as never, {
            workspacePath: '/home/sprite/.manyfold/workspaces/agt_1'
        })
    )

    // WHY: this runs on every turn, and the default workspace is already inside
    // the root the daemon accepts — an RPC here would be a hot-path round trip
    // for nothing.
    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.equal(res.workspace.outcome, 'base')
    assert.deepEqual(h.rpcCalls, [])
})

test('a turn with no workspace path never touches the registry', async () => {
    const h = buildHarness({ hostIdUpfront: 'dh_runner', onlineUpfront: true })

    const res = await h.service.ensureRunner(args(h.exec as never))

    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.equal(res.workspace.outcome, 'none')
    assert.deepEqual(h.rpcCalls, [])
})

test('a failed workspace registration degrades to null, not a doomed dispatch', async () => {
    const h = buildHarness({
        hostIdUpfront: 'dh_runner',
        onlineUpfront: true,
        workspaceEnsureFails: true
    })

    const res = await h.service.ensureRunner(
        args(h.exec as never, { workspacePath: '/home/sprite/.narranexus' })
    )

    // WHY: dispatching anyway would fail the exec with `outside allowed roots`.
    // Null falls the turn back to the direct sprite exec, which has no such
    // guard — a runner must never be the reason a turn cannot start.
    assert.equal(res.handle, null)
    // A daemon that ANSWERED with an error is not a dead connection: the
    // telemetry bucket must say the preflight itself failed.
    assert.equal(res.fallbackReason, 'workspace_error')
    assert.equal(res.workspace.outcome, 'failed')
})

// #592: a runner can look online for the whole presence grace window while its
// websocket generation is frozen (sprite suspended mid-ping — the audited
// runner logged 28 pong timeouts in 12h) or already closed. The preflight then
// burned the registry's generic 30s RPC default before the direct-sprite
// fallback: 8 of 10 post-rollout fallbacks took 29–30.1s, all on a legacy
// workspace outside the runner's base root, which re-ran workspace.ensure on
// every turn. These pin both halves of the fix: a dead generation is a
// CLASSIFIED fallback bounded by the setup deadline, and a successful
// registration is remembered per daemon generation.
const preflightHarness = (
    opts: {
        generation?: { instanceId: string; connectedAtMs: number } | null
    } = {}
) => {
    let generation =
        opts.generation === undefined
            ? { instanceId: 'api-1', connectedAtMs: 1_000 }
            : opts.generation
    let failWith: string | null = null
    const rpcCalls: Array<Record<string, unknown>> = []
    const execCalls: string[] = []
    const exec = async (a: { cmd: string[] }) => {
        execCalls.push(a.cmd.join(' '))
        return { exitCode: 0, stdout: '', stderr: '' }
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'dh_runner', status: 'active' }]
                })
            })
        })
    }
    const hosts = {
        isOnline: () => true,
        findById: async () => ({
            id: 'dh_runner',
            workspaceBaseDir: '/home/sprite/.manyfold/workspaces',
            rpcInstanceId: generation?.instanceId ?? null,
            rpcConnectedAt: generation
                ? new Date(generation.connectedAtMs)
                : null
        })
    }
    const registry = {
        rpc: async (a: Record<string, unknown>) => {
            rpcCalls.push(a)
            if (failWith) {
                const message = failWith
                failWith = null
                throw new Error(message)
            }
            return {}
        }
    }
    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    const service = new TestRunnerManager(
        db as never,
        hosts as never,
        {} as never,
        registry as never
    )
    const resolve = (workspacePath = '/home/sprite/.narranexus') =>
        service.ensureRunner({
            agentId: 'agt_1',
            userId: 'user-1',
            spriteName: 'art-abc',
            exec: exec as never,
            workspacePath
        })
    return {
        resolve,
        rpcCalls,
        execCalls,
        failNext: (message: string) => {
            failWith = message
        },
        setGeneration: (g: { instanceId: string; connectedAtMs: number }) => {
            generation = g
        }
    }
}

test('a frozen socket behind a fresh host row is a classified, bounded fallback', async () => {
    const h = preflightHarness()
    h.failNext('rpc workspace.ensure timed out')

    const res = await h.resolve()

    assert.equal(res.handle, null)
    assert.equal(res.fallbackReason, 'workspace_timeout')
    // The deadline the manager sends down IS the bound: the registry enforces
    // whatever it is told, and 30s was what it enforced before this fix.
    assert.equal(h.rpcCalls[0].timeoutMs, 5_000)
})

test('a connection that dies during workspace.ensure is classified as such', async () => {
    // Every shape the registry produces for a closed / replaced / mislaid
    // socket, local and broker-relayed. Classifying any of them as a generic
    // error would fold the #592 signal back into the noise bucket.
    for (const message of [
        'connection closed',
        'connection replaced',
        'daemon dh_runner is not connected',
        'daemon dh_runner is offline; no active websocket',
        'daemon dh_runner websocket lease is stale on this api instance'
    ]) {
        const h = preflightHarness()
        h.failNext(message)
        const res = await h.resolve()
        assert.equal(res.handle, null, message)
        assert.equal(res.fallbackReason, 'workspace_connection_closed', message)
    }
})

test('a registered workspace is not re-ensured within one daemon generation', async () => {
    const h = preflightHarness()

    const first = await h.resolve()
    const second = await h.resolve()

    assert.equal(first.workspace.outcome, 'ensured')
    assert.equal(second.handle?.daemonId, 'dh_runner')
    // WHY: the affected production path was a legacy workspace outside the
    // runner's base root, which paid — and bet the turn's latency on — this
    // RPC every single turn.
    assert.equal(second.workspace.outcome, 'cached')
    assert.equal(h.rpcCalls.length, 1)
    // The whole preflight is DB + cache: no sprite exec sneaks onto the hot
    // path either way.
    assert.deepEqual(h.execCalls, [])
})

test('each distinct path is ensured once within one generation', async () => {
    const h = preflightHarness()

    await h.resolve('/home/sprite/.narranexus')
    await h.resolve('/home/sprite/legacy-project')
    const cachedA = await h.resolve('/home/sprite/.narranexus')
    const cachedB = await h.resolve('/home/sprite/legacy-project')

    // One registration per path: sharing a daemon must not let one path's
    // registration vouch for another's.
    assert.equal(h.rpcCalls.length, 2)
    assert.equal(cachedA.workspace.outcome, 'cached')
    assert.equal(cachedB.workspace.outcome, 'cached')
})

test('a generation change invalidates the registration and re-ensures', async () => {
    const h = preflightHarness()
    await h.resolve()

    // Same daemon id, new socket lease: its process may have restarted and
    // forgotten every ensured root, so the cache must not carry over.
    h.setGeneration({ instanceId: 'api-1', connectedAtMs: 2_000 })
    const reconnected = await h.resolve()
    assert.equal(reconnected.workspace.outcome, 'ensured')
    assert.equal(h.rpcCalls.length, 2)

    // Reconnecting through the peer api instance is a new generation too.
    h.setGeneration({ instanceId: 'api-2', connectedAtMs: 2_000 })
    await h.resolve()
    assert.equal(h.rpcCalls.length, 3)
})

test('a failed ensure is not cached: the next turn tries again', async () => {
    const h = preflightHarness()
    h.failNext('rpc workspace.ensure timed out')

    const failed = await h.resolve()
    const retried = await h.resolve()

    assert.equal(failed.handle, null)
    // WHY: caching a failure would pin every later turn to the fallback for
    // the rest of the generation even after the daemon thawed.
    assert.equal(retried.workspace.outcome, 'ensured')
    assert.equal(retried.handle?.daemonId, 'dh_runner')
    assert.equal(h.rpcCalls.length, 2)
})

test('a host row without an rpc lease never uses the cache', async () => {
    const h = preflightHarness({ generation: null })

    await h.resolve()
    const second = await h.resolve()

    // WHY: no lease means mid-reconnect — there is no generation to scope the
    // registration to, and skipping the ensure on trust would dispatch into a
    // daemon that may never have seen the path. Re-ensuring is the safe
    // direction.
    assert.equal(second.workspace.outcome, 'ensured')
    assert.equal(h.rpcCalls.length, 2)
})

// `mf daemon register` also creates one agent_runtime per framework it detects
// inside the sprite. On staging that put a fake host plus 4 runtimes named
// sprite-runner:art-…-{claude-code,codex,gemini-cli,hermes} into the user's own
// runtime list. Marking the host is what keeps the platform's plumbing out of
// their account, so it has to happen on the register path, not somewhere a
// later refactor can drop.
// A sprite from an older image already HAS ~/.local/bin/mf — the legacy binary,
// or the nca->mf bridge symlink the shell-env writes — so the install step is
// skipped and the register runs against a CLI that predates `--token -`. It
// takes the dash literally and rejects it. Measured on a staging codex sprite:
// `daemon register token must start with ldt_`, on every turn, forever, because
// nothing ever reinstalls. The runner must heal itself.
test('a CLI too old to read the token from stdin is reinstalled and retried', async () => {
    const calls: string[] = []
    let registrations = 0
    let installed = false
    const exec = async (a: { cmd: string[] }) => {
        const cmd = a.cmd.join(' ')
        calls.push(cmd)
        if (cmd.includes('test -x'))
            // Reports a CURRENT version on purpose: this pins the BACKSTOP (a
            // register that fails with the stale-flag signature) rather than the
            // version floor, which would otherwise catch it first and make the
            // backstop unreachable.
            return {
                exitCode: 0,
                stdout: 'installed=1\nregistered=0\nversion=0.34.0',
                stderr: ''
            }
        if (cmd.includes('install.sh')) {
            installed = true
            return { exitCode: 0, stdout: '', stderr: '' }
        }
        if (cmd.includes('daemon register')) {
            registrations++
            if (!installed)
                return {
                    exitCode: 1,
                    stdout: '',
                    stderr: 'Error: daemon register token must start with ldt_'
                }
            return { exitCode: 0, stdout: 'daemon registered', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'dh_runner', status: 'active' }]
                })
            })
        })
    }
    const hosts = {
        isOnline: () => installed
    }
    const tokens = {
        mint: async (x: { name: string }) => ({
            tokenId: 't',
            plaintext: 'ldt_fresh',
            name: x.name,
            expiresAt: null,
            createdAt: new Date()
        }),
        deleteUnbound: async () => true
    }
    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    const service = new TestRunnerManager(
        db as never,
        hosts as never,
        tokens as never,
        { rpc: async () => ({}) } as never
    )

    const res = await service.ensureRunner({
        agentId: 'agt_1',
        userId: 'user-1',
        spriteName: 'art-abc',
        exec: exec as never,
        waitOnlineMs: 50
    })

    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.equal(registrations, 2, 'retried after reinstalling')
    assert.ok(
        calls.some((c) => c.includes('install.sh')),
        'reinstalled despite installed=1'
    )
})

// Nothing else ever updates the CLI the platform installed inside a sprite, so
// without a floor a sprite keeps its first binary forever — including bugs since
// fixed in it. The one that matters: below 0.20.0 the exec buffer grows without
// bound and the daemon re-enumerates every turn it ever ran BEFORE dialling
// back, which is the most plausible reason a bring-up blew its 120s budget on a
// sprite that was already installed and registered.
test('a sprite running an outdated runner CLI is upgraded, not just started', async () => {
    const h = buildHarness({ version: '0.19.0' })

    await h.service.ensureRunner(args(h.exec as never))

    assert.ok(
        h.calls.some((c) => c.cmd.includes('install.sh')),
        'installed=1 is not sufficient when the version is below the floor'
    )
})

test('a runner predating header authentication is upgraded even though it cleared the old floor', async () => {
    const h = buildHarness({ version: '0.33.1' })

    await h.service.ensureRunner(args(h.exec as never))

    assert.ok(
        h.calls.some((c) => c.cmd.includes('install.sh')),
        '0.33.1 authenticates with a query credential and must reinstall'
    )
})

for (const version of ['0.34.0', '0.34.0-dev.test'])
    test(`a sprite on ${version} is not reinstalled`, async () => {
        const h = buildHarness({ version })

        await h.service.ensureRunner(args(h.exec as never))

        // WHY: this runs on the turn path. Reinstalling a current CLI would add tens
        // of seconds to a turn for nothing.
        assert.ok(!h.calls.some((c) => c.cmd.includes('install.sh')))
    })

test('registering a runner mints a token the server marks as platform-managed', async () => {
    const h = buildHarness({ installed: false, registered: false })

    await h.service.ensureRunner(args(h.exec as never))

    // WHY: the ONLY thing that makes the register quota-exempt and its host
    // managed. It lives on the token row rather than in the register body or
    // the --name, so a user's own token can never claim it (#804).
    assert.deepEqual(h.mintedPurposes, ['sprite_runner'])
    assert.deepEqual(h.deleteUnboundCalls, [])
})

test('a failed register discards the token it minted', async () => {
    const h = buildHarness({
        installed: false,
        registered: false,
        execExit: (cmd) => (cmd.includes('daemon register') ? 1 : 0)
    })

    await h.service.ensureRunner(args(h.exec as never))

    // Seen on production [2026-08-12]: a rejected bring-up left a valid 90-day
    // token behind, once per turn, and the turn retried every time.
    assert.deepEqual(h.deleteUnboundCalls, [
        { tokenId: 'ldt_id', userId: 'user-1' }
    ])
})

test('a register whose exec throws discards the token it minted', async () => {
    const h = buildHarness({
        installed: false,
        registered: false,
        execThrowOn: (cmd) => cmd.includes('daemon register')
    })

    // The bring-up still degrades to sprite exec rather than failing the turn.
    const res = await h.service.ensureRunner(args(h.exec as never))

    assert.equal(res.handle, null)
    assert.deepEqual(h.deleteUnboundCalls, [
        { tokenId: 'ldt_id', userId: 'user-1' }
    ])
})

test('the runner is bound to its sprite by a derived name', () => {
    // WHY: this name IS the agent↔runner binding until a column exists, so a
    // host belonging to another sprite can never be picked up as this one's.
    assert.equal(runnerHostName('art-abc'), 'sprite-runner:art-abc')
    assert.notEqual(runnerHostName('art-abc'), runnerHostName('art-abd'))
    assert.equal(RUNNER_PROFILE, 'spriterunner')
})

test('the runner probes and registers under the ADR-0014 profile layout', async () => {
    const h = buildHarness({ installed: true, registered: false })

    await h.service.ensureRunner(args(h.exec as never))

    // Probe path comes from shared profilePaths — the same source the CLI
    // derives its layout from, so probe and reality cannot drift.
    const inspect = h.calls.find((c) => c.cmd.includes('test -x'))
    assert.ok(inspect)
    assert.ok(
        inspect.cmd.includes(
            '$HOME/.manyfold/profiles/spriterunner/daemon/config.json'
        )
    )
    // The data plane is the machine-scoped shared root — the CLI's own
    // registration default — so the register command declares nothing:
    // overriding here would be the on-demand isolation vocabulary, which the
    // runner precisely does not want.
    const register = h.calls.find((c) => c.cmd.includes('daemon register'))
    assert.ok(register)
    assert.ok(!register.cmd.includes('--workspace-root'))
    assert.ok(!register.cmd.includes('--skills-dir'))
})

// A runner turn has NO platform-visible activity, so the sprite suspends, the
// frozen runner misses websocket pings and the API drops it mid-turn — measured
// on staging: `runner online` → 34s → `daemon.ws.pong_timeout` → `connection
// closed`. These pin the turn-scoped activity lease that fixes it.
const awakeHarness = (opts: { exitCode?: number } = {}) => {
    const calls: string[] = []
    const exec = async (a: { cmd: string[] }) => {
        calls.push(a.cmd.join(' '))
        return { exitCode: opts.exitCode ?? 0, stdout: '', stderr: '' }
    }
    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    const service = new TestRunnerManager(
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )
    return { service, exec, calls }
}

test('holding the sprite awake creates a per-turn activity lease with a TTL', async () => {
    const h = awakeHarness()

    const ok = await h.service.holdSpriteAwake({
        exec: h.exec as never,
        turnId: 'msg-abc',
        ttl: '30m'
    })

    assert.equal(ok, true)
    assert.equal(h.calls.length, 1)
    assert.match(h.calls[0], /curl -s -X POST \/v1\/tasks -d /)
    // The path must sit before -d with no -H/-o/-w: the other order made curl
    // exit 3 (malformed URL) and the hold silently never happened on staging.
    assert.ok(!h.calls[0].includes('-w '), 'no -w: it breaks sprite-env curl')
    // Falls back to a renew (PUT) so retrying the same turn is not a failure.
    assert.match(h.calls[0], /-X PUT/)
    // The TTL is what makes an API crash mid-turn safe: the lease expires on its
    // own, so the sprite can suspend again instead of being pinned forever.
    assert.match(h.calls[0], /"expire":"30m"/)
    // Per-turn name: two concurrent turns on one sprite must not be able to
    // release each other's lease.
    assert.match(h.calls[0], /"name":"mfturn-msg-abc"/)
})

test('a create-or-renew that succeeds counts as held', async () => {
    const h = awakeHarness()
    assert.equal(
        await h.service.holdSpriteAwake({
            exec: h.exec as never,
            turnId: 'msg-abc',
            ttl: '30m'
        }),
        true
    )
})

test('a rejected hold reports false rather than throwing', async () => {
    const h = awakeHarness({ exitCode: 3 })
    // WHY: the caller must be able to continue the turn — a sprite that suspends
    // is a degraded turn, not a reason to refuse to start one.
    assert.equal(
        await h.service.holdSpriteAwake({
            exec: h.exec as never,
            turnId: 'msg-abc',
            ttl: '30m'
        }),
        false
    )
})

test('the awake lease is renewed so a turn can outlive its TTL', async (t) => {
    const h = awakeHarness()
    t.mock.timers.enable({ apis: ['setInterval'] })

    const hold = h.service.keepSpriteAwake({
        exec: h.exec as never,
        turnId: 'msg-long'
    })
    await Promise.resolve()
    assert.equal(h.calls.length, 1, 'held immediately, not one interval late')

    // WHY this matters: the lease TTL is 30m but a turn may run for the full
    // 2h exec ceiling (maxTimeoutSeconds). Without renewal the sprite suspends
    // at minute 30, freezing the runner mid-answer — the exact failure the
    // lease exists to prevent, just delayed.
    t.mock.timers.tick(31 * 60_000)
    await Promise.resolve()
    assert.ok(h.calls.length >= 4, `renewed while running (${h.calls.length})`)
    assert.ok(h.calls.every((c) => c.includes('mfturn-msg-long')))

    await hold.release()
    const afterRelease = h.calls.length
    assert.match(h.calls[afterRelease - 1], /DELETE .*\/v1\/tasks\/mfturn-/)
    // Releasing stops the renewals: an orphaned interval would pin the sprite
    // awake for the life of the process.
    t.mock.timers.tick(60 * 60_000)
    await Promise.resolve()
    assert.equal(h.calls.length, afterRelease)
    // The turn's finally can run twice (error path then cleanup); a second
    // release must not fire another exec.
    await hold.release()
    assert.equal(h.calls.length, afterRelease)
})

test('detaching leaves the lease alive for whoever resumes the turn', async (t) => {
    const h = awakeHarness()
    t.mock.timers.enable({ apis: ['setInterval'] })

    const hold = h.service.keepSpriteAwake({
        exec: h.exec as never,
        turnId: 'msg-suspended'
    })
    await Promise.resolve()
    const held = h.calls.length

    // WHY: a suspended turn is still being executed by the runner. Deleting the
    // lease on the way out would let the sprite suspend and freeze it
    // mid-answer — the TTL is the right bound, exactly as when this instance
    // dies outright.
    hold.detach()
    t.mock.timers.tick(60 * 60_000)
    await Promise.resolve()
    assert.equal(h.calls.length, held, 'no DELETE, and no further renewals')
    assert.ok(h.calls.every((c) => !c.includes('-X DELETE')))
})

test('releasing deletes that turn lease and swallows failures', async () => {
    const h = awakeHarness()
    await h.service.releaseSpriteAwake({
        exec: h.exec as never,
        turnId: 'msg-abc'
    })
    assert.match(h.calls[0], /DELETE .*\/v1\/tasks\/mfturn-msg-abc/)

    const failing = {
        service: h.service,
        exec: async () => {
            throw new Error('sprite unreachable')
        }
    }
    // WHY: this runs in the turn's finally block — throwing here would turn a
    // completed turn into a failed one, and the TTL already bounds the leak.
    await failing.service.releaseSpriteAwake({
        exec: failing.exec as never,
        turnId: 'msg-abc'
    })
})

// The create is fire-and-forget, so a hold settled on its first poll — routine
// for an adoption that finds the turn already terminal — could see its DELETE
// land before its own POST and leave a full-TTL lease nobody renews. release()
// waits for whatever hold was last in flight before it deletes.
test('releasing waits for the in-flight create so the DELETE cannot overtake it', async () => {
    const calls: string[] = []
    let finishCreate: () => void = () => {}
    const created = new Promise<void>((resolve) => {
        finishCreate = resolve
    })
    const exec = async (a: { cmd: string[] }) => {
        const cmd = a.cmd.join(' ')
        // Only the create is slow; the DELETE answers at once, which is the
        // ordering that used to leak.
        if (/-X POST/.test(cmd)) await created
        calls.push(cmd)
        return { exitCode: 0, stdout: '', stderr: '' }
    }
    const h = awakeHarness()
    const hold = h.service.keepSpriteAwake({
        exec: exec as never,
        turnId: 'msg-fast'
    })
    let released = false
    const releasing = hold.release().then(() => {
        released = true
    })
    await Promise.resolve()
    assert.equal(
        released,
        false,
        'release must not complete ahead of the create'
    )
    assert.equal(calls.length, 0)

    finishCreate()
    await releasing
    assert.equal(calls.length, 2)
    assert.match(calls[0], /-X POST \/v1\/tasks/)
    assert.match(calls[1], /-X DELETE .*\/v1\/tasks\/mfturn-msg-fast/)
})

// The sandbox CLI upgrade swaps ~/.local/bin/mf under a runner that keeps
// running — and heartbeating — the build it was started with: nothing re-execs
// a `setsid nohup` daemon, its own daemon.update refuses without an init unit,
// and a warm sprite resume brings the old process back (staging 2026-09-10:
// sandbox row on the new build, runner row on the old one without
// auth-profiles.v1). These pin what restartForInstalledCli does about that
// process, and what it refuses to do.

const OLD_BUILD = '0.31.2-dev.202609091242.909c84a'
const NEW_BUILD = '0.34.0-dev.test'

const statusJson = (local: Record<string, unknown> | null, pid = 4242) =>
    JSON.stringify({ configured: true, localPid: pid, local })

const restartHarness = (opts: {
    hostRow?: boolean
    statusStdout?: string
    statusExit?: number
    // what the host row reports once `daemon start` ran; null = it never moves
    versionAfterStart?: string | null
    execThrowOn?: (cmd: string) => boolean
}) => {
    const calls: string[] = []
    let rowVersion = OLD_BUILD
    const exec = async (a: {
        cmd: string[]
        timeoutMs: number
    }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        const cmd = a.cmd.join(' ')
        calls.push(cmd)
        if (opts.execThrowOn?.(cmd)) throw new Error('exec transport failed')
        if (cmd.includes('daemon status'))
            return {
                exitCode: opts.statusExit ?? 0,
                stdout: opts.statusStdout ?? statusJson(null, null as never),
                stderr: ''
            }
        if (cmd.includes('daemon start')) {
            if (opts.versionAfterStart) rowVersion = opts.versionAfterStart
            return { exitCode: 0, stdout: '1', stderr: '' }
        }
        if (cmd.includes('tail -n'))
            return { exitCode: 0, stdout: 'daemon running pid=1', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        opts.hostRow === false
                            ? []
                            : [
                                  {
                                      id: 'dh_runner',
                                      status: 'active',
                                      cliVersion: rowVersion
                                  }
                              ]
                })
            })
        })
    }
    const hosts = { isOnline: () => true }
    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    const service = new TestRunnerManager(
        db as never,
        hosts as never,
        {} as never,
        { rpc: async () => ({}) } as never
    )
    const restart = () =>
        service.restartForInstalledCli({
            userId: 'user_1',
            spriteName: 'art-1',
            exec,
            installedVersion: NEW_BUILD,
            waitMs: 20
        })
    return { restart, calls }
}

test('parseRunnerStatus: the running daemon, shell noise, and every way there is no answer', () => {
    assert.deepEqual(
        parseRunnerStatus(
            `Last login: today\n${statusJson({
                version: OLD_BUILD,
                activeExecs: 1,
                activePtys: 0,
                wsConnected: true
            })}\n`
        ),
        {
            kind: 'running',
            version: OLD_BUILD,
            activeExecs: 1,
            activePtys: 0
        }
    )
    // Missing counters read as idle rather than as a parse failure.
    assert.deepEqual(parseRunnerStatus(statusJson({ version: OLD_BUILD })), {
        kind: 'running',
        version: OLD_BUILD,
        activeExecs: 0,
        activePtys: 0
    })
    assert.deepEqual(parseRunnerStatus('{"configured":false}'), {
        kind: 'not-running'
    })
    assert.deepEqual(parseRunnerStatus(statusJson(null, null as never)), {
        kind: 'not-running'
    })
    // A pid with no health: a daemon older than the control socket.
    assert.deepEqual(parseRunnerStatus(statusJson(null)), { kind: 'unknown' })
    assert.deepEqual(parseRunnerStatus('no daemon configured'), {
        kind: 'unknown'
    })
})

test('restart: no managed runner host means nothing runs the old build — no exec at all', async () => {
    const h = restartHarness({ hostRow: false })
    assert.equal(await h.restart(), 'no-runner')
    assert.deepEqual(h.calls, [])
})

test('restart: a registered runner with no process is left to the next bring-up', async () => {
    const h = restartHarness({ statusStdout: statusJson(null, null as never) })
    assert.equal(await h.restart(), 'not-running')
    assert.equal(h.calls.length, 1)
    assert.match(h.calls[0], /MF_PROFILE=spriterunner/)
    assert.match(h.calls[0], /daemon status --json/)
})

test('restart: a daemon already on the installed build is not touched', async () => {
    const h = restartHarness({
        statusStdout: statusJson({ version: NEW_BUILD, activeExecs: 0 })
    })
    assert.equal(await h.restart(), 'current')
    assert.equal(h.calls.length, 1)
})

test('restart: live sessions win — a busy runner keeps its old build', async () => {
    for (const local of [
        { version: OLD_BUILD, activeExecs: 1, activePtys: 0 },
        { version: OLD_BUILD, activeExecs: 0, activePtys: 1 }
    ]) {
        const h = restartHarness({ statusStdout: statusJson(local) })
        assert.equal(await h.restart(), 'busy')
        assert.equal(h.calls.length, 1, JSON.stringify(local))
        assert.ok(!h.calls.some((c) => c.includes('daemon start')))
    }
})

test('restart: an idle runner on the old build is stopped and started, and counts as restarted once the row reports the installed build', async () => {
    const h = restartHarness({
        statusStdout: statusJson({ version: OLD_BUILD, activeExecs: 0 }),
        versionAfterStart: NEW_BUILD
    })
    assert.equal(await h.restart(), 'restarted')
    assert.equal(h.calls.length, 2)
    const start = h.calls[1]
    assert.match(start, /MF_PROFILE=spriterunner/)
    assert.ok(
        start.indexOf('daemon stop') < start.indexOf('daemon start'),
        'stop precedes start in the same exec'
    )
    assert.match(start, /setsid nohup .* daemon start --foreground/)
})

test('restart: the row still on the old build after the wait is a timeout, with the runner log read for the report', async () => {
    const h = restartHarness({
        statusStdout: statusJson({ version: OLD_BUILD, activeExecs: 0 }),
        versionAfterStart: null
    })
    assert.equal(await h.restart(), 'restart-timeout')
    assert.ok(h.calls.some((c) => c.includes('daemon start')))
    assert.ok(h.calls.some((c) => c.includes('tail -n')))
})

test('restart: a daemon that cannot answer its control socket is restarted anyway', async () => {
    for (const h of [
        restartHarness({
            statusStdout: statusJson(null),
            versionAfterStart: NEW_BUILD
        }),
        restartHarness({
            statusExit: 1,
            statusStdout: '',
            versionAfterStart: NEW_BUILD
        })
    ]) {
        assert.equal(await h.restart(), 'restarted')
        assert.ok(h.calls.some((c) => c.includes('daemon start')))
    }
})

test('restart: an exec that throws is reported as failed, never thrown', async () => {
    const h = restartHarness({
        execThrowOn: (cmd) => cmd.includes('daemon status')
    })
    assert.equal(await h.restart(), 'failed')
})

// ---- wakeRunner ---------------------------------------------------------------
// An auth.* RPC has no exec to thaw the sprite and no lease to hold it, and the
// host row cannot tell it the runner is frozen (a suspended process keeps its
// 45s socket lease). Seen on staging [2026-09-10]: heartbeat at :27, sprite
// suspended at :35, `auth.create` at :41 sat on the frozen socket for the full
// RPC timeout, twice. These pin how a wake resolves each state a suspension
// leaves a runner in, and what proves the runner is back.

const wakeHarness = (opts: {
    // host row present at all (a sprite that never had a runner has none)
    hostRow?: boolean
    // what the inspect exec reports
    registered?: boolean
    // the row's lease as the wake finds it
    online?: boolean
    // `mf daemon status --json` inside the sprite
    statusStdout?: string
    // whether the process dials back in on its own after the status probe
    // (a thawed process reconnecting) — refreshes the lease without a start
    reconnectsAfterStatus?: boolean
    // whether `daemon start` brings a fresh lease; false = the row stays as
    // it was
    leaseAfterStart?: boolean
    // the trap: after the start the row reads online, but on the lease the
    // frozen process left behind — nothing new has connected
    staleOnlineAfterStart?: boolean
    execThrowOn?: (cmd: string) => boolean
}) => {
    const calls: string[] = []
    let online = opts.online ?? false
    // A register is what creates the host row.
    let hasRow = opts.hostRow !== false
    // Older than any `since` the wake can take: the lease a frozen process
    // left behind.
    let rpcLastSeenAt = new Date(Date.now() - 60_000)
    const refreshLease = (): void => {
        online = true
        rpcLastSeenAt = new Date(Date.now() + 1_000)
    }
    const exec = async (a: {
        cmd: string[]
        timeoutMs: number
    }): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        const cmd = a.cmd.join(' ')
        calls.push(cmd)
        if (opts.execThrowOn?.(cmd)) throw new Error('exec transport failed')
        if (cmd.includes('test -x'))
            return {
                exitCode: 0,
                stdout: `installed=1\nregistered=${opts.registered === false ? 0 : 1}\nversion=${NEW_BUILD}`,
                stderr: ''
            }
        if (cmd.includes('daemon status')) {
            if (opts.reconnectsAfterStatus) refreshLease()
            return {
                exitCode: 0,
                stdout: opts.statusStdout ?? statusJson(null, null as never),
                stderr: ''
            }
        }
        if (cmd.includes('daemon register')) {
            hasRow = true
            refreshLease()
            return { exitCode: 0, stdout: 'daemon registered', stderr: '' }
        }
        if (cmd.includes('daemon start')) {
            if (opts.staleOnlineAfterStart) online = true
            else if (opts.leaseAfterStart !== false) refreshLease()
            return { exitCode: 0, stdout: '1', stderr: '' }
        }
        if (cmd.includes('tail -n'))
            return { exitCode: 0, stdout: 'daemon running pid=1', stderr: '' }
        return { exitCode: 0, stdout: '', stderr: '' }
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        hasRow
                            ? [
                                  {
                                      id: 'dh_runner',
                                      status: 'active',
                                      rpcLastSeenAt,
                                      rpcInstanceId: 'api-1',
                                      rpcConnectedAt: rpcLastSeenAt
                                  }
                              ]
                            : []
                })
            })
        })
    }
    const hosts = { isOnline: () => online }
    const tokens = {
        mint: async (x: { name: string }) => ({
            tokenId: 't',
            plaintext: 'ldt_fresh',
            name: x.name,
            expiresAt: null,
            createdAt: new Date()
        }),
        deleteUnbound: async () => true
    }
    class TestRunnerManager extends RunnerManagerService {
        protected override delay(): Promise<void> {
            return Promise.resolve()
        }
    }
    const service = new TestRunnerManager(
        db as never,
        hosts as never,
        tokens as never,
        { rpc: async () => ({}) } as never
    )
    const wake = () =>
        service.wakeRunner({
            userId: 'user_1',
            spriteName: 'art-1',
            exec,
            waitOnlineMs: 20
        })
    return { wake, calls }
}

test('wake: a registered runner whose socket the API still holds is live after the one exec that thawed it', async () => {
    const h = wakeHarness({ online: true })
    const res = await h.wake()
    assert.equal(res.outcome, 'live')
    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.deepEqual(
        h.calls.filter((c) => /daemon (status|start|register)/.test(c)),
        [],
        'no probe, no restart: the RPC that follows is the proof'
    )
    assert.ok(
        h.calls.some((c) => c.includes('test -x')),
        'the inspect ran'
    )
})

test('wake: a dropped socket with a live process is a reconnect, not a restart', async () => {
    const h = wakeHarness({
        online: false,
        statusStdout: statusJson({ version: NEW_BUILD, activeExecs: 0 }),
        reconnectsAfterStatus: true
    })
    const res = await h.wake()
    assert.equal(res.outcome, 'reconnected')
    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.ok(!h.calls.some((c) => c.includes('daemon start')))
})

test('wake: no process (a cold VM keeps the config) is started and proven by a fresh lease', async () => {
    const h = wakeHarness({ online: false })
    const res = await h.wake()
    assert.equal(res.outcome, 'restarted')
    assert.equal(res.handle?.daemonId, 'dh_runner')
    assert.ok(h.calls.some((c) => c.includes('daemon start')))
})

test('wake: a silent idle process is restarted; a silent busy one is left alone', async () => {
    const idle = wakeHarness({
        online: false,
        statusStdout: statusJson({ version: NEW_BUILD, activeExecs: 0 })
    })
    assert.equal((await idle.wake()).outcome, 'restarted')
    assert.ok(idle.calls.some((c) => c.includes('daemon start')))

    const busy = wakeHarness({
        online: false,
        statusStdout: statusJson({
            version: NEW_BUILD,
            activeExecs: 1,
            activePtys: 0
        })
    })
    const res = await busy.wake()
    assert.equal(res.outcome, 'busy')
    assert.equal(res.handle, null)
    assert.ok(!busy.calls.some((c) => c.includes('daemon start')))
})

test('wake: after a start, an online row with the OLD lease is not proof — the restart times out', async () => {
    // The frozen process's lease can outlive the start by up to 45s; a wake
    // that trusted `online` here would hand back a daemon that is not there.
    const h = wakeHarness({ online: false, staleOnlineAfterStart: true })
    const res = await h.wake()
    assert.equal(res.outcome, 'not-online')
    assert.equal(res.handle, null)
    assert.ok(
        h.calls.some((c) => c.includes('tail -n')),
        'the runner log was read for the report'
    )
})

test('wake: a sprite that never had a runner takes the bring-up path', async () => {
    const h = wakeHarness({ hostRow: false, registered: false })
    const res = await h.wake()
    assert.equal(res.outcome, 'brought-up')
    assert.ok(h.calls.some((c) => c.includes('daemon register')))
    assert.ok(h.calls.some((c) => c.includes('daemon start')))
})

test('wake: an exec that throws is exec-failed, never thrown', async () => {
    const h = wakeHarness({
        online: true,
        execThrowOn: (cmd) => cmd.includes('test -x')
    })
    const res = await h.wake()
    assert.equal(res.outcome, 'exec-failed')
    assert.equal(res.handle, null)
})
