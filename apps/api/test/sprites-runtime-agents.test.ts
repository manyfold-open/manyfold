import test from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, RuntimeHostRow } from '@manyfold/db'
import { ClaudeCodeAgentAdapter } from '../src/modules/agents/adapters/claude-code-agent.adapter'
import type { DaemonAgentAttacher } from '../src/modules/agents/adapters/daemon-agent-attacher'
import {
    NotSupportedError,
    type RuntimeTarget
} from '../src/modules/agents/adapters/agent-adapter'
import {
    contextOf,
    k8sHostRow,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// A coding agent's workspace lives on its machine and is reached through
// the host's one daemon, whichever provider made the machine (ADR-0037 R6):
// the adapter hands every add and remove to the daemon attacher with the
// runtime's target.

const targetOn = (host: RuntimeHostRow = spritesHostRow()): RuntimeTarget =>
    contextOf({
        runtime: runtimeRow({
            id: 'rt-1',
            userId: 'u-1',
            name: 'main',
            framework: 'claude-code',
            hostId: host.id,
            mountPath: '/home/sprite/.nca/workspaces/agent-1'
        }),
        host
    })

const noopAttacher = {
    attach: async () => ({ workspacePath: '', internalId: '' }),
    detach: async () => {}
} as unknown as DaemonAgentAttacher

test('ClaudeCodeAgentAdapter.addAgent on a sandbox attaches the workspace through the host daemon', async () => {
    const attachCalls: Array<{
        hostId: string | undefined
        agentId: string
        workspace?: string
    }> = []
    const attacher = {
        attach: async (args: {
            target: RuntimeTarget
            agentId: string
            workspace?: string
        }) => {
            attachCalls.push({
                hostId: args.target.host?.id,
                agentId: args.agentId,
                workspace: args.workspace
            })
            return {
                workspacePath: `/home/sprite/.nca/workspaces/${args.agentId}`,
                internalId: args.agentId
            }
        },
        detach: async () => {}
    } as unknown as DaemonAgentAttacher
    const adapter = new ClaudeCodeAgentAdapter({} as never, attacher)

    const result = await adapter.addAgent({
        ...targetOn(),
        agentId: 'agent-2',
        internalId: 'agent-2',
        name: 'second',
        model: 'claude-sonnet-4-6'
    })

    assert.deepEqual(attachCalls, [
        { hostId: 'rth_fixture', agentId: 'agent-2', workspace: undefined }
    ])
    assert.equal(result.internalId, 'agent-2')
    assert.equal(result.workspace, '/home/sprite/.nca/workspaces/agent-2')
    assert.equal(result.model, 'claude-sonnet-4-6')
})

test('ClaudeCodeAgentAdapter.addAgent on a cloud computer goes through the same attacher', async () => {
    const targets: RuntimeTarget[] = []
    const attacher = {
        attach: async (args: { target: RuntimeTarget; agentId: string }) => {
            targets.push(args.target)
            return {
                workspacePath: `/home/node/.nca/workspaces/${args.agentId}`,
                internalId: args.agentId
            }
        },
        detach: async () => {}
    } as unknown as DaemonAgentAttacher
    const adapter = new ClaudeCodeAgentAdapter({} as never, attacher)

    const result = await adapter.addAgent({
        ...targetOn(k8sHostRow({ id: 'pdh_1' })),
        agentId: 'agent-2',
        internalId: 'agent-2',
        name: 'second'
    })

    assert.equal(targets.length, 1)
    assert.equal(targets[0].placement, 'k8s')
    assert.equal(targets[0].host?.id, 'pdh_1')
    assert.equal(result.internalId, 'agent-2')
    assert.equal(result.workspace, '/home/node/.nca/workspaces/agent-2')
})

test('ClaudeCodeAgentAdapter.addAgent refuses a runtime without a machine', async () => {
    const adapter = new ClaudeCodeAgentAdapter({} as never, noopAttacher)
    await assert.rejects(
        adapter.addAgent({
            ...contextOf({ runtime: runtimeRow({ hostId: null }), host: null }),
            agentId: 'agent-2',
            internalId: 'agent-2',
            name: 'second'
        }),
        (err: unknown) => err instanceof NotSupportedError
    )
})

test('ClaudeCodeAgentAdapter.listAgents returns all rows for the runtime', async () => {
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
    const adapter = new ClaudeCodeAgentAdapter(fakeDb as never, noopAttacher)

    const live = await adapter.listAgents(targetOn())

    assert.equal(live.length, 2)
    assert.equal(live[0].id, 'agent-1')
    assert.equal(live[1].id, 'agent-2')
    assert.equal(live[1].workspace, '/home/sprite/.nca/workspaces/agent-2')
    assert.equal(live[1].model, 'claude-sonnet-4-6')
})

test('ClaudeCodeAgentAdapter.removeAgent delegates to the attacher with the target', async () => {
    let detached: { target: RuntimeTarget; agent: Agent } | null = null
    const attacher = {
        attach: async () => ({ workspacePath: '', internalId: '' }),
        detach: async (args: { target: RuntimeTarget; agent: Agent }) => {
            detached = args
        }
    } as unknown as DaemonAgentAttacher
    const adapter = new ClaudeCodeAgentAdapter({} as never, attacher)
    const agent = {
        id: 'agent-2',
        workspacePath: '/home/sprite/.nca/workspaces/agent-2'
    } as unknown as Agent

    await adapter.removeAgent({
        ...targetOn(),
        agent
    })

    const captured = detached as { target: RuntimeTarget; agent: Agent } | null
    assert.equal(captured?.agent.id, 'agent-2')
    assert.equal(captured?.target.host?.id, 'rth_fixture')
})
