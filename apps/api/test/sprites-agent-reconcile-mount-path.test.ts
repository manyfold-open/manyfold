import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'
import { readJsonbMergePatch } from './jsonb-merge'

const PRIMARY_WS = '/home/sprite/.nca/workspaces/agent-1'
const SECONDARY_WS = '/home/sprite/.nca/workspaces/agent-2'

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
    mountPath: PRIMARY_WS,
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
    workspacePath: PRIMARY_WS,
    mountPath: PRIMARY_WS,
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
    const updates: Array<{ set: Record<string, unknown>; agentId: string }> = []
    return {
        updates,
        select: () => ({
            from: () => ({
                where: () =>
                    Object.assign(Promise.resolve(rows), {
                        limit: async (n: number) => rows.slice(0, n)
                    })
            })
        }),
        update: () => ({
            set: (s: Record<string, unknown>) => ({
                where: async (_w: unknown) => {
                    updates.push({ set: s, agentId: 'captured' })
                }
            })
        }),
        insert: () => ({
            values: async () => {}
        })
    }
}

// Service framework on sprites: the matched UPDATE still runs there (coding
// frameworks take the DB-backed fast path and never rewrite rows, #516).
test('reconcile UPDATE preserves secondary agent mountPath for sprites runtime', async () => {
    const primary = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-1',
        framework: 'hermes',
        spriteStatus: 'running'
    })
    const secondary = fakeDbAgent({
        id: 'agent-2',
        internalId: 'agent-2',
        framework: 'hermes',
        name: 'a2',
        workspacePath: SECONDARY_WS,
        mountPath: SECONDARY_WS,
        createdAt: new Date('2026-04-15')
    })
    const db = makeDb([primary, secondary])

    const registry = {
        get: () => ({
            listAgents: async () => [
                {
                    id: 'agent-1',
                    name: 'a1',
                    workspace: PRIMARY_WS,
                    model: null,
                    extras: {}
                },
                {
                    id: 'agent-2',
                    name: 'a2',
                    workspace: SECONDARY_WS,
                    model: null,
                    extras: {}
                }
            ]
        })
    }

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(fakeRuntime({ framework: 'hermes' }) as never)

    const primaryUpdate = db.updates[0]
    const secondaryUpdate = db.updates[1]

    assert.ok(primaryUpdate, 'primary agent should be updated')
    assert.equal(
        primaryUpdate.set.mountPath,
        PRIMARY_WS,
        'primary mountPath should be its own workspace'
    )

    assert.ok(secondaryUpdate, 'secondary agent should be updated')
    assert.equal(
        secondaryUpdate.set.mountPath,
        SECONDARY_WS,
        'secondary mountPath must NOT be clobbered with primary workspace'
    )
    assert.notEqual(
        secondaryUpdate.set.mountPath,
        PRIMARY_WS,
        'secondary mountPath must differ from primary workspace'
    )
})

test('reconcile UPDATE preserves stored model config extras', async () => {
    const row = fakeDbAgent({
        framework: 'hermes',
        spriteStatus: 'running',
        extras: {
            modelConfig: {
                source: 'platform',
                claudeCode: {
                    effort: 'medium',
                    modelMap: {
                        sonnet: 'claude-sonnet-4-6'
                    }
                }
            },
            modelProviderModels: {
                provider: 'anthropic',
                baseUrl: 'https://example.test',
                models: ['claude-sonnet-4-6'],
                testedAt: '2026-05-11T08:46:00.000Z',
                source: 'saved-provider'
            },
            workspaceManaged: true
        }
    })
    const db = makeDb([row])

    const registry = {
        get: () => ({
            listAgents: async () => [
                {
                    id: 'agent-1',
                    name: 'a1',
                    workspace: PRIMARY_WS,
                    model: 'sonnet',
                    extras: { spriteId: 'sp-2' }
                }
            ]
        })
    }

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(
        fakeRuntime({ framework: 'hermes', spriteId: 'sp-2' }) as never
    )

    const update = db.updates[0]
    assert.ok(update, 'agent should be updated')
    // Reconcile writes extras as an atomic JSONB merge of ONLY the keys it owns
    // (live framework extras + workspaceManaged). It no longer carries
    // modelConfig / modelProviderModels, so a stale reconcile pass cannot clobber
    // user-owned extras — Postgres `||` preserves them. End-to-end preservation is
    // proven in agent-extras-merge.pg.test.ts.
    assert.deepEqual(readJsonbMergePatch(update.set.extras), {
        spriteId: 'sp-2',
        workspaceManaged: true
    })
})

test('reconcile UPDATE for k8s runtime uses shared runtime.mountPath for all agents', async () => {
    const K8S_MOUNT = '/mnt/shared'
    const primary = fakeDbAgent({
        id: 'agent-1',
        internalId: 'agent-1',
        framework: 'narranexus',
        runtime: 'k8s',
        mountPath: K8S_MOUNT,
        workspacePath: K8S_MOUNT
    })
    const secondary = fakeDbAgent({
        id: 'agent-2',
        internalId: 'agent-2',
        framework: 'narranexus',
        runtime: 'k8s',
        mountPath: K8S_MOUNT,
        workspacePath: K8S_MOUNT
    })
    const db = makeDb([primary, secondary])

    const registry = {
        get: () => ({
            listAgents: async () => [
                {
                    id: 'agent-1',
                    name: 'a1',
                    workspace: null,
                    model: null,
                    extras: {}
                },
                {
                    id: 'agent-2',
                    name: 'a2',
                    workspace: null,
                    model: null,
                    extras: {}
                }
            ]
        })
    }

    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(
        fakeRuntime({
            framework: 'narranexus',
            kind: 'k8s',
            mountPath: K8S_MOUNT
        }) as never
    )

    for (const upd of db.updates) {
        assert.equal(
            upd.set.mountPath,
            K8S_MOUNT,
            'k8s agents should all get the shared runtime mountPath'
        )
    }
})
