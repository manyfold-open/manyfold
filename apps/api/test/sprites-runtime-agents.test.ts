import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentRuntimeRow, Agent } from '@manyfold/db'
import { ClaudeCodeAgentAdapter } from '../src/modules/agents/adapters/claude-code-agent.adapter'
import type { SpritesAgentAttacher } from '../src/modules/agents/adapters/sprites-agent-attacher'
import type { K8sAgentAttacher } from '../src/modules/agents/adapters/k8s-agent-attacher'

const baseRuntime = (
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
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
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as unknown as AgentRuntimeRow

const noopSpritesAttacher = {
    attach: async () => ({ workspacePath: '', internalId: '' }),
    detach: async () => {}
} as unknown as SpritesAgentAttacher

const noopK8sAttacher = {
    attach: async () => ({ workspacePath: '', internalId: '' }),
    detach: async () => {}
} as unknown as K8sAgentAttacher

test('ClaudeCodeAgentAdapter.addAgent on sprites attaches workspace and returns id', async () => {
    const attacher = {
        attach: async (args: {
            runtime: AgentRuntimeRow
            agentId: string
        }) => ({
            workspacePath: `/home/sprite/.nca/workspaces/${args.agentId}`,
            internalId: args.agentId
        }),
        detach: async () => {}
    } as unknown as SpritesAgentAttacher
    const fakeDb = {
        select: () => ({
            from: () => ({
                where: async () => []
            })
        })
    }
    const adapter = new ClaudeCodeAgentAdapter(
        fakeDb as never,
        attacher,
        noopK8sAttacher,
        {} as never
    )

    const result = await adapter.addAgent({
        runtime: baseRuntime(),
        primaryAgentId: 'agent-1',
        agentId: 'agent-2',
        internalId: 'agent-2',
        name: 'second',
        model: 'claude-sonnet-4-6'
    })

    assert.equal(result.internalId, 'agent-2')
    assert.equal(result.workspace, '/home/sprite/.nca/workspaces/agent-2')
    assert.equal(result.model, 'claude-sonnet-4-6')
})

test('ClaudeCodeAgentAdapter.addAgent on k8s routes to K8sAgentAttacher', async () => {
    const k8sCalls: Array<{ agentId: string; primaryAgentId: string | null }> =
        []
    const k8sAttacher = {
        attach: async (args: {
            runtime: AgentRuntimeRow
            agentId: string
            primaryAgentId: string | null
        }) => {
            k8sCalls.push({
                agentId: args.agentId,
                primaryAgentId: args.primaryAgentId
            })
            return {
                workspacePath: `/home/node/.nca/workspaces/${args.agentId}`,
                internalId: args.agentId
            }
        },
        detach: async () => {}
    } as unknown as K8sAgentAttacher
    const adapter = new ClaudeCodeAgentAdapter(
        {} as never,
        noopSpritesAttacher,
        k8sAttacher,
        {} as never
    )

    const result = await adapter.addAgent({
        runtime: baseRuntime({ kind: 'k8s', namespace: 'nca-dev' }),
        primaryAgentId: 'agent-1',
        agentId: 'agent-2',
        internalId: 'agent-2',
        name: 'second'
    })

    assert.equal(k8sCalls.length, 1)
    assert.equal(k8sCalls[0].agentId, 'agent-2')
    assert.equal(k8sCalls[0].primaryAgentId, 'agent-1')
    assert.equal(result.internalId, 'agent-2')
    assert.equal(result.workspace, '/home/node/.nca/workspaces/agent-2')
})

test('ClaudeCodeAgentAdapter.listAgents returns all rows for runtime (sprites or k8s)', async () => {
    const rows = [
        {
            id: 'agent-1',
            name: 'main',
            workspacePath: '/home/sprite/.nca/workspaces/agent-1',
            model: null
        },
        {
            id: 'agent-2',
            name: 'second',
            workspacePath: '/home/sprite/.nca/workspaces/agent-2',
            model: 'claude-sonnet-4-6'
        }
    ]
    const fakeDb = {
        select: () => ({
            from: () => ({
                where: async () => rows
            })
        })
    }
    const adapter = new ClaudeCodeAgentAdapter(
        fakeDb as never,
        noopSpritesAttacher,
        noopK8sAttacher,
        {} as never
    )

    const live = await adapter.listAgents({
        runtime: baseRuntime(),
        primaryAgentId: 'agent-1'
    })

    assert.equal(live.length, 2)
    assert.equal(live[0].id, 'agent-1')
    assert.equal(live[1].id, 'agent-2')
    assert.equal(live[1].workspace, '/home/sprite/.nca/workspaces/agent-2')
    assert.equal(live[1].model, 'claude-sonnet-4-6')
})

test('ClaudeCodeAgentAdapter.removeAgent on sprites delegates to attacher.detach', async () => {
    let detached: { runtime: AgentRuntimeRow; agent: Agent } | null = null
    const attacher = {
        attach: async () => ({ workspacePath: '', internalId: '' }),
        detach: async (args: { runtime: AgentRuntimeRow; agent: Agent }) => {
            detached = args
        }
    } as unknown as SpritesAgentAttacher
    const adapter = new ClaudeCodeAgentAdapter(
        {} as never,
        attacher,
        noopK8sAttacher,
        {} as never
    )
    const agent = {
        id: 'agent-2',
        workspacePath: '/home/sprite/.nca/workspaces/agent-2'
    } as unknown as Agent

    await adapter.removeAgent({
        runtime: baseRuntime(),
        agent,
        primaryAgentId: 'agent-1'
    })

    const capturedDetached = detached as { agent: Agent } | null
    assert.equal(capturedDetached?.agent.id, 'agent-2')
})
