import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentRuntimeRow, RuntimeHostRow } from '@manyfold/db'
import { runtimeHosts } from '@manyfold/db'
import type { ExecOptions, ExecResult, SpritesClient } from '@manyfold/sprites'
import {
    DAEMON_FEATURE_AUTH_PROFILES,
    RUNTIME_AUTH_ERROR
} from '@manyfold/shared'
import type { AuthPrincipal } from '@/common/guards/auth.guard'
import { RuntimeAuthProfilesService } from '@/modules/agent-runtimes/auth/runtime-auth-profiles.service'

// How the auth-profiles service decides whether a SPRITES runtime's runner
// can be talked to, and when it may wake the sandbox to make that true. The
// database and the daemon are fakes; the decision under test is the
// service's own. Seen on staging [2026-09-10]: a runner frozen by sprite
// suspension kept an "online" socket lease, `auth.create` went out on it and
// timed out — the row said online, the VM said warm, and only the VM was
// right.

const runtimeRow = (
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
        id: 'art_1',
        userId: 'user-1',
        name: 'claude',
        framework: 'claude-code',
        kind: 'sprites',
        status: 'ready',
        daemonId: null,
        hostId: 'sbx_1',
        accountId: 'acct-1',
        spriteName: 'sbx-1',
        defaultAuthProfileId: null,
        ...overrides
    }) as AgentRuntimeRow

const sandboxRow = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'sbx_1',
        userId: 'user-1',
        kind: 'sandbox',
        status: 'active',
        spriteStatus: 'running',
        spriteName: 'sbx-1',
        accountId: 'acct-1',
        clientFeatures: [],
        ...overrides
    }) as RuntimeHostRow

const runnerRow = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'dh_runner',
        userId: 'user-1',
        kind: 'daemon',
        name: 'sprite-runner:sbx-1',
        managed: true,
        status: 'active',
        clientFeatures: [DAEMON_FEATURE_AUTH_PROFILES],
        ...overrides
    }) as RuntimeHostRow

const principal = {
    userId: 'user-1',
    kind: 'human-session'
} as unknown as AuthPrincipal

const harness = (opts: {
    sandbox: RuntimeHostRow | null
    runner: RuntimeHostRow | null
    runnerOnline?: boolean
    // what the runner manager's wake hands back; null = it could not
    wakeResult?: { daemonId: string } | null
}) => {
    const calls: string[] = []
    let runner = opts.runner
    // A drizzle query is awaitable and also has .limit(); the fake mirrors
    // that shape for the three tables the sprite branch touches.
    const rowsFor = (table: unknown): unknown[] =>
        table === runtimeHosts && runner ? [runner] : []
    const query = (rows: unknown[]) =>
        Object.assign(Promise.resolve(rows), { limit: async () => rows })
    const db = {
        select: () => ({
            from: (table: unknown) => ({ where: () => query(rowsFor(table)) })
        }),
        insert: () => ({
            values: (values: Record<string, unknown>) => ({
                returning: async () => [
                    {
                        ...values,
                        lifecycle: 'pending',
                        credentialStatus: 'unknown',
                        credentialGeneration: 0,
                        createdAt: new Date(),
                        updatedAt: new Date()
                    }
                ]
            })
        }),
        update: () => ({
            set: (patch: Record<string, unknown>) => ({
                where: () => {
                    calls.push(`update:${JSON.stringify(Object.keys(patch))}`)
                    return query([])
                }
            })
        })
    }
    const runtimes = {
        findById: async () => runtimeRow(),
        findHostById: async (id: string) =>
            opts.sandbox && opts.sandbox.id === id ? opts.sandbox : null
    }
    const daemonHosts = {
        findById: async (id: string) =>
            runner && runner.id === id ? runner : null,
        isOnline: () => opts.runnerOnline ?? true
    }
    const daemonRegistry = {
        rpc: async (args: { method: string }) => {
            calls.push(`rpc:${args.method}`)
            if (args.method === 'auth.list')
                return { profiles: [], ambient: null }
            if (args.method === 'auth.create')
                return { profileId: 'rap_1', generation: 0, created: true }
            throw new Error(`unexpected rpc ${args.method}`)
        }
    }
    const account = { fromProbe: () => null }
    const accounts = {
        getById: async (id: string) => ({ id, slug: 'acct', token: 'x' }),
        decryptToken: () => 'token'
    }
    const runtimeAccess = {
        reserveActiveSlot: async (input: { hostId: string }) => {
            calls.push(`reserveActiveSlot:${input.hostId}`)
            return { plan: null, activeCount: 0, wholesale: null }
        }
    }
    const runnerManager = {
        wakeRunner: async (args: { spriteName: string }) => {
            calls.push(`wakeRunner:${args.spriteName}`)
            const result =
                opts.wakeResult === undefined
                    ? { daemonId: 'dh_runner' }
                    : opts.wakeResult
            if (result) {
                // The wake is what makes the runner row exist and answer.
                runner = runnerRow({ id: result.daemonId })
                return {
                    handle: {
                        daemonId: result.daemonId,
                        started: true,
                        generation: null
                    },
                    outcome: 'restarted'
                }
            }
            return { handle: null, outcome: 'not-online' }
        }
    }
    class TestService extends RuntimeAuthProfilesService {
        protected override spritesClientFor(): SpritesClient {
            calls.push('spritesClientFor')
            return {} as SpritesClient
        }
        protected override exec(
            _client: SpritesClient,
            spriteName: string,
            _opts: ExecOptions
        ): Promise<ExecResult> {
            calls.push(`exec:${spriteName}`)
            return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
        }
    }
    const service = new TestService(
        db as never,
        runtimes as never,
        daemonHosts as never,
        daemonRegistry as never,
        account as never,
        accounts as never,
        runtimeAccess as never,
        runnerManager as never
    )
    return { service, calls }
}

test('a runner that is "online" while the VM is warm is asleep, and a page open sends it nothing', async () => {
    // The socket lease outlives the suspension by up to 45s; the sandbox row
    // does not. Trusting the lease is what produced the 20s timeouts.
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: runnerRow(),
        runnerOnline: true
    })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'sandbox-asleep')
    assert.equal(list.capabilities.manage, false)
    assert.deepEqual(h.calls, [], 'no RPC, no admission, no exec')
})

test('a running VM with an online runner is listed over the RPC as before', async () => {
    const h = harness({ sandbox: sandboxRow(), runner: runnerRow() })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'ok')
    assert.deepEqual(h.calls, ['rpc:auth.list'])
})

test('a running VM whose runner has no lease is asleep too — the runner, not the VM, is what answers', async () => {
    const h = harness({
        sandbox: sandboxRow(),
        runner: runnerRow(),
        runnerOnline: false
    })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'sandbox-asleep')
    assert.deepEqual(h.calls, [])
})

test('a sprite that never ran a turn has no runner row: host-unavailable without a wake', async () => {
    const h = harness({ sandbox: sandboxRow(), runner: null })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'host-unavailable')
    assert.deepEqual(h.calls, [])
})

test('wake=1 on the list admits the sandbox first, then wakes the runner, then lists over it', async () => {
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: null
    })
    const list = await h.service.list('user-1', 'art_1', { wake: true })
    assert.equal(list.availability, 'ok')
    assert.equal(list.capabilities.manage, true)
    assert.deepEqual(h.calls, [
        'reserveActiveSlot:sbx_1',
        'spritesClientFor',
        'wakeRunner:sbx-1',
        'rpc:auth.list'
    ])
})

test('a wake that produces no runner is host-unavailable, and nothing is sent', async () => {
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: runnerRow(),
        runnerOnline: true,
        wakeResult: null
    })
    const list = await h.service.list('user-1', 'art_1', { wake: true })
    assert.equal(list.availability, 'host-unavailable')
    assert.ok(!h.calls.some((c) => c.startsWith('rpc:')))
})

test('create without wake on an asleep sandbox is refused as host_unavailable; with wake it goes through', async () => {
    const refused = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: runnerRow(),
        runnerOnline: true
    })
    await assert.rejects(
        refused.service.create(principal, 'art_1', {
            authMethod: 'subscription'
        }),
        (err: { response?: { code?: string } }) =>
            err.response?.code === RUNTIME_AUTH_ERROR.hostUnavailable
    )
    assert.deepEqual(refused.calls, [], 'no row minted, no RPC, no wake')

    const woken = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: runnerRow(),
        runnerOnline: true
    })
    const created = await woken.service.create(principal, 'art_1', {
        authMethod: 'subscription',
        wake: true
    })
    assert.equal(created.lifecycle, 'pending')
    assert.deepEqual(woken.calls, [
        'reserveActiveSlot:sbx_1',
        'spritesClientFor',
        'wakeRunner:sbx-1',
        'rpc:auth.create'
    ])
})

test('a daemon runtime is untouched by the sprite rules', async () => {
    const h = harness({ sandbox: null, runner: runnerRow({ id: 'dh_own' }) })
    const service = h.service as unknown as {
        runtimes: { findById: () => Promise<AgentRuntimeRow> }
    }
    service.runtimes.findById = async () =>
        runtimeRow({
            kind: 'daemon',
            daemonId: 'dh_own',
            hostId: null,
            spriteName: null
        })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'ok')
    assert.deepEqual(h.calls, ['rpc:auth.list'])
})
