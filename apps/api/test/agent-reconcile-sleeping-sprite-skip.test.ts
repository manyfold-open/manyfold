import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'

const WS = '/home/sprite/.nca/workspaces/agent-1'

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    userId: 'u-1',
    name: 'main',
    framework: 'narranexus',
    kind: 'sprites',
    status: 'ready',
    accountId: 'acc-1',
    spriteName: 'nca-user-abc-main',
    spriteId: 'sp-1',
    primaryAgentId: 'agent-1',
    mountPath: WS,
    namespace: null,
    ingressHost: null,
    clusterId: null,
    spriteUrl: null,
    currentPhase: null,
    failureReason: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    lastReconciledAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const fakeDbAgent = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    userId: 'u-1',
    runtimeId: 'rt-1',
    framework: 'narranexus',
    runtime: 'sprites',
    name: 'a1',
    internalId: 'agent-1',
    status: 'running',
    spriteStatus: null,
    workspacePath: WS,
    mountPath: WS,
    spriteName: 'nca-user-abc-main',
    spriteId: 'sp-1',
    accountId: 'acc-1',
    fileRoots: [],
    extras: {},
    model: null,
    namespace: null,
    ingressHost: null,
    clusterId: null,
    failureReason: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    lastReconciledAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const makeDb = (rows: ReturnType<typeof fakeDbAgent>[]) => {
    const inserts: Array<Record<string, unknown>> = []
    const updates: Array<{ set: Record<string, unknown> }> = []
    return {
        inserts,
        updates,
        select: () => ({
            from: () => ({
                where: async () => rows
            })
        }),
        update: () => ({
            set: (s: Record<string, unknown>) => ({
                where: async () => {
                    updates.push({ set: s })
                }
            })
        }),
        insert: () => ({
            values: async (row: Record<string, unknown>) => {
                inserts.push(row)
            }
        })
    }
}

const throwingRegistry = {
    get: () => {
        throw new Error('sleeping sprite must not query the adapter')
    }
}

const recordingRegistry = (live: Array<Record<string, unknown>>) => {
    const calls: number[] = []
    return {
        calls,
        get: () => ({
            listAgents: async () => {
                calls.push(Date.now())
                return live
            }
        })
    }
}

// Scenario 1: every row is asleep (warm/cold/null) on a service-framework sprite.
// WHY: listing a sleeping service-framework sprite wakes the VM (billing + the
// exact #108 wake race), and stale pre-sleep misses must not combine with a
// post-wake fresh-boot empty list.
test('reconcile skips sleeping narranexus sprite: no adapter call, no writes, pendingOrphans cleared', async () => {
    const rows = [
        fakeDbAgent({
            id: 'agent-1',
            internalId: 'agent-1',
            spriteStatus: 'warm'
        }),
        fakeDbAgent({
            id: 'agent-2',
            internalId: 'agent-2',
            spriteStatus: 'cold'
        }),
        fakeDbAgent({
            id: 'agent-3',
            internalId: 'agent-3',
            spriteStatus: null
        })
    ]
    const db = makeDb(rows)

    const svc = new AgentReconcileService(
        db as never,
        throwingRegistry as never
    )
    svc['pendingOrphans'].set('rt-1', new Map([['agent-1', 0]]))

    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(
        db.updates.length,
        0,
        'sleeping sprite skip must not write any update'
    )
    assert.equal(
        db.inserts.length,
        0,
        'sleeping sprite skip must not insert any row'
    )
    assert.equal(
        svc['pendingOrphans'].has('rt-1'),
        false,
        'stale pre-sleep miss evidence must be cleared on skip, or a post-wake fresh-boot empty list would mark instantly'
    )
})

// Scenario 2: one row spriteStatus 'running' on the same runtime.
// WHY: an awake sprite is the only state where the gateway answer is meaningful.
test('reconcile lists narranexus sprite when any row is running', async () => {
    const rows = [
        fakeDbAgent({
            id: 'agent-1',
            internalId: 'agent-1',
            spriteStatus: 'warm'
        }),
        fakeDbAgent({
            id: 'agent-2',
            internalId: 'agent-2',
            spriteStatus: 'running'
        })
    ]
    const db = makeDb(rows)
    const registry = recordingRegistry([
        { id: 'agent-1', name: 'a1', workspace: WS, model: null, extras: {} },
        { id: 'agent-2', name: 'a1', workspace: WS, model: null, extras: {} }
    ])

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(
        registry.calls.length,
        1,
        'adapter must be consulted when a sprite row reports running'
    )
})

// Scenario 3: coding-framework sprites runtime.
// WHY: coding-framework listing is DB-backed — listing would only copy the
// agents table onto itself (#516), so reconcile must not consult the adapter
// at all, awake or asleep. The sleep gate never comes into play.
test('reconcile never lists claude-code sprites (DB-backed fast path)', async () => {
    const rows = [
        fakeDbAgent({
            framework: 'claude-code',
            spriteStatus: 'warm'
        })
    ]
    const db = makeDb(rows)
    const registry = recordingRegistry([
        { id: 'agent-1', name: 'a1', workspace: WS, model: null, extras: {} }
    ])

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(
        fakeRuntime({ framework: 'claude-code' }) as never
    )

    assert.equal(
        registry.calls.length,
        0,
        'coding-framework reconcile must not consult the adapter'
    )
})

// Scenario 4: narranexus on k8s with spriteStatus null rows.
// WHY: the gate is sprites-only; k8s/daemon must not regress.
test('reconcile lists narranexus k8s runtime regardless of spriteStatus', async () => {
    const rows = [fakeDbAgent({ runtime: 'k8s', spriteStatus: null })]
    const db = makeDb(rows)
    const registry = recordingRegistry([
        { id: 'agent-1', name: 'a1', workspace: WS, model: null, extras: {} }
    ])

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(
        fakeRuntime({ kind: 'k8s', namespace: 'nca-dev' }) as never
    )

    assert.equal(
        registry.calls.length,
        1,
        'k8s runtimes must keep reconciling — the sleep gate applies to sprites only'
    )
})

// Scenario 5: poisoned incident row heals once the sprite is awake and listed.
// WHY: pins the defined heal path for incident rows under the skip rule —
// a false-stopped row flips back to running on the first live match.
test('reconcile heals poisoned stopped row when running sprite lists it', async () => {
    const rows = [
        fakeDbAgent({
            status: 'stopped',
            failureReason: 'not present in runtime',
            spriteStatus: 'running'
        })
    ]
    const db = makeDb(rows)
    const registry = recordingRegistry([
        { id: 'agent-1', name: 'a1', workspace: WS, model: null, extras: {} }
    ])

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(db.updates.length, 1, 'live match must update the row')
    assert.equal(
        db.updates[0].set.status,
        'running',
        'heal is instant and unconfirmed — the recovery path for #108-poisoned rows'
    )
    assert.equal(
        db.updates[0].set.failureReason,
        null,
        'healing must clear the stale "not present in runtime" reason'
    )
})

// Scenario 6: verifiedByReport bypasses the sleeping-sprite skip.
// WHY: a fence-valid ready report proves the service is up post-boot, voiding
// both the wake-billing and fresh-boot-race reasons for the gate — the
// subsequent adapter listing is the real verification that keeps the report
// a hint.
test('reconcile with verifiedByReport lists a sleeping narranexus sprite', async () => {
    const rows = [
        fakeDbAgent({
            id: 'agent-1',
            internalId: 'agent-1',
            spriteStatus: null
        }),
        fakeDbAgent({
            id: 'agent-2',
            internalId: 'agent-2',
            spriteStatus: 'warm'
        })
    ]
    const db = makeDb(rows)
    const registry = recordingRegistry([
        { id: 'agent-1', name: 'a1', workspace: WS, model: null, extras: {} },
        { id: 'agent-2', name: 'a1', workspace: WS, model: null, extras: {} }
    ])

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(fakeRuntime() as never, {
        verifiedByReport: true
    })

    assert.equal(
        registry.calls.length,
        1,
        'a fence-valid ready report voids the wake-billing and fresh-boot-race reasons for the skip — the adapter must be consulted'
    )
})

// Scenario 7: the bypass requires verifiedByReport to be true.
// WHY: without the flag the existing skip is preserved — only a fence-valid
// ready report may open the gate, never the mere presence of an opts object.
test('reconcile keeps the sleep skip when verifiedByReport is false', async () => {
    const rows = [fakeDbAgent({ spriteStatus: 'warm' })]
    const db = makeDb(rows)

    const svc = new AgentReconcileService(
        db as never,
        throwingRegistry as never
    )
    await svc.reconcileRuntime(fakeRuntime() as never, {
        verifiedByReport: false
    })

    assert.equal(
        db.updates.length,
        0,
        'without the flag the sleep skip must keep writing nothing'
    )
    assert.equal(
        db.inserts.length,
        0,
        'without the flag the sleep skip must keep inserting nothing'
    )
})

// Scenario 8: touchRuntime's 15s min-wait is NOT bypassed by the flag.
// WHY: the report bypasses the sleep gate but must not become an unbounded
// reconcile trigger — the min-wait/failure backoff is the report-flood bound.
test('second verifiedByReport touch within 15s is dropped', async () => {
    const rows = [fakeDbAgent({ spriteStatus: 'warm' })]
    const db = makeDb(rows)
    const registry = recordingRegistry([
        { id: 'agent-1', name: 'a1', workspace: WS, model: null, extras: {} }
    ])

    const svc = new AgentReconcileService(db as never, registry as never)
    const runtime = fakeRuntime() as never

    svc.touchRuntime(runtime, { verifiedByReport: true })
    await svc['inflight'].get('rt-1')
    assert.equal(
        registry.calls.length,
        1,
        'first verifiedByReport touch must reconcile through the sleep gate'
    )

    svc.touchRuntime(runtime, { verifiedByReport: true })
    assert.equal(
        svc['inflight'].size,
        0,
        'a second touch within 15s must not schedule a reconcile'
    )
    assert.equal(
        registry.calls.length,
        1,
        'verifiedByReport bypasses the sleep gate, not the 15s min-wait — otherwise a flapping reporter becomes an unbounded reconcile trigger'
    )
})

// WHY: background touches on an asleep sprite complete at the sleep gate and
// refresh the ordinary debounce timestamp. They must not consume the one
// chance a fence-valid ready report has to run the authoritative listing.
test('verifiedByReport touch is not dropped after a recent non-report sleep skip', async () => {
    const rows = [fakeDbAgent({ spriteStatus: 'warm' })]
    const db = makeDb(rows)
    const registry = recordingRegistry([
        { id: 'agent-1', name: 'a1', workspace: WS, model: null, extras: {} }
    ])
    const svc = new AgentReconcileService(db as never, registry as never)
    const runtime = fakeRuntime() as never

    svc.touchRuntime(runtime)
    await svc['inflight'].get('rt-1')
    assert.equal(registry.calls.length, 0)

    svc.touchRuntime(runtime, { verifiedByReport: true })
    await svc['inflight'].get('rt-1')
    assert.equal(
        registry.calls.length,
        1,
        'a successful non-report sleep skip must not debounce the ready-report listing'
    )
})

// WHY: a ready report can race an already-running background reconcile. Keep
// one trailing verified pass instead of losing the report at the inflight gate.
test('verifiedByReport touch coalesces behind an inflight non-report reconcile', async () => {
    const rows = [fakeDbAgent({ spriteStatus: 'running' })]
    const db = makeDb(rows)
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve
    })
    const firstBlocked = new Promise<void>((resolve) => {
        releaseFirst = resolve
    })
    let calls = 0
    const registry = {
        get: () => ({
            listAgents: async () => {
                calls += 1
                if (calls === 1) {
                    markFirstStarted()
                    await firstBlocked
                }
                return [
                    {
                        id: 'agent-1',
                        name: 'a1',
                        workspace: WS,
                        model: null,
                        extras: {}
                    }
                ]
            }
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)
    const runtime = fakeRuntime() as never

    svc.touchRuntime(runtime)
    await firstStarted
    svc.touchRuntime(runtime, { verifiedByReport: true })
    releaseFirst()
    await svc['inflight'].get('rt-1')
    await svc['inflight'].get('rt-1')

    assert.equal(calls, 2, 'the ready report must run as one trailing pass')
})

// WHY: priority over successful background debounce must not erase failure
// backoff; an unhealthy runtime still needs the existing bounded retry policy.
test('verifiedByReport touch still respects failure backoff', async () => {
    const rows = [fakeDbAgent({ spriteStatus: 'running' })]
    const db = makeDb(rows)
    let calls = 0
    const registry = {
        get: () => ({
            listAgents: async () => {
                calls += 1
                throw new Error('listing failed')
            }
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)
    const runtime = fakeRuntime() as never

    svc.touchRuntime(runtime)
    await svc['inflight'].get('rt-1')
    svc.touchRuntime(runtime, { verifiedByReport: true })

    assert.equal(calls, 1)
    assert.equal(svc['inflight'].size, 0)
})
