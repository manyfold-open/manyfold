import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
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
    // The plan's active-slot cap refuses the admission.
    refuseSlot?: boolean
    // A different refusal: the plan's active hours are used up.
    refuseHours?: boolean
    // Another of the user's sandboxes is awake with an account hold on it.
    otherRunning?: boolean
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
            opts.sandbox && opts.sandbox.id === id ? opts.sandbox : null,
        // The user's other sandbox, when a test has one: awake, holding the
        // plan's one slot only through an account wake's hold on its runtime.
        listSandboxesForUser: async () => [
            ...(opts.sandbox ? [{ host: opts.sandbox }] : []),
            ...(opts.otherRunning
                ? [
                      {
                          host: sandboxRow({
                              id: 'sbx_other',
                              spriteName: 'sbx-other',
                              spriteStatus: 'running'
                          })
                      }
                  ]
                : [])
        ],
        listRuntimesByHost: async (hostId: string) =>
            hostId === 'sbx_other' ? [runtimeRow({ id: 'art_other' })] : []
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
            if (opts.refuseHours)
                throw new ForbiddenException({
                    code: 'ACTIVE_HOURS_QUOTA_REACHED',
                    message:
                        'active hours quota reached (5h included for Free plan this billing period)'
                })
            if (opts.refuseSlot)
                throw new ForbiddenException({
                    code: 'CONCURRENT_ACTIVE_LIMIT_REACHED',
                    message:
                        'concurrent active sprite limit reached (1 for Free plan)'
                })
            return { plan: null, activeCount: 0, wholesale: null }
        }
    }
    const runnerManager = {
        holdSpriteAwake: async (args: { turnId: string; ttl: string }) => {
            calls.push(`holdAwake:${args.turnId}:${args.ttl}`)
            return true
        },
        releaseSpriteAwake: async (args: { turnId: string }) => {
            calls.push(`releaseAwake:${args.turnId}`)
        },
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
        // The woken runner is held awake for the operation that follows;
        // nothing else on this path would keep the VM from re-freezing it.
        'holdAwake:auth-art_1:5m',
        'rpc:auth.list'
    ])
})

test('a wake refused by the active-slot cap lists as sandbox-limit, and nothing is sent', async () => {
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: null,
        refuseSlot: true
    })
    const list = await h.service.list('user-1', 'art_1', { wake: true })
    assert.equal(list.availability, 'sandbox-limit')
    assert.equal(list.capabilities.manage, false)
    assert.deepEqual(h.calls, ['reserveActiveSlot:sbx_1'])
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
        'holdAwake:auth-art_1:5m',
        'rpc:auth.create'
    ])
})

const settle = async (
    calls: string[],
    until: (calls: string[]) => boolean
): Promise<void> => {
    for (let i = 0; i < 50 && !until(calls); i += 1)
        await new Promise((resolve) => setTimeout(resolve, 2))
}

// The form's pick of a sandbox runtime is the user's intent: it spends one
// admitted wake, in the background, and a re-pick inside the window does
// not spend another.
test('prewarm wakes the runner once per window, off the request path', async () => {
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: null
    })
    const first = await h.service.prewarm(principal, 'art_1')
    assert.equal(first.accepted, true)
    await settle(h.calls, (c) => c.some((x) => x.startsWith('holdAwake:')))
    assert.deepEqual(h.calls, [
        // The admission runs on the request, so a refusal is the answer; the
        // wake off the request path admits again (a cheap fast path once the
        // host is committed running).
        'reserveActiveSlot:sbx_1',
        'reserveActiveSlot:sbx_1',
        'spritesClientFor',
        'wakeRunner:sbx-1',
        // A prewarm's hold is the short one; the form renews it while picked.
        'holdAwake:auth-art_1:2m'
    ])
    const again = await h.service.prewarm(principal, 'art_1')
    assert.equal(again.accepted, false, 'debounced inside the window')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(h.calls.length, 5, 'no second wake')
})

test('prewarm is a no-op for a daemon runtime and for an agent principal', async () => {
    const h = harness({ sandbox: null, runner: runnerRow({ id: 'dh_own' }) })
    const service = h.service as unknown as {
        runtimes: { findById: () => Promise<AgentRuntimeRow> }
    }
    service.runtimes.findById = async () =>
        runtimeRow({ kind: 'daemon', daemonId: 'dh_own', hostId: null })
    const daemon = await h.service.prewarm(principal, 'art_1')
    assert.equal(daemon.accepted, false)
    assert.deepEqual(h.calls, [])
    const agentPrincipal = {
        userId: 'user-1',
        kind: 'agent-runtime'
    } as unknown as AuthPrincipal
    await assert.rejects(
        h.service.prewarm(agentPrincipal, 'art_1'),
        (err: { status?: number }) => err.status === 403
    )
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

// The create form's prewarm holds the sandbox for a short window it renews
// while the runtime stays picked; moving the pick releases it, so the plan's
// one active slot is not held by a sandbox the user only glanced at.
test('a prewarm holds the sandbox for the short window; a release drops that hold', async () => {
    const h = harness({ sandbox: sandboxRow(), runner: null })
    const accepted = await h.service.prewarm(principal, 'art_1')
    assert.equal(accepted.accepted, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(h.calls.includes('holdAwake:auth-art_1:2m'), h.calls.join(','))
    const released = await h.service.release(principal, 'art_1')
    assert.equal(released.released, true)
    assert.ok(h.calls.includes('releaseAwake:auth-art_1'), h.calls.join(','))
})

test('a release leaves a sandbox that is not running alone: nothing holds it, and an exec would wake it', async () => {
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: runnerRow()
    })
    const released = await h.service.release(principal, 'art_1')
    assert.equal(released.released, false)
    assert.ok(!h.calls.some((c) => c.startsWith('exec:')), h.calls.join(','))
    assert.ok(!h.calls.some((c) => c.startsWith('releaseAwake:')))
})

test('a wake refused by the slot cap releases the account holds on the other sandbox, then reports the cap', async () => {
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: runnerRow(),
        runnerOnline: false,
        refuseSlot: true,
        otherRunning: true
    })
    const list = await h.service.list('user-1', 'art_1', { wake: true })
    assert.equal(list.availability, 'sandbox-limit')
    assert.ok(
        h.calls.includes('releaseAwake:auth-art_other'),
        h.calls.join(',')
    )
    // Only the other sandbox's holds go; this one was never woken.
    assert.ok(!h.calls.some((c) => c.startsWith('wakeRunner:')))
})

// A prewarm the plan refuses is answered, not swallowed: the create form
// stops waiting for a runner that nothing will start until the hours reset.
test('a prewarm refused for used-up active hours answers with the refusal and wakes nothing', async () => {
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: null,
        refuseHours: true
    })
    const view = await h.service.prewarm(principal, 'art_1')
    assert.equal(view.accepted, false)
    assert.equal(view.refused?.code, 'ACTIVE_HOURS_QUOTA_REACHED')
    assert.match(view.refused?.message ?? '', /active hours/)
    assert.ok(!h.calls.some((c) => c.startsWith('wakeRunner:')))
    // Not debounced: the next click may try again once hours reset.
    const again = await h.service.prewarm(principal, 'art_1')
    assert.equal(again.refused?.code, 'ACTIVE_HOURS_QUOTA_REACHED')
})

test("a prewarm refused by the slot cap reports the cap after releasing the other sandbox's holds", async () => {
    const h = harness({
        sandbox: sandboxRow({ spriteStatus: 'warm' }),
        runner: null,
        refuseSlot: true,
        otherRunning: true
    })
    const view = await h.service.prewarm(principal, 'art_1')
    assert.equal(view.accepted, false)
    assert.equal(view.refused?.code, 'CONCURRENT_ACTIVE_LIMIT_REACHED')
    assert.ok(
        h.calls.includes('releaseAwake:auth-art_other'),
        h.calls.join(',')
    )
})
