import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { ConflictException } from '@nestjs/common'
import {
    contextOf,
    fakeRuntimeContext,
    k8sHostRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// On a sandbox or a cloud computer a runtime goes with its last agent, and
// the framework's own agent (ADR-0040) leaves only with the runtime: while
// other agents remain it stays. Any other agent is removed in its framework,
// then its row goes. There is no primary to promote.

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
    status: 'ready',
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

// The agent on its sandbox, as the orchestrator reads it.
const contextFor = (
    db: { rows: ReturnType<typeof fakeAgent>[] },
    runtime: Record<string, unknown> = {},
    host = spritesHostRow({ id: 'rth-1', userId: 'u-1' })
) =>
    fakeRuntimeContext((id: string) => {
        const agent = db.rows.find((row) => row.id === id)
        return agent
            ? contextOf({
                  agent: agent as never,
                  runtime: fakeRuntime(runtime) as never,
                  host
              })
            : null
    })

const makeFakeDb = (rows: ReturnType<typeof fakeAgent>[]) => {
    const updates: Array<Record<string, unknown>> = []
    const deletes: string[] = []
    return {
        rows,
        updates,
        deletes,
        // The only read is the count of the other agents on the runtime.
        select: () => ({
            from: () => ({
                where: async () => [{ value: rows.length - 1 }]
            })
        }),
        update: () => ({
            set: (s: Record<string, unknown>) => ({
                where: async () => {
                    updates.push(s)
                }
            })
        }),
        delete: () => ({
            where: async () => {
                deletes.push('agents')
            }
        }),
        insert: () => ({ values: async () => {} })
    }
}

const orchestrator = (
    db: ReturnType<typeof makeFakeDb>,
    opts: {
        framework?: string
        host?: ReturnType<typeof spritesHostRow>
        removed?: string[]
        spritesProvisioner?: unknown
        k8sRuntimes?: unknown
    } = {}
) => {
    const framework = opts.framework ?? 'claude-code'
    return new AgentOrchestratorService(
        db as never, // 1: DRIZZLE
        {} as never, // 2: agentsService
        contextFor(db, { framework }, opts.host) as never,
        {} as never, // 4: crypto
        { findById: async () => fakeRuntime({ framework }) } as never,
        (opts.spritesProvisioner ?? {}) as never,
        {} as never, // 7: externalProvisioner
        {
            deleteAgent: async (ctx: { agent: { internalId: string } }) => {
                opts.removed?.push(ctx.agent.internalId)
            }
        } as never,
        {} as never, // 9: attach
        {} as never, // 10: credentialsResolver
        {} as never, // 11: backups
        {
            get: () => ({
                removeAgent: async (ctx: { agent: { internalId: string } }) => {
                    opts.removed?.push(ctx.agent.internalId)
                }
            })
        } as never,
        {} as never, // 13: modelConfig
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        opts.k8sRuntimes as never
    )
}

const tearingDown = () => {
    const calls: Array<{ id: string; opts: unknown }> = []
    return {
        calls,
        teardownRuntime: async (runtime: { id: string }, opts?: unknown) => {
            calls.push({ id: runtime.id, opts })
        }
    }
}

test('deleting an agent that leaves others on the runtime removes it in the framework, then its row', async () => {
    const first = fakeAgent({ id: 'agent-1' })
    const second = fakeAgent({
        id: 'agent-2',
        internalId: 'agent-2',
        createdAt: new Date('2026-04-15')
    })
    const db = makeFakeDb([first, second])
    const removed: string[] = []
    const teardown = tearingDown()

    await orchestrator(db, { removed, spritesProvisioner: teardown }).delete(
        'agent-1',
        'u-1',
        false
    )

    assert.deepEqual(removed, ['agent-1'])
    assert.deepEqual(db.deletes, ['agents'])
    assert.deepEqual(db.updates, [], 'nothing on the runtime is rewritten')
    assert.deepEqual(teardown.calls, [])
})

test('deleting the last agent tears the runtime down, preserving the sandbox', async () => {
    const db = makeFakeDb([fakeAgent({ id: 'agent-1' })])
    const removed: string[] = []
    const teardown = tearingDown()

    await orchestrator(db, { removed, spritesProvisioner: teardown }).delete(
        'agent-1',
        'u-1',
        false
    )

    // The default (preserve) teardown — the empty sandbox is kept, not eagerly
    // deleted — naming the leaving agent, which its emptiness guard must not
    // count (it answered 409 RUNTIME_NOT_EMPTY before).
    assert.deepEqual(teardown.calls, [
        { id: 'rt-1', opts: { leavingAgentId: 'agent-1' } }
    ])
    assert.deepEqual(removed, [])
})

// The framework never deletes its own agent (Hermes refuses "Cannot delete the
// default profile"), so on its own it could only ever leave a row behind.
test("the framework's own agent stays while other agents remain", async () => {
    const builtIn = fakeAgent({
        id: 'agent-1',
        framework: 'hermes',
        name: 'default',
        internalId: 'default'
    })
    const other = fakeAgent({
        id: 'agent-2',
        framework: 'hermes',
        internalId: 'agent_2',
        createdAt: new Date('2026-04-15')
    })
    const db = makeFakeDb([builtIn, other])
    const removed: string[] = []

    await assert.rejects(
        orchestrator(db, { framework: 'hermes', removed }).delete(
            'agent-1',
            'u-1',
            false
        ),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'BUILT_IN_AGENT_NOT_LAST'
    )
    assert.deepEqual(removed, [])
    assert.deepEqual(db.deletes, [])
})

test("the framework's own agent, when last, leaves with its runtime", async () => {
    const db = makeFakeDb([
        fakeAgent({
            id: 'agent-1',
            framework: 'hermes',
            name: 'default',
            internalId: 'default'
        })
    ])
    const removed: string[] = []
    const teardown = tearingDown()

    await orchestrator(db, {
        framework: 'hermes',
        removed,
        spritesProvisioner: teardown
    }).delete('agent-1', 'u-1', false)

    assert.deepEqual(teardown.calls, [
        { id: 'rt-1', opts: { leavingAgentId: 'agent-1' } }
    ])
    assert.deepEqual(removed, [], 'hermes is never asked to delete default')
})

test('a Hermes agent with a profile of its own removes that profile', async () => {
    const builtIn = fakeAgent({
        id: 'agent-1',
        framework: 'hermes',
        internalId: 'default'
    })
    const other = fakeAgent({
        id: 'agent-2',
        framework: 'hermes',
        internalId: 'agent_2',
        createdAt: new Date('2026-04-15')
    })
    const db = makeFakeDb([other, builtIn])
    const removed: string[] = []

    await orchestrator(db, { framework: 'hermes', removed }).delete(
        'agent-2',
        'u-1',
        false
    )

    assert.deepEqual(removed, ['agent_2'])
    assert.deepEqual(db.deletes, ['agents'])
})

test('the last agent on a cloud computer tears its runtime down', async () => {
    const db = makeFakeDb([
        fakeAgent({ id: 'agent-1', framework: 'openclaw', internalId: 'main' })
    ])
    const k8sRuntimes = tearingDown()

    await orchestrator(db, {
        framework: 'openclaw',
        host: k8sHostRow({ id: 'rth-1', userId: 'u-1' }) as never,
        k8sRuntimes
    }).delete('agent-1', 'u-1', false)

    assert.deepEqual(k8sRuntimes.calls, [
        { id: 'rt-1', opts: { leavingAgentId: 'agent-1' } }
    ])
})
