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
    spriteStatus: 'running',
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

const liveAgent = () => ({
    id: 'agent-1',
    name: 'a1',
    workspace: WS,
    model: null,
    extras: {}
})

const stoppedUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.set.status === 'stopped')

const pendingFor = (svc: AgentReconcileService, runtimeId: string) =>
    svc['pendingOrphans'].get(runtimeId)

// Scenario 1: a single empty list is indistinguishable from a fresh-boot
// race and must never poison — first miss only records a pending entry
test('first confirmed-empty listing records a pending entry and writes no stopped update', async () => {
    const db = makeDb([fakeDbAgent()])
    const registry = {
        get: () => ({
            listAgents: async () => []
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)

    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(
        stoppedUpdates(db).length,
        0,
        'a single empty listing is indistinguishable from a fresh-boot race and must never poison agent.status'
    )
    assert.ok(
        pendingFor(svc, 'rt-1')?.has('agent-1'),
        'first miss must record a pending entry keyed by agent id'
    )
})

// Scenario 2: confirmation is time-based, not call-count-based — a second
// back-to-back listing (<60s) must neither mark nor reset the first-miss clock
test('second back-to-back reconcile (<60s) writes no stopped update and preserves firstMissedAt', async () => {
    const db = makeDb([fakeDbAgent()])
    const registry = {
        get: () => ({
            listAgents: async () => []
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)

    await svc.reconcileRuntime(fakeRuntime() as never)
    const firstMissedAt = pendingFor(svc, 'rt-1')?.get('agent-1')
    assert.equal(typeof firstMissedAt, 'number')

    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(
        stoppedUpdates(db).length,
        0,
        'confirmation is time-based, not call-count-based — two quick misses must not mark'
    )
    assert.equal(
        pendingFor(svc, 'rt-1')?.get('agent-1'),
        firstMissedAt,
        'a repeat miss inside the window must preserve the original firstMissedAt value'
    )
})

// Scenario 3: real out-of-band deletions still converge — a miss confirmed
// by a second successful empty listing >= 60s later marks stopped exactly once
test('pending entry older than 60s is confirmed stopped by the next empty listing', async () => {
    const db = makeDb([fakeDbAgent()])
    const registry = {
        get: () => ({
            listAgents: async () => []
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)
    svc['pendingOrphans'].set(
        'rt-1',
        new Map([['agent-1', Date.now() - 61_000]])
    )

    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(
        db.updates.length,
        1,
        'real out-of-band deletions still converge — exactly one stop-mark update'
    )
    assert.equal(db.updates[0].set.status, 'stopped')
    assert.equal(db.updates[0].set.failureReason, 'not present in runtime')
    assert.equal(
        pendingFor(svc, 'rt-1')?.get('agent-1'),
        undefined,
        'the confirmed orphan must be removed from pendingOrphans'
    )
})

// Scenario 3b: reconcile is touch-driven, so miss evidence older than the
// stale TTL likely predates an unobserved sleep/wake — it must re-arm the
// confirmation window, not instantly confirm against a post-wake fresh-boot
// listing (the re-poisoning race for automation-only agents)
test('pending entry older than the stale TTL re-arms instead of confirming', async () => {
    const db = makeDb([fakeDbAgent()])
    const registry = {
        get: () => ({
            listAgents: async () => []
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)
    svc['pendingOrphans'].set(
        'rt-1',
        new Map([['agent-1', Date.now() - 6 * 60_000]])
    )

    const before = Date.now()
    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(
        stoppedUpdates(db).length,
        0,
        'evidence that survived an unobserved sleep must never instantly stop-mark on the first post-wake listing'
    )
    const rearmedAt = pendingFor(svc, 'rt-1')?.get('agent-1')
    assert.equal(typeof rearmedAt, 'number')
    assert.ok(
        (rearmedAt as number) >= before,
        'stale evidence must be replaced by a fresh first-miss timestamp so confirmation restarts from now'
    )
})

// Scenario 4a: reappearance prunes the pending entry — misses must be
// CONSECUTIVE, so a miss followed by a hit never escalates to a stop-mark
test('miss then hit prunes the pending entry and never writes stopped', async () => {
    const db = makeDb([fakeDbAgent()])
    let live: Array<Record<string, unknown>> = []
    const registry = {
        get: () => ({
            listAgents: async () => live
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)

    await svc.reconcileRuntime(fakeRuntime() as never)
    assert.ok(
        pendingFor(svc, 'rt-1')?.has('agent-1'),
        'the first miss must arm a pending entry'
    )

    live = [liveAgent()]
    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(
        pendingFor(svc, 'rt-1')?.size ?? 0,
        0,
        'reappearance must prune the pending entry — orphan misses must be consecutive'
    )
    assert.equal(
        stoppedUpdates(db).length,
        0,
        'an agent that reappears must never receive a stopped write'
    )
})

// Scenario 4b: heal is instant and unconfirmed (kill slow, heal fast) —
// the recovery path for staging's poisoned rows needs no second observation
test('poisoned stopped row flips back to running on the FIRST live match', async () => {
    const db = makeDb([
        fakeDbAgent({
            status: 'stopped',
            failureReason: 'not present in runtime'
        })
    ])
    const registry = {
        get: () => ({
            listAgents: async () => [liveAgent()]
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)

    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(db.updates.length, 1, 'the live match must update the row')
    assert.equal(
        db.updates[0].set.status,
        'running',
        'heal is instant and unconfirmed (kill slow, heal fast) — first live match flips status back'
    )
    assert.equal(
        db.updates[0].set.failureReason,
        null,
        'healing must clear the poisoned failureReason'
    )
})

// Scenario 5: explicit runtime stop makes per-agent miss evidence meaningless
test('reconciling a stopped runtime clears its pending orphan entries', async () => {
    const db = makeDb([fakeDbAgent()])
    const registry = {
        get: () => {
            throw new Error('stopped runtime must not query the adapter')
        }
    }
    const svc = new AgentReconcileService(db as never, registry as never)
    svc['pendingOrphans'].set(
        'rt-1',
        new Map([['agent-1', Date.now() - 61_000]])
    )

    await svc.reconcileRuntime(fakeRuntime({ status: 'stopped' }) as never)

    assert.equal(
        svc['pendingOrphans'].has('rt-1'),
        false,
        'explicit runtime stop makes per-agent miss evidence meaningless — pending entries must be cleared'
    )
})
