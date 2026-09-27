import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcilerFor } from './helpers/reconcile-fixture'
import { k8sHostRow } from './helpers/runtime-context-fixture'

const WS = '/home/sprite/.nca/workspaces/agent-1'

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
    framework: 'claude-code',
    runtime: 'sprites',
    name: 'a1',
    internalId: 'agent-1',
    status: 'ready',
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

// Scenario 1: coding-framework sprites runtime — listAgents reads the agents
// table itself, so reconcile takes the DB-backed fast path (#516): it never
// consults the adapter and can never INSERT, no matter how corrupt the rows
// are (id/internalId mismatch included).
test('reconcile sprites: no INSERT when live id has no matching internalId (legacy duplicate state)', async () => {
    // Row has id='agent-1' but internalId='agent-old' (legacy mismatch)
    const staleDuplicate = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-old'
    })
    const db = makeDb([staleDuplicate])

    const registry = {
        get: () => {
            throw new Error('coding-framework reconcile must not list agents')
        }
    }

    const svc = reconcilerFor(db, registry)
    await svc.reconcileRuntime(fakeRuntime() as never)

    assert.equal(
        db.inserts.length,
        0,
        'must not INSERT for sprites when internalId mismatch'
    )
})

// Scenario 1b: k8s/claude-code runtime — same fast path, same invariant
test('reconcile k8s/claude-code: no INSERT when live id has no matching internalId', async () => {
    const staleDuplicate = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-old'
    })
    const db = makeDb([staleDuplicate])

    const registry = {
        get: () => {
            throw new Error('coding-framework reconcile must not list agents')
        }
    }

    const k8sRuntime = fakeRuntime({ framework: 'claude-code' })
    const svc = reconcilerFor(db, registry, { host: k8sHostRow() })

    await svc.reconcileRuntime(k8sRuntime as never)

    assert.equal(
        db.inserts.length,
        0,
        'must not INSERT for k8s coding-agent when internalId mismatch'
    )
})

// Scenario 1c: a service framework on sprites lists the FRAMEWORK's own state,
// not the agents table, so an unknown live id is a real agent the user created
// outside Manyfold (e.g. in the framework's own UI) — not a corrupt row. It
// must be adopted: managed automations and channels are keyed off
// agents.internalId, so a job/binding owned by an unadopted agent can never
// mirror.
test('reconcile sprites/service framework: adopts a framework-native live agent', async () => {
    // awake sprite: a service-framework listing is skipped outright while the
    // VM sleeps, so the adoption path only exists on a running sprite
    const primary = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-1',
        framework: 'hermes'
    })
    const db = makeDb([primary])

    const registry = {
        get: () => ({
            listAgents: async () => [
                {
                    id: 'agent-1',
                    name: 'a1',
                    workspace: WS,
                    model: null,
                    extras: {}
                },
                {
                    id: 'native_1',
                    name: 'NativeGuard',
                    workspace: '/home/sprite/.hermes/workspaces/native',
                    model: null,
                    extras: {}
                }
            ]
        })
    }

    const svc = reconcilerFor(db, registry)
    await svc.reconcileRuntime(fakeRuntime({ framework: 'hermes' }) as never)

    assert.equal(db.inserts.length, 1, 'the native agent must be adopted')
    assert.equal(db.inserts[0].internalId, 'native_1')
    assert.equal(db.inserts[0].name, 'NativeGuard')
    assert.equal(db.inserts[0].runtimeId, 'rt-1')
    assert.equal(db.inserts[0].framework, 'hermes')
})

// Scenario 2: clean state — internalId === id
// listAgents returns that id (service framework: the matched-UPDATE path)
// Expected: no INSERT, existing row is updated (lastReconciledAt moves forward)
test('reconcile sprites: clean state — UPDATE existing row, no INSERT', async () => {
    const cleanRow = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-1',
        framework: 'hermes',
        lastReconciledAt: null
    })
    const db = makeDb([cleanRow])

    const registry = {
        get: () => ({
            listAgents: async () => [
                {
                    id: 'agent-1',
                    name: 'a1',
                    workspace: WS,
                    model: null,
                    extras: {}
                }
            ]
        })
    }

    const svc = reconcilerFor(db, registry)
    await svc.reconcileRuntime(fakeRuntime({ framework: 'hermes' }) as never)

    assert.equal(
        db.inserts.length,
        0,
        'must not INSERT when row already has matching internalId'
    )
    assert.equal(db.updates.length, 1, 'existing row should be updated')
    assert.ok(
        db.updates[0].set.lastReconciledAt instanceof Date,
        'lastReconciledAt should be updated to a Date'
    )
})

// A runtime that is not ready has nothing to list; presence is never
// mirrored into its agents (ADR-0037), so nothing is written either.
test('reconcile of a runtime that is not ready neither lists nor writes', async () => {
    const row = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-1',
        status: 'ready'
    })
    const db = makeDb([row])
    const registry = {
        get: () => {
            throw new Error('a runtime that is not ready must not query the adapter')
        }
    }

    const svc = reconcilerFor(db, registry)
    await svc.reconcileRuntime(fakeRuntime({ status: 'failed' }) as never)

    assert.equal(db.inserts.length, 0)
    assert.equal(db.updates.length, 0)
})
