import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'

// #516: touchRuntime's throttle and in-flight map are process-local, so N API
// replicas each reconciled the same runtime. A per-runtime service-lease claim
// makes the reconcile run on at most one replica at a time; losing the claim
// is a silent skip, not a failure.

const fakeRuntime = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    userId: 'u-1',
    name: 'main',
    framework: 'claude-code',
    kind: 'sprites',
    status: 'ready',
    accountId: 'acc-1',
    spriteName: 'nca-user-abc-main',
    spriteId: 'sp-1',
    primaryAgentId: 'agent-1',
    mountPath: '/workspace',
    namespace: null,
    ingressHost: null,
    clusterId: null,
    currentPhase: null,
    failureReason: null,
    startedAt: new Date(),
    lastBootstrappedAt: new Date(),
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const makeDb = () => {
    const counters = { selects: 0, updates: 0, inserts: 0 }
    return {
        counters,
        select: () => {
            counters.selects += 1
            return { from: () => ({ where: async () => [] }) }
        },
        update: () => {
            counters.updates += 1
            return { set: () => ({ where: async () => {} }) }
        },
        insert: () => {
            counters.inserts += 1
            return { values: async () => {} }
        }
    }
}

const makeLeases = (granted: boolean) => {
    const acquires: Array<{ name: string; holderId: string }> = []
    const releases: Array<{ name: string; holderId: string }> = []
    return {
        acquires,
        releases,
        tryAcquireOrRenew: async (name: string, holderId: string) => {
            acquires.push({ name, holderId })
            return granted
        },
        release: async (name: string, holderId: string) => {
            releases.push({ name, holderId })
        }
    }
}

const registry = {
    get: () => {
        throw new Error('claim tests use coding runtimes; adapter is off-path')
    }
}

const awaitTouch = async (svc: AgentReconcileService, runtimeId: string) => {
    const p = svc['inflight'].get(runtimeId)
    assert.ok(p, 'touchRuntime should have started a reconcile')
    await p
}

test('touchRuntime reconciles under a per-runtime claim and releases it', async () => {
    const db = makeDb()
    const leases = makeLeases(true)
    const svc = new AgentReconcileService(
        db as never,
        registry as never,
        leases as never
    )

    svc.touchRuntime(fakeRuntime() as never)
    await awaitTouch(svc, 'rt-1')

    assert.equal(leases.acquires.length, 1)
    assert.equal(leases.acquires[0].name, 'agent-reconcile:rt-1')
    assert.equal(db.counters.updates, 1, 'reconcile ran under the claim')
    assert.equal(leases.releases.length, 1, 'claim released after the run')
    assert.equal(leases.releases[0].name, 'agent-reconcile:rt-1')
    assert.equal(
        leases.releases[0].holderId,
        leases.acquires[0].holderId,
        'released by the same holder that acquired'
    )
})

test('touchRuntime skips silently when another replica holds the claim', async () => {
    const db = makeDb()
    const leases = makeLeases(false)
    const svc = new AgentReconcileService(
        db as never,
        registry as never,
        leases as never
    )

    svc.touchRuntime(fakeRuntime() as never)
    await awaitTouch(svc, 'rt-1')

    assert.equal(leases.acquires.length, 1)
    assert.equal(db.counters.selects, 0, 'no reconcile work without the claim')
    assert.equal(db.counters.updates, 0)
    assert.equal(db.counters.inserts, 0)
    assert.equal(leases.releases.length, 0, 'nothing to release')
    assert.equal(
        svc['failures'].has('rt-1'),
        false,
        'losing the claim is not a failure'
    )
})

test('touchRuntime ignores stopped runtimes entirely', async () => {
    const db = makeDb()
    const leases = makeLeases(true)
    const svc = new AgentReconcileService(
        db as never,
        registry as never,
        leases as never
    )

    svc.touchRuntime(fakeRuntime({ status: 'stopped' }) as never)

    assert.equal(
        svc['inflight'].has('rt-1'),
        false,
        'no reconcile scheduled for a stopped runtime'
    )
    assert.equal(leases.acquires.length, 0)
    assert.equal(db.counters.updates, 0)
})
