import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'

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
    status: 'running',
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

    const svc = new AgentReconcileService(db as never, registry as never)
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

    const k8sRuntime = fakeRuntime({
        kind: 'k8s',
        framework: 'claude-code',
        namespace: 'nca-dev'
    })
    const svc = new AgentReconcileService(db as never, registry as never)

    await svc.reconcileRuntime(k8sRuntime as never)

    assert.equal(
        db.inserts.length,
        0,
        'must not INSERT for k8s coding-agent when internalId mismatch'
    )
})

// Scenario 1c: a service framework on sprites lists the FRAMEWORK's own state,
// not the agents table, so an unknown live id is a real agent the user created
// outside Manyfold (e.g. in the NarraNexus UI) — not a corrupt row. It must be
// adopted: managed automations and channels are keyed off agents.internalId, so
// a job/binding owned by an unadopted agent can never mirror (it silently never
// fires, because NEXUS_EXTERNAL_TRIGGERS already handed its clock to Manyfold).
test('reconcile sprites/narranexus: adopts a framework-native live agent', async () => {
    // awake sprite: a service-framework listing is skipped outright while the
    // VM sleeps, so the adoption path only exists on a running sprite
    const primary = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-1',
        framework: 'narranexus',
        spriteStatus: 'running'
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
                    id: 'nx_native_1',
                    name: 'NexusGuard',
                    workspace: '/home/sprite/.narranexus/data/workspaces/nx',
                    model: null,
                    extras: {}
                }
            ]
        })
    }

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(
        fakeRuntime({ framework: 'narranexus' }) as never
    )

    assert.equal(db.inserts.length, 1, 'the NX-native agent must be adopted')
    assert.equal(db.inserts[0].internalId, 'nx_native_1')
    assert.equal(db.inserts[0].name, 'NexusGuard')
    assert.equal(db.inserts[0].runtimeId, 'rt-1')
    assert.equal(db.inserts[0].framework, 'narranexus')
})

// Scenario 2: clean state — internalId === id
// listAgents returns that id (service framework: the matched-UPDATE path)
// Expected: no INSERT, existing row is updated (lastReconciledAt moves forward)
test('reconcile sprites: clean state — UPDATE existing row, no INSERT', async () => {
    const cleanRow = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-1',
        framework: 'hermes',
        spriteStatus: 'running',
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

    const svc = new AgentReconcileService(db as never, registry as never)
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

test('reconcile stopped runtime marks agents stopped without listing live agents', async () => {
    const row = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-1',
        status: 'running'
    })
    const db = makeDb([row])
    const registry = {
        get: () => {
            throw new Error('stopped runtime must not query the adapter')
        }
    }

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(fakeRuntime({ status: 'stopped' }) as never)

    assert.equal(db.inserts.length, 0)
    assert.equal(db.updates.length, 1)
    assert.equal(db.updates[0].set.status, 'stopped')
    assert.ok(db.updates[0].set.lastReconciledAt instanceof Date)
})
