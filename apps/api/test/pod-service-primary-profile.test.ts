import type { NewAgent } from '@manyfold/db'
import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'
import { AgentReconcileService } from '../src/modules/agents/reconcile/agent-reconcile.service'

// A service framework's first agent on a cloud computer is its gateway's
// built-in profile (openclaw's `main`), as on a sandbox: the host's service is
// configured for that profile and every chat session binds to it. Pushing a
// profile beside it left the primary on a workspace chat never used, and once
// a config rewrite dropped the pushed profile, reconcile stopped the primary
// and adopted `main` as a second agent.

const OPENCLAW_WS = '/home/node/.openclaw/workspace'

const podRuntime = (overrides: Record<string, unknown> = {}) => ({
    id: 'art_1',
    userId: 'user-1',
    name: 'openclaw',
    framework: 'openclaw',
    kind: 'k8s',
    status: 'ready',
    currentPhase: null,
    hostId: 'pdh_1',
    namespace: 'nca-user-1',
    spriteName: null,
    spriteId: null,
    accountId: null,
    daemonId: null,
    clusterId: null,
    ingressHost: 'openclaw-host-pdh-1.example.test',
    mountPath: '/home/node/.openclaw',
    homeDir: null,
    primaryAgentId: null,
    ...overrides
})

const tableName = (table: unknown): string =>
    String(
        (table as Record<string, unknown> | undefined)?.[
            Symbol.for('drizzle:Name') as unknown as string
        ] ?? ''
    )

const attachRig = (runtimeRow: ReturnType<typeof podRuntime>) => {
    const inserted: NewAgent[] = []
    const added: Array<{ internalId: string }> = []
    const db = {
        select: () => ({
            from: (table: unknown) => ({
                where: () => ({
                    limit: async () =>
                        tableName(table) === 'agent_runtimes'
                            ? [runtimeRow]
                            : [{ id: null }]
                })
            })
        }),
        insert: () => ({
            values: (row: NewAgent) => {
                inserted.push(row)
                return {
                    returning: async () => [
                        { ...row, createdAt: new Date(), updatedAt: new Date() }
                    ]
                }
            }
        }),
        update: () => ({ set: () => ({ where: async () => {} }) })
    }
    const adapter = {
        listAgents: async () => [
            {
                id: 'main',
                name: 'main',
                workspace: OPENCLAW_WS,
                model: 'primary/model-x',
                extras: { identity: null }
            }
        ],
        addAgent: async (input: { internalId: string }) => {
            added.push(input)
            return {
                internalId: input.internalId,
                workspace: `/home/node/.openclaw/workspace-${input.internalId}`,
                model: null,
                extras: {}
            }
        }
    }
    const attach = new RuntimeAgentAttachService(
        db as never,
        { get: () => adapter } as never,
        { touchAfterWrite: () => {} } as never,
        { assertManagedChannelBindable: async () => {} } as never,
        { installDefaults: async () => {} } as never
    )
    return { attach, inserted, added }
}

test('the first openclaw agent on a cloud computer is its gateway\'s main profile', async () => {
    const rig = attachRig(podRuntime())
    const summary = await rig.attach.attach({
        runtime: podRuntime() as never,
        name: 'first'
    })
    assert.deepEqual(rig.added, [], 'nothing is pushed into the gateway')
    const [row] = rig.inserted
    assert.equal(row.internalId, summary.id, 'the row keeps the Manyfold id')
    assert.equal(row.workspacePath, OPENCLAW_WS)
    assert.equal(row.model, 'primary/model-x')
})

test('an agent added after the first gets a profile of its own', async () => {
    const runtime = podRuntime({ primaryAgentId: 'agt_first' })
    const rig = attachRig(runtime)
    const summary = await rig.attach.attach({
        runtime: runtime as never,
        name: 'second'
    })
    assert.equal(rig.added.length, 1)
    assert.equal(rig.added[0].internalId, summary.id.replace(/_/g, '-'))
})

test('a workspace for the first agent is refused, not dropped', async () => {
    const rig = attachRig(podRuntime())
    await assert.rejects(
        rig.attach.attach({
            runtime: podRuntime() as never,
            name: 'first',
            workspace: '/home/node/project'
        }),
        /gateway's own/
    )
    assert.deepEqual(rig.inserted, [])
})

test('reconcile knows a cloud computer\'s main profile as its primary agent', async () => {
    const primary = {
        id: 'agt_first',
        userId: 'user-1',
        runtimeId: 'art_1',
        framework: 'openclaw',
        runtime: 'k8s',
        name: 'Research',
        internalId: 'agt_first',
        status: 'running',
        failureReason: null,
        spriteStatus: null,
        workspacePath: OPENCLAW_WS,
        mountPath: '/home/node/.openclaw',
        fileRoots: [],
        extras: {},
        model: null
    }
    const inserts: unknown[] = []
    const updates: Array<Record<string, unknown>> = []
    const runtime = podRuntime({ primaryAgentId: 'agt_first' })
    // The runtime is re-read with a limit; the agents are listed without.
    const db = {
        select: () => ({
            from: (table: unknown) => ({
                where: () =>
                    tableName(table) === 'agent_runtimes'
                        ? { limit: async () => [runtime] }
                        : Promise.resolve([primary])
            })
        }),
        update: () => ({
            set: (set: Record<string, unknown>) => ({
                where: async () => {
                    updates.push(set)
                }
            })
        }),
        insert: () => ({
            values: async (row: unknown) => {
                inserts.push(row)
            }
        })
    }
    const registry = {
        get: () => ({
            listAgents: async () => [
                {
                    id: 'main',
                    name: 'main',
                    workspace: OPENCLAW_WS,
                    model: 'primary/model-x',
                    extras: {}
                }
            ]
        })
    }
    const svc = new AgentReconcileService(db as never, registry as never)
    await svc.reconcileRuntime(runtime as never, { verifiedByReport: true })
    assert.equal(inserts.length, 0, 'main is not adopted as a second agent')
    assert.equal(updates.length, 1)
    assert.equal(updates[0].status, 'running')
    assert.equal('name' in updates[0], false, 'the primary keeps its name')
})
