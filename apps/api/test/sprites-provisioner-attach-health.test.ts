import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import { SpritesError } from '@manyfold/sprites'
import type {
    AgentRuntimeRow,
    RuntimeHostRow,
    RuntimeProvider
} from '@manyfold/db'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'
import { spritesErrorFacts } from '../src/modules/hosts/providers/sprites.provider'

// Placement is explicit: no sandbox named means a fresh VM, and only an attach
// lands on a VM that already exists. These tests own that boundary in the
// provisioner — a create never wanders onto someone's existing sandbox, and an
// attach to a VM whose exec endpoint is wedged (#439: handshakes 502ing after
// ~36s) fails before bootstrap instead of during it, leaving a cooldown marker
// and a runtime row that reads failed rather than a pending one.

const provider = { id: 'rtp_test', kind: 'sprites', name: 'test-org' } as RuntimeProvider

const runtimeRow = (overrides: Partial<AgentRuntimeRow>): AgentRuntimeRow =>
    ({
        id: 'art_test',
        userId: 'user-1',
        name: 'main',
        framework: 'gemini-cli',
        status: 'installing',
        currentPhase: 'creating_sprite',
        failureReason: null,
        hostId: null,
        mountPath: '/home/sprite/.manyfold/workspaces/agt_test',
        createdAt: new Date('2026-07-29T00:00:00.000Z'),
        updatedAt: new Date('2026-07-29T00:00:00.000Z'),
        ...overrides
    }) as AgentRuntimeRow

interface Candidate {
    id: string
    spriteName: string
}

interface Harness {
    provisioner: SpritesProvisioner
    daemonAsked: string[]
    reserveCalls: Array<{ id: string; hostId: string | null }>
    statusPatches: Array<Partial<AgentRuntimeRow>>
    cooldowns: Array<{ hostId: string; until: Date }>
    created: string[]
    destroyed: string[]
    // The sprite each framework setup ran on: a coding CLI's through the
    // daemon session, a service framework's bootstrap on its sprite.
    bootstrappedOn: string[]
}

// What the bring-up says of a sandbox whose exec endpoint is wedged.
const unhealthy = (host: RuntimeHostRow): HostDaemonOfflineError =>
    new HostDaemonOfflineError(host, 'sprite_exec_unavailable', {
        failureClass: 'handshake_5xx',
        upstreamStatus: 502
    })

// `candidates` are the sandboxes that exist; only an explicit attachHostId can
// land on one of them.
const buildHarness = (opts: {
    candidates: Candidate[]
    unhealthy?: string[]
    quotaExhausted?: boolean
    bootstrap?: () => Promise<{ homeDir: string }>
}): Harness => {
    const reserveCalls: Harness['reserveCalls'] = []
    const statusPatches: Harness['statusPatches'] = []
    const cooldowns: Harness['cooldowns'] = []
    const created: string[] = []
    const destroyed: string[] = []
    const bootstrappedOn: string[] = []
    const daemonAsked: string[] = []
    const rows = new Map<string, AgentRuntimeRow>()
    const hosts = new Map<string, RuntimeHostRow>()
    for (const c of opts.candidates)
        hosts.set(c.id, {
            id: c.id,
            userId: 'user-1',
            kind: 'hosted',
            providerId: provider.id,
            providerRef: { kind: 'sprites', spriteName: c.spriteName, spriteId: `sprite-${c.id}` },
            name: c.id,
            status: 'ready',
            generation: 1,
            keepAwake: false
        } as RuntimeHostRow)
    let freshHosts = 0

    const runtimes = {
        applyStatusPatch: async (id: string, patch: Partial<AgentRuntimeRow>) => {
            statusPatches.push(patch)
            rows.set(id, runtimeRow({ ...rows.get(id), ...patch, id }))
        },
        applyProvisioningPatch: async (id: string, patch: Partial<AgentRuntimeRow>) => {
            rows.set(id, runtimeRow({ ...rows.get(id), ...patch, id }))
        },
        setPhase: async () => {},
        findById: async (id: string) => rows.get(id) ?? null
    }

    // Mirrors the real reservation contract: a named sandbox is attached to, and
    // anything else builds a fresh VM. There is no implicit candidate search.
    const runtimeAccess = {
        reserveSpriteRuntime: async (input: { id: string; hostId?: string }) => {
            reserveCalls.push({ id: input.id, hostId: input.hostId ?? null })
            const attached = input.hostId
                ? opts.candidates.find((c) => c.id === input.hostId)
                : undefined
            if (attached) {
                const row = runtimeRow({ id: input.id, hostId: attached.id })
                rows.set(input.id, row)
                return { runtime: row, hostCreated: false }
            }
            if (opts.quotaExhausted)
                throw new ForbiddenException({
                    message: 'sandbox limit reached (1 for free plan)',
                    code: 'RUNTIME_LIMIT_REACHED'
                })
            freshHosts += 1
            const hostId = `sbx_fresh${freshHosts}`
            hosts.set(hostId, {
                id: hostId,
                userId: 'user-1',
                kind: 'hosted',
                providerId: provider.id,
                providerRef: { kind: 'sprites', spriteName: `sbx-fresh${freshHosts}`, spriteId: null },
                name: hostId,
                status: 'provisioning',
                generation: 1,
                keepAwake: false
            } as RuntimeHostRow)
            const row = runtimeRow({ id: input.id, hostId })
            rows.set(input.id, row)
            return { runtime: row, hostCreated: true }
        }
    }

    const adapter = {
        create: async (args: { host: RuntimeHostRow }) => {
            created.push(args.host.id)
            const host = hosts.get(args.host.id)!
            hosts.set(host.id, {
                ...host,
                providerRef: { ...(host.providerRef as object), spriteId: 'sprite-remote-1' } as RuntimeHostRow['providerRef']
            })
            return hosts.get(host.id)!.providerRef
        },
        destroy: async (args: { host: RuntimeHostRow }) => {
            destroyed.push(args.host.id)
        },
        power: async () => 'running',
        wake: async () => {},
        bootstrap: async () => ({ exitCode: 0, stdout: '', stderr: '' })
    }

    const hostServices = {
        setUp: async (args: { host: RuntimeHostRow }) => {
            bootstrappedOn.push((args.host.providerRef as { spriteName: string }).spriteName)
            const done = opts.bootstrap ? await opts.bootstrap() : { homeDir: '/home/sprite' }
            return { frameworkVersion: null, generatedCredentials: {}, home: done.homeDir }
        }
    }
    const session = (host: RuntimeHostRow) => ({
        rpc: async () => ({}),
        exec: async (req: { stdin: string }) => {
            if (req.stdin.includes('.gemini'))
                bootstrappedOn.push((host.providerRef as { spriteName: string }).spriteName)
            return { exitCode: 0, stdout: '0.9.0', stderr: '' }
        }
    })

    const provisioner = new SpritesProvisioner(
        {
            transaction: async <T,>(fn: (tx: unknown) => Promise<T>) =>
                fn({
                    delete: () => ({ where: async () => {} }),
                    update: () => ({ set: () => ({ where: async () => {} }) })
                })
        } as never,
        {
            findById: async (id: string) => hosts.get(id) ?? null,
            findForUser: async (_userId: string, id: string) => hosts.get(id) ?? null,
            bumpGeneration: async (id: string) => {
                const host = hosts.get(id)!
                hosts.set(id, { ...host, generation: host.generation + 1 })
                return host.generation + 1
            },
            setPower: async (id: string) => hosts.get(id) ?? null,
            setStatus: async (id: string, status: RuntimeHostRow['status']) => {
                const host = hosts.get(id)!
                hosts.set(id, { ...host, status })
                return hosts.get(id)!
            },
            patch: async (id: string, patch: { execCooldownUntil?: Date; status?: RuntimeHostRow['status'] }) => {
                if (patch.execCooldownUntil)
                    cooldowns.push({ hostId: id, until: patch.execCooldownUntil })
                const host = hosts.get(id)!
                hosts.set(id, { ...host, ...patch } as RuntimeHostRow)
                return hosts.get(id)!
            }
        } as never,
        { findByHostIds: async () => new Map() } as never,
        {
            providerForHost: async () => provider,
            spritesClientForHost: async (host: RuntimeHostRow) => ({
                client: {},
                spriteName: (host.providerRef as { spriteName: string }).spriteName,
                provider
            }),
            spritesLoggerFor: () => ({ debug() {}, info() {}, warn() {}, error() {} })
        } as never,
        { selectProvider: async () => provider } as never,
        { for: () => adapter, describeError: spritesErrorFacts } as never,
        {
            withHost: async (
                args: { host: RuntimeHostRow },
                work: (session: unknown) => Promise<unknown>
            ) => {
                daemonAsked.push(args.host.id)
                const spriteName = (args.host.providerRef as { spriteName: string }).spriteName
                if ((opts.unhealthy ?? []).includes(spriteName))
                    throw unhealthy(args.host)
                // The daemon registering is what flips a new sandbox ready.
                hosts.set(args.host.id, { ...hosts.get(args.host.id)!, status: 'ready' })
                return work(session(args.host))
            }
        } as never,
        { revokeForHost: async () => 1 } as never,
        runtimes as never,
        hostServices as never,
        runtimeAccess as never,
        { get: () => undefined } as never,
        { settleHostNotRunning: async () => {} } as never
    )

    return {
        provisioner,
        daemonAsked,
        reserveCalls,
        statusPatches,
        cooldowns,
        created,
        destroyed,
        bootstrappedOn
    }
}

const provision = (
    harness: Harness,
    attachHostId?: string,
    framework: 'gemini-cli' | 'hermes' = 'gemini-cli'
): Promise<unknown> =>
    harness.provisioner.provisionRuntime({
        userId: 'user-1',
        framework,
        providerId: null,
        attachHostId: attachHostId ?? null,
        isAdmin: false,
        credentials: {},
        emitter: { step: () => {} },
        agentId: 'agt_test'
    })

// Placement is explicit, so a create with no named sandbox must build its own VM
// even when the user has perfectly good sandboxes sitting there.
test('a create with no named sandbox never touches an existing one', async () => {
    const harness = buildHarness({
        candidates: [
            { id: 'sbx_old', spriteName: 'sbx-old' },
            { id: 'sbx_new', spriteName: 'sbx-new' }
        ]
    })

    const result = (await provision(harness)) as { runtime: AgentRuntimeRow }
    assert.equal(result.runtime.hostId, 'sbx_fresh1')

    assert.deepEqual(
        harness.reserveCalls.map((c) => c.hostId),
        [null],
        'one reservation, with no host named — no candidate search, no retry loop'
    )
    assert.deepEqual(harness.created, ['sbx_fresh1'], 'the fresh VM is the adapter\'s')
    assert.deepEqual(
        harness.daemonAsked,
        ['sbx_fresh1', 'sbx_fresh1'],
        'only the fresh host\'s daemon is brought up; no existing sandbox is probed'
    )
    assert.deepEqual(harness.bootstrappedOn, ['sbx-fresh1'])
})

test('an explicit attach to an unhealthy sandbox fails loudly instead of moving the agent', async () => {
    const harness = buildHarness({
        candidates: [
            { id: 'sbx_target', spriteName: 'sbx-target' },
            { id: 'sbx_other', spriteName: 'sbx-other' }
        ],
        unhealthy: ['sbx-target']
    })

    await assert.rejects(provision(harness, 'sbx_target'), /is not accepting commands/)

    assert.equal(
        harness.reserveCalls.length,
        1,
        'the caller named one sandbox; failing over would silently ignore that'
    )
    assert.deepEqual(harness.bootstrappedOn, [])
    assert.ok(
        harness.statusPatches.some((p) => p.status === 'failed'),
        'the abandoned reservation reads failed and keeps its slot'
    )
    assert.deepEqual(
        harness.cooldowns.map((c) => c.hostId),
        ['sbx_target'],
        'the wedged VM still gets its diagnostic marker'
    )
    assert.ok(
        harness.cooldowns[0].until.getTime() > Date.now(),
        'a cooldown already in the past would record nothing'
    )
    assert.deepEqual(harness.created, [], 'a failed attach must not fall back to creating a VM')
})

// A service framework's setup ends by routing the sandbox's public URL
// through the sprites control plane, so a sprites transport failure can land
// there.
test('a transient sprite failure while setting up an attached host quarantines that host', async () => {
    const harness = buildHarness({
        candidates: [{ id: 'sbx_reused', spriteName: 'sbx-reused' }],
        bootstrap: async () => {
            throw new SpritesError(
                'transient',
                'execSpriteStream handshake failed: HTTP 502',
                502,
                undefined,
                { execPhase: 'pre_open' }
            )
        }
    })

    await assert.rejects(provision(harness, 'sbx_reused', 'hermes'), /handshake failed: HTTP 502/)

    assert.deepEqual(
        harness.cooldowns.map((c) => c.hostId),
        ['sbx_reused'],
        'rollback keeps an attached host alive, so the wedge needs recording somewhere'
    )
    assert.ok(harness.statusPatches.some((p) => p.status === 'failed'))
    assert.deepEqual(
        harness.destroyed,
        [],
        'a host shared with other runtimes must not be destroyed by one failed create'
    )
})

test('a non-transient bootstrap failure on an attached host records no cooldown', async () => {
    const harness = buildHarness({
        candidates: [{ id: 'sbx_reused', spriteName: 'sbx-reused' }],
        bootstrap: async () => {
            throw new SpritesError('auth', 'sprites token rejected', 401)
        }
    })

    await assert.rejects(provision(harness, 'sbx_reused', 'hermes'), /token rejected/)

    assert.deepEqual(
        harness.cooldowns,
        [],
        'a bad account token says nothing about the VM; marking it would mislead the next operator'
    )
    assert.deepEqual(harness.destroyed, [])
})

test('a quota refusal leaves nothing behind', async () => {
    const harness = buildHarness({ candidates: [], quotaExhausted: true })
    await assert.rejects(provision(harness), ForbiddenException)
    assert.deepEqual(harness.created, [])
    assert.deepEqual(harness.daemonAsked, [])
})
