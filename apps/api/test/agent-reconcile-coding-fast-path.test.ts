import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'

// #516: coding-framework adapters (claude-code/codex/gemini-cli) implement
// listAgents as a SELECT of the agents table itself, so the generic reconcile
// was a circular DB copy — one redundant SELECT via reconcile, a second via
// the adapter, then a rewrite of every row with fresh timestamps, per runtime,
// per touch. The fast path replaces all of that with a single guarded UPDATE
// that only heals false-stopped healthy rows.

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
    const updates: Array<{ set: Record<string, unknown> }> = []
    return {
        counters,
        updates,
        select: () => {
            counters.selects += 1
            return {
                from: () => ({
                    where: async () => []
                })
            }
        },
        update: () => {
            counters.updates += 1
            return {
                set: (s: Record<string, unknown>) => ({
                    where: async () => {
                        updates.push({ set: s })
                    }
                })
            }
        },
        insert: () => {
            counters.inserts += 1
            return { values: async () => {} }
        }
    }
}

const throwingRegistry = {
    get: () => {
        throw new Error('coding-framework reconcile must not use the adapter')
    }
}

for (const [kind, framework] of [
    ['sprites', 'claude-code'],
    ['k8s', 'codex'],
    ['daemon', 'gemini-cli']
] as const) {
    test(`reconcile ${kind}/${framework}: single heal UPDATE, no SELECT, no adapter`, async () => {
        const db = makeDb()
        const svc = new AgentReconcileService(
            db as never,
            throwingRegistry as never
        )

        await svc.reconcileRuntime(fakeRuntime({ kind, framework }) as never)

        assert.equal(
            db.counters.selects,
            0,
            'fast path must not re-read the agents table'
        )
        assert.equal(db.counters.inserts, 0, 'fast path never inserts')
        assert.equal(
            db.counters.updates,
            1,
            'exactly one guarded heal statement'
        )
        assert.equal(db.updates[0].set.status, 'running')
        assert.equal(db.updates[0].set.failureReason, null)
        assert.ok(db.updates[0].set.lastReconciledAt instanceof Date)
    })
}
