import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'

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
    mountPath: '/home/sprite/.nca/workspaces/agent-1',
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

const fakeAgent = (over: Record<string, unknown> = {}) => ({
    id: 'agent-1',
    userId: 'u-1',
    runtimeId: 'rt-1',
    framework: 'claude-code',
    runtime: 'sprites',
    name: 'a1',
    internalId: 'agent-1',
    status: 'running',
    workspacePath: '/home/sprite/.nca/workspaces/agent-1',
    mountPath: '/home/sprite/.nca/workspaces/agent-1',
    spriteName: 'nca-user-abc-main',
    spriteId: 'sp-1',
    accountId: 'acc-1',
    fileRoots: [],
    extras: {},
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    ...over
})

const makeFakeDb = (rows: ReturnType<typeof fakeAgent>[]) => {
    const updates: Array<{
        table: string
        set: Record<string, unknown>
        where: string
    }> = []
    const deletes: Array<{ table: string; where: string }> = []
    return {
        rows,
        updates,
        deletes,
        select: () => ({
            from: (_table: { _: { name: string } } | unknown) => ({
                where: (_w: unknown) => ({
                    limit: async (_n: number) => rows.slice(0, 1),
                    orderBy: () => ({
                        limit: async (_n: number) => {
                            const candidates = rows.slice(1)
                            const sorted = [...candidates].sort(
                                (a, b) =>
                                    a.createdAt.getTime() -
                                    b.createdAt.getTime()
                            )
                            return sorted.slice(0, 1)
                        }
                    })
                }),
                limit: async (_n: number) => rows.slice(0, 1)
            })
        }),
        update: (_table: unknown) => ({
            set: (s: Record<string, unknown>) => ({
                where: async (_w: unknown) => {
                    updates.push({
                        table: 'agent_runtimes',
                        set: s,
                        where: 'eq'
                    })
                }
            })
        }),
        delete: (_table: unknown) => ({
            where: async (_w: unknown) => {
                deletes.push({ table: 'agents', where: 'eq' })
            }
        }),
        insert: (_table: unknown) => ({
            values: (_v: unknown) => ({
                returning: async () => []
            })
        })
    }
}

test('delete primary with secondary present promotes oldest secondary then deletes old primary', async () => {
    const primary = fakeAgent({
        id: 'agent-1',
        createdAt: new Date('2026-04-01')
    })
    const secondary = fakeAgent({
        id: 'agent-2',
        name: 'a2',
        internalId: 'agent-2',
        workspacePath: '/home/sprite/.nca/workspaces/agent-2',
        mountPath: '/home/sprite/.nca/workspaces/agent-2',
        createdAt: new Date('2026-04-15')
    })
    const db = makeFakeDb([primary, secondary])

    let detachedAgentId: string | null = null
    const adapterRegistry = {
        get: () => ({
            removeAgent: async (ctx: { agent: { id: string } }) => {
                detachedAgentId = ctx.agent.id
            }
        })
    }
    const runtimes = {
        findById: async (_id: string) => fakeRuntime()
    }
    const k8sOrchestrator = { deleteNonPrimary: async () => {} }

    const svc = new AgentOrchestratorService(
        db as never, // 1: DRIZZLE
        {} as never, // 2: agentsService
        {} as never, // 3: accounts
        {} as never, // 4: crypto
        runtimes as never, // 5: runtimes
        {} as never, // 6: spritesProvisioner
        {} as never, // 7: externalProvisioner
        k8sOrchestrator as never, // 8: k8sOrchestrator
        {} as never, // 9: attach
        {} as never, // 10: credentialsResolver
        {} as never, // 11: backups
        adapterRegistry as never, // 12: adapterRegistry
        {} as never, // 13: modelConfig
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    await svc.delete('agent-1', 'u-1', false)

    assert.equal(detachedAgentId, 'agent-1', 'old primary should be detached')
    assert.ok(
        db.updates.some(
            (u) =>
                u.table === 'agent_runtimes' &&
                u.set.primaryAgentId === 'agent-2'
        ),
        'agent_runtimes.primaryAgentId should be promoted to agent-2'
    )
    assert.ok(
        db.deletes.some((d) => d.table === 'agents'),
        'old primary row should be deleted'
    )
})

test('delete primary with no secondary tears down the runtime, preserving the sandbox', async () => {
    // Deleting the last sprite agent no longer 403s (PRIMARY_AGENT_DELETE_RUNTIME):
    // it tears the runtime down with the default (preserve) teardown so the now-
    // empty sandbox VM survives for reuse / the 7-day reaper.
    const primary = fakeAgent({ id: 'agent-1' })
    const db = makeFakeDb([primary])
    const adapterRegistry = { get: () => ({ removeAgent: async () => {} }) }
    const runtimes = { findById: async () => fakeRuntime() }
    let torndown: { id: string; opts: unknown } | null = null
    const spritesProvisioner = {
        teardownRuntime: async (
            runtime: { id: string },
            opts?: unknown
        ): Promise<void> => {
            torndown = { id: runtime.id, opts }
        }
    }
    const svc = new AgentOrchestratorService(
        db as never,
        {} as never,
        {} as never,
        {} as never,
        runtimes as never,
        spritesProvisioner as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        adapterRegistry as never,
        {} as never,
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    await svc.delete('agent-1', 'u-1', false)

    assert.ok(torndown, 'teardownRuntime should run for the last agent')
    assert.equal(
        (torndown as { opts: unknown } | null)?.opts,
        undefined,
        'default (preserve) teardown — empty sandbox kept, not eagerly deleted'
    )
})

test('delete secondary detaches and removes the row, leaves runtime alone', async () => {
    const primary = fakeAgent({ id: 'agent-1' })
    const secondary = fakeAgent({
        id: 'agent-2',
        internalId: 'agent-2',
        createdAt: new Date('2026-04-15')
    })
    // The select-by-id call fetches agent-2 first (the one being deleted).
    const db = makeFakeDb([secondary, primary])
    let detachedAgentId: string | null = null
    const adapterRegistry = {
        get: () => ({
            removeAgent: async (ctx: { agent: { id: string } }) => {
                detachedAgentId = ctx.agent.id
            }
        })
    }
    const runtimes = { findById: async () => fakeRuntime() }
    const svc = new AgentOrchestratorService(
        db as never,
        {} as never,
        {} as never,
        {} as never,
        runtimes as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        adapterRegistry as never,
        {} as never,
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    await svc.delete('agent-2', 'u-1', false)

    assert.equal(detachedAgentId, 'agent-2')
    assert.ok(
        db.deletes.some((d) => d.table === 'agents'),
        'secondary row deleted'
    )
    // runtime row not touched
})
