import assert from 'node:assert/strict'
import test from 'node:test'
import { getTableName } from 'drizzle-orm'
import type {
    AgentRuntimeRow,
    RuntimeHostRow,
    RuntimeProvider
} from '@manyfold/db'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import { SpriteServiceBootstraps } from '../src/modules/agents/bootstrap/sprite-service-bootstraps'

// A sprites host (ADR-0037): the adapter makes the machine under a fresh
// generation, the runner manager brings its daemon up, and the framework
// bootstrap runs against the sprite the host's provider_ref names. A create
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
        primaryAgentId: null,
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
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
        ...overrides
    }) as RuntimeHostRow

const noopBootstrap = { run: async () => ({ homeDir: undefined }) } as never

const buildHarness = (opts: {
    bootstrap?: (ctx: { spriteName: string }) => Promise<{ homeDir: string }>
    destroyFails?: boolean
    daemonComesUp?: boolean
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
    const bootstrappedOn: string[] = []
    const shellEnv = { deployEnv: undefined as string | undefined, channel: undefined as string | undefined }

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
                args: { host: RuntimeHostRow },
                work: (session: unknown) => Promise<unknown>
            ) => {
                calls.push('daemon')
                if (opts.daemonComesUp === false) throw new Error('daemon never came up')
                // The daemon registering is what flips a new sandbox ready.
                state.host = { ...state.host, status: 'ready' }
                return work({ host: args.host, daemonId: args.host.id })
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
        noopBootstrap,
        {
            run: async (ctx: { spriteName: string }) => {
                bootstrappedOn.push(ctx.spriteName)
                return opts.bootstrap ? opts.bootstrap(ctx) : { homeDir: '/home/sprite' }
            }
        } as never,
        noopBootstrap,
        noopBootstrap,
        noopBootstrap,
        new SpriteServiceBootstraps(noopBootstrap, noopBootstrap),
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
        {
            write: async (input: { deployEnv?: string }) => {
                shellEnv.deployEnv = input.deployEnv
            },
            installCli: async (input: { channel: string }) => {
                shellEnv.channel = input.channel
            }
        } as never,
        {} as never,
        { settleHostNotRunning: async () => {} } as never
    )
    return { provisioner, state, calls, hostPatches, powers, revokedForHosts, deletes, bootstrappedOn, shellEnv }
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

test('a fresh host is made by the adapter under a new generation, its daemon brought up, and the bootstrap runs on its sprite', async () => {
    const h = buildHarness()
    const result = await provision(h)

    assert.ok(h.state.reserved?.id)
    assert.match(h.state.reserved!.id, /^art_[a-z2-7]{26}$/)
    assert.deepEqual(h.calls, ['create@2', 'daemon'])
    assert.deepEqual(h.powers, ['running'])
    assert.deepEqual(h.bootstrappedOn, ['sbx-test-host'])
    assert.equal(h.shellEnv.deployEnv, 'local')
    assert.equal(h.shellEnv.channel, 'stable')
    assert.equal(result.host.id, 'sbx_testhost')
    assert.equal(result.host.status, 'ready')
    assert.equal(result.provider.id, 'rtp_test')
    assert.equal(result.homeDir, '/home/sprite')
    assert.equal(result.runtime.hostId, 'sbx_testhost')
})

test('a bootstrap failure on a fresh host takes the host down; a destroy that fails leaves it deleting', async () => {
    const stuck = buildHarness({
        bootstrap: async () => {
            throw new Error('bootstrap failed')
        },
        destroyFails: true
    })
    await assert.rejects(() => provision(stuck), /bootstrap failed/)
    assert.deepEqual(stuck.calls, ['create@2', 'daemon', 'destroy@2'])
    assert.deepEqual(stuck.revokedForHosts, ['sbx_testhost'])
    assert.ok(stuck.hostPatches.some((p) => p.status === 'deleting'))
    assert.deepEqual(stuck.deletes, [], 'the rows stay as the retry record until the VM is confirmed gone')

    const gone = buildHarness({
        bootstrap: async () => {
            throw new Error('bootstrap failed')
        }
    })
    await assert.rejects(() => provision(gone), /bootstrap failed/)
    assert.deepEqual(gone.deletes, ['agent_runtimes', 'host_daemons', 'runtime_hosts'])
})

test('a machine whose daemon never comes up is a failed host', async () => {
    const h = buildHarness({ daemonComesUp: false })
    await assert.rejects(() => provision(h), /daemon never came up/)
    assert.ok(h.hostPatches.some((p) => p.status === 'failed'))
    assert.ok(h.calls.filter((c) => c.startsWith('destroy')).length >= 1)
})

const wakeProvisioner = (
    lease: {
        ensureServiceRunning: (runtime: AgentRuntimeRow) => Promise<{ started: boolean }>
        ensureLease: (runtime: AgentRuntimeRow) => Promise<void>
    },
    keepAwake: boolean
): SpritesProvisioner =>
    new SpritesProvisioner(
        {} as never,
        { findById: async () => hostRow({ status: 'ready', keepAwake }) } as never,
        {} as never,
        { spritesLoggerFor: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        noopBootstrap,
        noopBootstrap,
        noopBootstrap,
        noopBootstrap,
        noopBootstrap,
        new SpriteServiceBootstraps({} as never, {} as never),
        {} as never,
        { get: () => undefined } as never,
        {} as never,
        lease as never,
        { settleHostNotRunning: async () => {} } as never
    )

test('SpritesProvisioner delegates wakes to the keep-alive lease', async () => {
    const calls: string[] = []
    const provisioner = wakeProvisioner(
        {
            ensureServiceRunning: async (runtime: AgentRuntimeRow) => {
                calls.push(runtime.id)
                return { started: true }
            },
            ensureLease: async () => {}
        },
        false
    )
    await provisioner.wakeSpriteRuntime(runtimeRow({ framework: 'hermes', status: 'ready' }))
    assert.deepEqual(calls, ['art_test'])
})

// wakeSpriteRuntime is the seam every traffic entry funnels through (chat,
// channels, automations via markRuntimeActive). Getting it wrong either
// re-fuses wake+lease (a billing task per chat message) or drops the lease on
// cold wakes (the pre-start cleanup deleted the task, so a paid-for slot
// silently vanishes). The switch is the host's keep_awake (ADR-0037 R7).

test('wakeSpriteRuntime never leases for a host that is not kept awake, even on cold start', async () => {
    const calls: string[] = []
    const provisioner = wakeProvisioner(
        {
            ensureServiceRunning: async (runtime: AgentRuntimeRow) => {
                calls.push(`ensureServiceRunning:${runtime.id}`)
                return { started: true }
            },
            ensureLease: async (runtime: AgentRuntimeRow) => {
                calls.push(`ensureLease:${runtime.id}`)
            }
        },
        false
    )
    await provisioner.wakeSpriteRuntime(runtimeRow({ framework: 'hermes', status: 'ready' }))
    assert.deepEqual(calls, ['ensureServiceRunning:art_test'])
})

test('wakeSpriteRuntime re-establishes the lease when a kept-awake host cold-starts', async () => {
    const calls: string[] = []
    const provisioner = wakeProvisioner(
        {
            ensureServiceRunning: async (runtime: AgentRuntimeRow) => {
                calls.push(`ensureServiceRunning:${runtime.id}`)
                return { started: true }
            },
            ensureLease: async (runtime: AgentRuntimeRow) => {
                calls.push(`ensureLease:${runtime.id}`)
            }
        },
        true
    )
    await provisioner.wakeSpriteRuntime(runtimeRow({ framework: 'hermes', status: 'ready' }))
    assert.deepEqual(calls, ['ensureServiceRunning:art_test', 'ensureLease:art_test'])
})

test('wakeSpriteRuntime skips the lease when the kept-awake service was already running', async () => {
    const calls: string[] = []
    const provisioner = wakeProvisioner(
        {
            ensureServiceRunning: async (runtime: AgentRuntimeRow) => {
                calls.push(`ensureServiceRunning:${runtime.id}`)
                return { started: false }
            },
            ensureLease: async (runtime: AgentRuntimeRow) => {
                calls.push(`ensureLease:${runtime.id}`)
            }
        },
        true
    )
    await provisioner.wakeSpriteRuntime(runtimeRow({ framework: 'hermes', status: 'ready' }))
    assert.deepEqual(calls, ['ensureServiceRunning:art_test'])
})
