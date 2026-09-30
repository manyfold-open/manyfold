import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'
import {
    contextOf,
    fakeRuntimeContext,
    hostRow,
    k8sHostRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

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

// Presence is never mirrored into agent rows (ADR-0037): a coding-framework
// runtime has nothing to reconcile, so the pass touches no table at all.
for (const [host, framework] of [
    [spritesHostRow(), 'claude-code'],
    [k8sHostRow(), 'codex'],
    [hostRow(), 'gemini-cli']
] as const) {
    test(`reconcile ${host.kind}/${framework}: no SELECT, no writes, no adapter`, async () => {
        const db = makeDb()
        const runtime = fakeRuntime({ framework, hostId: host.id })
        const svc = new AgentReconcileService(
            db as never,
            throwingRegistry as never,
            fakeRuntimeContext(contextOf({ runtime: runtime as never, host })) as never
        )

        await svc.reconcileRuntime(runtime as never)

        assert.equal(
            db.counters.selects,
            0,
            'fast path must not re-read the agents table'
        )
        assert.equal(db.counters.inserts, 0, 'fast path never inserts')
        assert.equal(db.counters.updates, 0, 'fast path never writes')
        assert.deepEqual(db.updates, [])
    })
}
