import assert from 'node:assert/strict'
import test from 'node:test'
import { getTableName } from 'drizzle-orm'
import type {
    AgentRuntimeRow,
    RuntimeHostRow,
    RuntimeProvider
} from '@manyfold/db'
import { stepsFor } from '@manyfold/shared'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'
import { assertStepsFollow } from './helpers/create-steps'

// A sprites host (ADR-0037): the adapter makes the machine under a fresh
// generation, the runner manager brings its daemon up, and a coding framework
// is set up through that daemon, in one session holding the machine. A create
// that fails on a fresh host takes the host with it — through `deleting`,
// tokens revoked, adapter.destroy — and a destroy that fails leaves the host
// `deleting` for a retry.

const provider = { id: 'rtp_test', kind: 'sprites', name: 'test-org' } as RuntimeProvider

const runtimeRow = (
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
        id: 'art_test',
        userId: 'user-1',
        name: 'main',
        framework: 'codex',
        status: 'installing',
        currentPhase: 'creating_sprite',
        failureReason: null,
        hostId: 'sbx_testhost',
        capabilitiesJson: {},
        mountPath: '/home/sprite/.manyfold/workspaces/agt_test',
        controlUiEnabled: true,
        dashboardEnabled: false,
        lastBootstrappedAt: null,
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
        ...overrides
    }) as AgentRuntimeRow

const hostRow = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'sbx_testhost',
        userId: 'user-1',
        kind: 'hosted',
        providerId: provider.id,
        providerRef: { kind: 'sprites', spriteName: 'sbx-test-host', spriteId: null },
        name: 'sandbox-001',
        status: 'provisioning',
        failureReason: null,
        generation: 1,
        powerState: null,
        keepAwake: false,
        homeDir: '/home/sprite',
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
        ...overrides
    }) as RuntimeHostRow


const buildHarness = (opts: {
    setupFails?: boolean
    destroyFails?: boolean
    daemonComesUp?: boolean
    // The bring-up gave up on the new machine's daemon, as it does when the
    // runner cannot register with the API.
    daemonOffline?: boolean
    // What the machine's `mf daemon register` said when it failed.
    registerFailure?: string
} = {}) => {
    const state = {
        host: hostRow(),
        runtime: null as AgentRuntimeRow | null,
        reserved: null as { id: string } | null
    }
    const calls: string[] = []
    const hostPatches: Array<Record<string, unknown>> = []
    const powers: string[] = []
    const revokedForHosts: string[] = []
    const deletes: string[] = []
    const sessions: string[] = []
    const rpcs: string[] = []
    const scripts: string[] = []
    const session = {
        rpc: async (req: { method: string; payload: { path: string; create: boolean } }) => {
            rpcs.push(`${req.method}:${req.payload.path}:${req.payload.create}`)
            return {}
        },
        exec: async (req: { stdin: string }) => {
            scripts.push(req.stdin)
            if (opts.setupFails && req.stdin.includes('.codex'))
                return { exitCode: 1, stdout: '', stderr: 'disk full' }
            return { exitCode: 0, stdout: 'codex-cli 0.130.0', stderr: '' }
        }
    }

    const adapter = {
        create: async (args: { host: RuntimeHostRow; generation: number }) => {
            calls.push(`create@${args.generation}`)
            state.host = {
                ...state.host,
                providerRef: { kind: 'sprites', spriteName: 'sbx-test-host', spriteId: 'sprite-remote-1' }
            }
            return state.host.providerRef
        },
        destroy: async (args: { generation: number }) => {
            calls.push(`destroy@${args.generation}`)
            if (opts.destroyFails) throw new Error('delete down')
        },
        power: async () => 'running',
        wake: async () => {},
        bootstrap: async () => ({ exitCode: 0, stdout: '', stderr: '' })
    }
    const db = {
        transaction: async <T,>(fn: (tx: unknown) => Promise<T>) =>
            fn({
                delete: (table: Parameters<typeof getTableName>[0]) => ({
                    where: async () => {
                        deletes.push(getTableName(table))
                    }
                }),
                update: () => ({ set: () => ({ where: async () => {} }) })
            })
    }
    const provisioner = new SpritesProvisioner(
        db as never,
        {
            findById: async () => state.host,
            findForUser: async () => state.host,
            bumpGeneration: async () => {
                state.host = { ...state.host, generation: state.host.generation + 1 }
                return state.host.generation
            },
            setStatus: async (_id: string, status: RuntimeHostRow['status'], failureReason?: string) => {
                hostPatches.push({ status, failureReason })
                state.host = { ...state.host, status }
                return state.host
            },
            patch: async (_id: string, patch: Record<string, unknown>) => {
                hostPatches.push(patch)
                if (typeof patch.powerState === 'string') powers.push(patch.powerState)
                state.host = { ...state.host, ...patch } as RuntimeHostRow
                return state.host
            }
        } as never,
        { findByHostIds: async () => new Map() } as never,
        {
            providerForHost: async () => provider,
            spritesClientForHost: async (host: RuntimeHostRow) => ({
                client: { name: 'client' },
                spriteName: (host.providerRef as { spriteName: string }).spriteName,
                provider
            }),
            spritesLoggerFor: () => ({ debug() {}, info() {}, warn() {}, error() {} })
        } as never,
        { selectProvider: async () => provider } as never,
        { for: () => adapter } as never,
        {
            withHost: async (
                args: { host: RuntimeHostRow; reason: string },
                work: (session: unknown) => Promise<unknown>
            ) => {
                calls.push('daemon')
                sessions.push(args.reason)
                if (opts.daemonComesUp === false) throw new Error('daemon never came up')
                if (opts.daemonOffline)
                    throw new HostDaemonOfflineError(
                        args.host,
                        'runner_unavailable',
                        undefined,
                        {},
                        opts.registerFailure
                    )
                // The daemon registering is what flips a new sandbox ready.
                state.host = { ...state.host, status: 'ready' }
                return work(session)
            }
        } as never,
        {
            revokeForHost: async (hostId: string) => {
                revokedForHosts.push(hostId)
                return 1
            }
        } as never,
        {
            applyStatusPatch: async (id: string, patch: Partial<AgentRuntimeRow>) => {
                assert.equal(id, state.reserved?.id)
                state.runtime = runtimeRow({ ...state.runtime, ...patch })
            },
            setPhase: async (id: string, phase: string | null) => {
                assert.equal(id, state.reserved?.id)
                state.runtime = runtimeRow({ ...state.runtime, currentPhase: phase })
            },
            findById: async () => state.runtime,
            applyProvisioningPatch: async (id: string, patch: Partial<AgentRuntimeRow>) => {
                assert.equal(id, state.reserved?.id)
                state.runtime = runtimeRow({ ...state.runtime, ...patch })
            }
        } as never,
        {} as never,
        {
            reserveSpriteRuntime: async (input: Partial<AgentRuntimeRow>) => {
                state.reserved = { id: input.id! }
                state.runtime = runtimeRow({ ...input, hostId: 'sbx_testhost' })
                return { runtime: state.runtime, hostCreated: true }
            }
        } as never,
        {
            get: (key: string) =>
                key === 'PUBLIC_API_BASE_URL' ? 'http://api.test' : undefined
        } as never,
        { settleHostNotRunning: async () => {} } as never
    )
    return { provisioner, state, calls, hostPatches, powers, revokedForHosts, deletes, sessions, rpcs, scripts }
}

const provision = (h: ReturnType<typeof buildHarness>) =>
    h.provisioner.provisionRuntime({
        userId: 'user-1',
        framework: 'codex',
        providerId: null,
        isAdmin: false,
        credentials: {},
        emitter: { step: () => {} },
        agentId: 'agt_test'
    })

test('a fresh host is made by the adapter under a new generation, its daemon brought up, and the framework set up through it', async () => {
    const h = buildHarness()
    const result = await provision(h)

    assert.ok(h.state.reserved?.id)
    assert.match(h.state.reserved!.id, /^art_[a-z2-7]{26}$/)
    assert.deepEqual(h.calls, ['create@2', 'daemon', 'daemon'])
    assert.deepEqual(h.sessions, ['provision-sandbox', 'create-codex'])
    assert.deepEqual(h.powers, ['running'])
    // The agent's managed workspace is the daemon's to create.
    assert.deepEqual(h.rpcs, [
        'workspace.ensure:/home/sprite/.manyfold/workspaces/agt_test:true'
    ])
    assert.match(h.scripts[0], /mkdir -p "\$HOME\/\.codex"/)
    assert.equal(result.host.id, 'sbx_testhost')
    assert.equal(result.host.status, 'ready')
    assert.equal(result.provider.id, 'rtp_test')
    assert.equal(result.homeDir, '/home/sprite')
    assert.equal(result.runtime.hostId, 'sbx_testhost')
    assert.equal(result.runtime.frameworkVersion, '0.130.0')
})

// The runner is most of a fresh sandbox's wait, so it is a step of its own,
// reported once the VM exists and before anything runs through the runner.
test('a fresh sandbox reports the VM, then its runner, then the framework, in list order', async () => {
    const h = buildHarness()
    await h.provisioner.provisionRuntime({
        userId: 'user-1',
        framework: 'codex',
        providerId: null,
        isAdmin: false,
        credentials: {},
        emitter: { step: (step) => h.calls.push(`step:${step}`) },
        agentId: 'agt_test'
    })
    assert.deepEqual(h.calls, [
        'step:selecting_account',
        'step:checking_quota',
        'step:creating_sprite',
        'create@2',
        'step:starting_runner',
        'daemon',
        'step:bootstrapping',
        'daemon',
        'step:installing_framework'
    ])
    assertStepsFollow(
        h.calls
            .filter((call) => call.startsWith('step:'))
            .map((call) => call.slice('step:'.length)),
        stepsFor('codex', 'sprites')
    )
})

// Agent create behaves like a pod's: no key-based login and no paid verify
// turn run on the machine, and no platform key is written to it.
test('a coding create logs nothing in, verifies nothing with money and keeps no key on the machine', async () => {
    const h = buildHarness()
    await h.provisioner.provisionRuntime({
        userId: 'user-1',
        framework: 'codex',
        providerId: null,
        isAdmin: false,
        credentials: { openaiApiKey: 'sk-fixture-provider-key' },
        emitter: { step: () => {} },
        agentId: 'agt_test'
    })
    const all = h.scripts.join('\n')
    assert.doesNotMatch(all, /codex login|claude --print/)
    assert.doesNotMatch(all, /sk-fixture-provider-key/)
})

test('a setup failure on a fresh host takes the host down; a destroy that fails leaves it deleting', async () => {
    const stuck = buildHarness({ setupFails: true, destroyFails: true })
    await assert.rejects(() => provision(stuck), /codex-setup-dirs exited 1/)
    assert.deepEqual(stuck.calls, ['create@2', 'daemon', 'daemon', 'destroy@2'])
    assert.deepEqual(stuck.revokedForHosts, ['sbx_testhost'])
    assert.ok(stuck.hostPatches.some((p) => p.status === 'deleting'))
    assert.deepEqual(stuck.deletes, [], 'the rows stay as the retry record until the VM is confirmed gone')

    const gone = buildHarness({ setupFails: true })
    await assert.rejects(() => provision(gone), /codex-setup-dirs exited 1/)
    assert.deepEqual(gone.deletes, ['agent_runtimes', 'host_daemons', 'runtime_hosts'])
})

test('a machine whose daemon never comes up is a failed host', async () => {
    const h = buildHarness({ daemonComesUp: false })
    await assert.rejects(() => provision(h), /daemon never came up/)
    assert.ok(h.hostPatches.some((p) => p.status === 'failed'))
    assert.ok(h.calls.filter((c) => c.startsWith('destroy')).length >= 1)
})

const withPublicApiUrl = (
    t: { after: (fn: () => void) => void },
    value: string
): void => {
    const prior = process.env.PUBLIC_API_BASE_URL
    process.env.PUBLIC_API_BASE_URL = value
    t.after(() => {
        if (prior === undefined) delete process.env.PUBLIC_API_BASE_URL
        else process.env.PUBLIC_API_BASE_URL = prior
    })
}

const responseOf = (err: unknown): { code?: string; details?: unknown } =>
    (
        err as { getResponse?: () => { code?: string; details?: unknown } }
    ).getResponse?.() ?? {}

// A new sandbox's runner has to call the API back. A local stack's
// localhost address can never be reached from the provider's VM, so nothing
// is reserved and no machine is made for a create that could only fail.
test('a new sandbox is refused before any quota or VM when its runner could not reach the API', async (t) => {
    withPublicApiUrl(t, 'http://localhost:7150')
    const h = buildHarness()
    await assert.rejects(
        () => provision(h),
        (err: unknown) => {
            assert.equal(responseOf(err).code, 'SANDBOX_API_UNREACHABLE')
            assert.deepEqual(responseOf(err).details, {
                apiUrl: 'http://localhost:7150/api'
            })
            return true
        }
    )
    assert.equal(h.state.reserved, null)
    assert.deepEqual(h.calls, [])
})

test('a new machine whose runner never connected says which address it had to reach', async (t) => {
    withPublicApiUrl(t, 'https://stopped-tunnel.example.com')
    const h = buildHarness({ daemonOffline: true })
    await assert.rejects(
        () => provision(h),
        (err: unknown) => {
            assert.equal(responseOf(err).code, 'SANDBOX_RUNNER_NOT_CONNECTED')
            assert.deepEqual(responseOf(err).details, {
                hostId: 'sbx_testhost',
                apiUrl: 'https://stopped-tunnel.example.com/api',
                reason: 'runner_unavailable'
            })
            return true
        }
    )
    assert.ok(h.hostPatches.some((p) => p.status === 'failed'))
    assert.ok(h.calls.some((c) => c.startsWith('destroy')))
})

// Seen on the local cloud stack [2026-09-30]: the address alone did not say
// what went wrong; the runner's register had printed it, into the log only.
test('a new machine whose register failed says what the runner said', async (t) => {
    withPublicApiUrl(t, 'https://stopped-tunnel.example.com')
    const said = 'cli Error: Unable to connect. Is the computer able to access the url?'
    const h = buildHarness({ daemonOffline: true, registerFailure: said })
    await assert.rejects(
        () => provision(h),
        (err: unknown) => {
            assert.equal(responseOf(err).code, 'SANDBOX_RUNNER_NOT_CONNECTED')
            assert.equal(
                (err as Error).message,
                `the new sandbox's runner could not register with this API at https://stopped-tunnel.example.com/api: ${said}`
            )
            assert.deepEqual(responseOf(err).details, {
                hostId: 'sbx_testhost',
                apiUrl: 'https://stopped-tunnel.example.com/api',
                reason: 'runner_unavailable',
                registerFailure: said
            })
            return true
        }
    )
})

const wakeProvisioner = (
    services: {
        ensureRunning: (runtime: AgentRuntimeRow) => Promise<boolean>
    },
    keepAwake: boolean
): SpritesProvisioner =>
    new SpritesProvisioner(
        {} as never,
        { findById: async () => hostRow({ status: 'ready', keepAwake }) } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        services as never,
        {} as never,
        { get: () => undefined } as never,
        { settleHostNotRunning: async () => {} } as never
    )

// wakeSpriteRuntime is the seam every traffic entry funnels through (chat,
// channels, automations via markRuntimeActive). Holding the machine awake
// there would place a billing task per chat message; the keep-awake switch is
// the host's (HostKeepAwakeService). It starts again what a sandbox stop left
// stopped, through the host's daemon, and nothing for a coding framework.
test('wakeSpriteRuntime starts a service framework\'s services and holds nothing, switch on or off', async () => {
    for (const keepAwake of [false, true]) {
        for (const started of [true, false]) {
            const calls: string[] = []
            const provisioner = wakeProvisioner(
                {
                    ensureRunning: async (runtime: AgentRuntimeRow) => {
                        calls.push(`ensureRunning:${runtime.id}`)
                        return started
                    }
                },
                keepAwake
            )
            await provisioner.wakeSpriteRuntime(
                runtimeRow({ framework: 'hermes', status: 'ready' })
            )
            assert.deepEqual(calls, ['ensureRunning:art_test'])
        }
    }
    const coding: string[] = []
    await wakeProvisioner(
        {
            ensureRunning: async () => {
                coding.push('called')
                return false
            }
        },
        false
    ).wakeSpriteRuntime(runtimeRow({ framework: 'codex', status: 'ready' }))
    assert.deepEqual(coding, [])
})
