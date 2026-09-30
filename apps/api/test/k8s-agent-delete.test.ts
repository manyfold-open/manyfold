import assert from 'node:assert/strict'
import test from 'node:test'
import { K8sAgentOrchestrator } from '../src/modules/agents/orchestration/k8s-agent-orchestrator'
import {
    contextOf,
    k8sHostRow,
    runtimeRow
} from './helpers/runtime-context-fixture'

// An agent on a cloud computer that leaves other agents behind is removed in
// its framework, then its row goes. The framework's own agent never gets here
// (ADR-0040): it leaves only with its runtime.

const build = () => {
    const removed: string[] = []
    const deleted: string[] = []
    const db = {
        delete: () => ({
            where: async () => {
                deleted.push('agents')
            }
        }),
        insert: () => ({ values: async () => {} })
    }
    const adapters = {
        get: () => ({
            removeAgent: async (ctx: { agent: { internalId: string } }) => {
                removed.push(ctx.agent.internalId)
            }
        })
    }
    return {
        orchestrator: new K8sAgentOrchestrator(db as never, adapters as never),
        removed,
        deleted
    }
}

const onPod = (internalId: string) =>
    contextOf({
        agent: {
            id: 'agt_2',
            userId: 'user-1',
            runtimeId: 'art_1',
            framework: 'openclaw',
            name: internalId,
            internalId,
            status: 'ready'
        } as never,
        runtime: runtimeRow({
            id: 'art_1',
            framework: 'openclaw',
            hostId: 'rth_1'
        }),
        host: k8sHostRow({ id: 'rth_1' })
    })

test('an agent with a profile of its own is removed in the framework first', async () => {
    const { orchestrator, removed, deleted } = build()

    await orchestrator.deleteAgent(onPod('research'), 'user-1')

    assert.deepEqual(removed, ['research'])
    assert.deepEqual(deleted, ['agents'])
})
