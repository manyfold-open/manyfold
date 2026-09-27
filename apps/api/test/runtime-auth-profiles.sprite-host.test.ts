import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import type {
    AgentRuntimeRow,
    HostDaemonRow,
    RuntimeHostRow
} from '@manyfold/db'
import {
    DAEMON_FEATURE_AUTH_PROFILES,
    daemonOnline,
    RUNTIME_AUTH_ERROR
} from '@manyfold/shared'
import type { AuthPrincipal } from '@/common/guards/auth.guard'
import { RuntimeAuthProfilesService } from '@/modules/agent-runtimes/auth/runtime-auth-profiles.service'
import {
    contextOf,
    daemonRow,
    hostRow,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// How the auth-profiles service decides whether a hosted machine's daemon
// can be talked to, and when it may wake the machine to make that true. The
// database and the daemon are fakes; the decision under test is the
// service's own. Seen on staging [2026-09-10]: a runner frozen by sprite
// suspension kept an "online" socket lease, `auth.create` went out on it and
// timed out — the row said online, the VM said warm, and only the VM was
// right. The host row's power state is the authority (ADR-0037).

const runtime = (overrides: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    runtimeRow({
        id: 'art_1',
        userId: 'user-1',
        name: 'claude',
        framework: 'claude-code',
        hostId: 'sbx_1',
        ...overrides
    })

// The runtime's sandbox: running unless a test says otherwise.
const sandboxRow = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    spritesHostRow({
        id: 'sbx_1',
        userId: 'user-1',
        providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: null },
        ...overrides
    })

// The user's own computer.
const localRow = (): RuntimeHostRow => hostRow({ id: 'dh_own', userId: 'user-1' })

// The machine's daemon, advertising auth profiles.
const runnerRow = (overrides: Partial<HostDaemonRow> = {}): HostDaemonRow =>
    daemonRow({
        hostId: 'sbx_1',
        userId: 'user-1',
        clientFeatures: [DAEMON_FEATURE_AUTH_PROFILES],
        ...overrides
    })

// A daemon row whose socket lease has lapsed.
const frozenRunner = (): HostDaemonRow =>
    runnerRow({ lastSeenAt: new Date(0), rpcLastSeenAt: new Date(0) })

const principal = {
    userId: 'user-1',
    kind: 'human-session'
} as unknown as AuthPrincipal

const harness = (opts: {
    // The runtime's machine and its daemon row (null = none registered).
    host: RuntimeHostRow
    daemon: HostDaemonRow | null
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
    let daemon = opts.daemon
    // A drizzle query is awaitable and also has .limit(); the fake mirrors
    // that shape for the profile and operation tables.
    const query = (rows: unknown[]) =>
        Object.assign(Promise.resolve(rows), { limit: async () => rows })
    const db = {
        select: () => ({
            from: () => ({ where: () => query([]) })
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
    // art_other lives on the user's other sandbox (sbx_other); everything
    // else is the runtime under test on its machine.
    const otherHost = sandboxRow({
        id: 'sbx_other',
        powerState: 'suspended',
        providerRef: { kind: 'sprites', spriteName: 'sbx-other', spriteId: null }
    })
    const runtimeOf = (id: string) =>
        id === 'art_other'
            ? runtime({ id: 'art_other', hostId: 'sbx_other' })
            : runtime({ hostId: opts.host.id })
    const runtimes = {
        findById: async (id: string) => runtimeOf(id)
    }
    const runtimeContext = {
        forRuntime: async (id: string) =>
            id === 'art_other'
                ? contextOf({
                      runtime: runtimeOf(id),
                      host: otherHost,
                      daemon: null
                  })
                : contextOf({
                      runtime: runtimeOf(id),
                      host: opts.host,
                      daemon
                  })
    }
    // The user's other sandbox, when a test has one: awake, holding the
    // plan's one slot only through an account wake's hold on its runtime.
    const hosts = {
        listForUser: async () => [
            opts.host,
            ...(opts.otherRunning ? [otherHost] : [])
        ]
    }
    const hostDaemons = {
        findByHostId: async () => daemon,
        isOnline: (row: HostDaemonRow | null) => daemonOnline(row)
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
    const runtimeAccess = {
        reserveActiveSlot: async (input: { hostId: string }) => {
            calls.push(`reserveActiveSlot:${input.hostId}`)
            // The other sandbox is the one already holding the slot.
            if (input.hostId === 'sbx_other') return { plan: null, activeCount: 0, wholesale: null }
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
    // The runner manager's bring-up: the wake is what makes the daemon row
    // exist and answer.
    const hostAccess = {
        ensure: async (args: { host: RuntimeHostRow }) => {
            calls.push(`ensure:${args.host.id}`)
            const result =
                opts.wakeResult === undefined
                    ? { daemonId: args.host.id }
                    : opts.wakeResult
            if (!result)
                return {
                    daemon: null,
                    online: false,
                    fallbackReason: 'runner_unavailable'
                }
            daemon = runnerRow({ hostId: result.daemonId })
            return { daemon, online: true }
        }
    }
    // The awake hold an account wake places (ADR-0038): released by the
    // user's next pick, the form closing or the service's own idle timer.
    const runnerManager = {
        holdAwake: (_host: RuntimeHostRow, reason: string) => {
            calls.push(`hold:${reason}`)
            return {
                settled: Promise.resolve(true),
                release: async () => {
                    calls.push(`release:${reason}`)
                },
                detach: () => {}
            }
        }
    }
    const service = new RuntimeAuthProfilesService(
        db as never,
        runtimes as never,
        runtimeContext as never,
        hosts as never,
        hostDaemons as never,
        daemonRegistry as never,
        account as never,
        runtimeAccess as never,
        hostAccess as never,
        runnerManager as never
    )
    return { service, calls }
}

test('a runner that is "online" while the VM is warm is asleep, and a page open sends it nothing', async () => {
    // The socket lease outlives the suspension by up to 45s; the host row
    // does not. Trusting the lease is what produced the 20s timeouts.
    const h = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: runnerRow()
    })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'sandbox-asleep')
    assert.equal(list.capabilities.manage, false)
    assert.deepEqual(h.calls, [], 'no RPC, no admission, no exec')
})

test('a running VM with an online runner is listed over the RPC as before', async () => {
    const h = harness({ host: sandboxRow(), daemon: runnerRow() })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'ok')
    assert.deepEqual(h.calls, ['rpc:auth.list'])
})

test('a running VM whose runner has no lease is asleep too — the runner, not the VM, is what answers', async () => {
    const h = harness({ host: sandboxRow(), daemon: frozenRunner() })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'sandbox-asleep')
    assert.deepEqual(h.calls, [])
})

test('a sprite that never ran a turn has no runner row: host-unavailable without a wake', async () => {
    const h = harness({ host: sandboxRow(), daemon: null })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'host-unavailable')
    assert.deepEqual(h.calls, [])
})

test('wake=1 on the list admits the sandbox first, then wakes the runner, then lists over it', async () => {
    const h = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: null
    })
    const list = await h.service.list('user-1', 'art_1', { wake: true })
    assert.equal(list.availability, 'ok')
    assert.equal(list.capabilities.manage, true)
    assert.deepEqual(h.calls, [
        'reserveActiveSlot:sbx_1',
        'ensure:sbx_1',
        // The woken runner is held awake for the operation that follows;
        // nothing else on this path would keep the VM from re-freezing it.
        'hold:auth-art_1',
        'rpc:auth.list'
    ])
})

test('a wake refused by the active-slot cap lists as sandbox-limit, and nothing is sent', async () => {
    const h = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: null,
        refuseSlot: true
    })
    const list = await h.service.list('user-1', 'art_1', { wake: true })
    assert.equal(list.availability, 'sandbox-limit')
    assert.equal(list.capabilities.manage, false)
    assert.deepEqual(h.calls, ['reserveActiveSlot:sbx_1'])
})

test('a wake that produces no runner is host-unavailable, and nothing is sent', async () => {
    const h = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: runnerRow(),
        wakeResult: null
    })
    const list = await h.service.list('user-1', 'art_1', { wake: true })
    assert.equal(list.availability, 'host-unavailable')
    assert.ok(!h.calls.some((c) => c.startsWith('rpc:')))
})

test('create without wake on an asleep sandbox is refused as host_unavailable; with wake it goes through', async () => {
    const refused = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: runnerRow()
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
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: runnerRow()
    })
    const created = await woken.service.create(principal, 'art_1', {
        authMethod: 'subscription',
        wake: true
    })
    assert.equal(created.lifecycle, 'pending')
    assert.deepEqual(woken.calls, [
        'reserveActiveSlot:sbx_1',
        'ensure:sbx_1',
        'hold:auth-art_1',
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
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: null
    })
    const first = await h.service.prewarm(principal, 'art_1')
    assert.equal(first.accepted, true)
    await settle(h.calls, (c) => c.some((x) => x.startsWith('hold:')))
    assert.deepEqual(h.calls, [
        // The admission runs on the request, so a refusal is the answer; the
        // wake off the request path admits again (a cheap fast path once the
        // host is committed running).
        'reserveActiveSlot:sbx_1',
        'reserveActiveSlot:sbx_1',
        'ensure:sbx_1',
        // A prewarm's hold is the short one; the form renews it while picked.
        'hold:auth-art_1'
    ])
    const again = await h.service.prewarm(principal, 'art_1')
    assert.equal(again.accepted, false, 'debounced inside the window')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(h.calls.length, 4, 'no second wake')
})

test('prewarm is a no-op for a local runtime and for an agent principal', async () => {
    const h = harness({
        host: localRow(),
        daemon: runnerRow({ hostId: 'dh_own' })
    })
    const local = await h.service.prewarm(principal, 'art_1')
    assert.equal(local.accepted, false)
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

test('a local runtime is untouched by the sandbox rules', async () => {
    const h = harness({
        host: localRow(),
        daemon: runnerRow({ hostId: 'dh_own' })
    })
    const list = await h.service.list('user-1', 'art_1')
    assert.equal(list.availability, 'ok')
    assert.deepEqual(h.calls, ['rpc:auth.list'])
})

// The create form's prewarm holds the sandbox for a short window it renews
// while the runtime stays picked; moving the pick releases it, so the plan's
// one active slot is not held by a sandbox the user only glanced at.
test('a prewarm holds the sandbox for the short window; a release drops that hold', async () => {
    const h = harness({ host: sandboxRow(), daemon: null })
    const accepted = await h.service.prewarm(principal, 'art_1')
    assert.equal(accepted.accepted, true)
    await settle(h.calls, (c) => c.some((x) => x.startsWith('hold:')))
    assert.ok(h.calls.includes('hold:auth-art_1'), h.calls.join(','))
    const released = await h.service.release(principal, 'art_1')
    assert.equal(released.released, true)
    assert.ok(h.calls.includes('release:auth-art_1'), h.calls.join(','))
})

test('a release leaves a sandbox that is not running alone: nothing holds it, and an exec would wake it', async () => {
    const h = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: runnerRow()
    })
    const released = await h.service.release(principal, 'art_1')
    assert.equal(released.released, false)
    assert.ok(!h.calls.some((c) => c.startsWith('ensure:')), h.calls.join(','))
    assert.ok(!h.calls.some((c) => c.startsWith('release:')))
})

test('a wake refused by the slot cap releases the account holds on the other sandbox, then reports the cap', async () => {
    const h = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: frozenRunner(),
        refuseSlot: true,
        otherRunning: true
    })
    // The other sandbox holds the slot through an account wake of its own.
    await h.service.list('user-1', 'art_other', { wake: true })
    assert.ok(h.calls.includes('hold:auth-art_other'), h.calls.join(','))
    const list = await h.service.list('user-1', 'art_1', { wake: true })
    assert.equal(list.availability, 'sandbox-limit')
    assert.ok(
        h.calls.includes('release:auth-art_other'),
        h.calls.join(',')
    )
    // Only the other sandbox's holds go; this one was never woken.
    assert.ok(!h.calls.includes('ensure:sbx_1'))
})

// A prewarm the plan refuses is answered, not swallowed: the create form
// stops waiting for a runner that nothing will start until the hours reset.
test('a prewarm refused for used-up active hours answers with the refusal and wakes nothing', async () => {
    const h = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: null,
        refuseHours: true
    })
    const view = await h.service.prewarm(principal, 'art_1')
    assert.equal(view.accepted, false)
    assert.equal(view.refused?.code, 'ACTIVE_HOURS_QUOTA_REACHED')
    assert.match(view.refused?.message ?? '', /active hours/)
    assert.ok(!h.calls.some((c) => c.startsWith('ensure:')))
    // Not debounced: the next click may try again once hours reset.
    const again = await h.service.prewarm(principal, 'art_1')
    assert.equal(again.refused?.code, 'ACTIVE_HOURS_QUOTA_REACHED')
})

test("a prewarm refused by the slot cap reports the cap after releasing the other sandbox's holds", async () => {
    const h = harness({
        host: sandboxRow({ powerState: 'suspended' }),
        daemon: null,
        refuseSlot: true,
        otherRunning: true
    })
    await h.service.list('user-1', 'art_other', { wake: true })
    const view = await h.service.prewarm(principal, 'art_1')
    assert.equal(view.accepted, false)
    assert.equal(view.refused?.code, 'CONCURRENT_ACTIVE_LIMIT_REACHED')
    assert.ok(
        h.calls.includes('release:auth-art_other'),
        h.calls.join(',')
    )
})
