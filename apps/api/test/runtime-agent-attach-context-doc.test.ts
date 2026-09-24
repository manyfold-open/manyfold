import type { NewAgent } from '@manyfold/db'
import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'

// A created agent gets its context doc (AGENTS.manyfold.md and the reference
// in its instruction file) from its bootstrap. An agent added to a runtime
// that is already there — the four-step flow always prepares the sandbox
// first, then adds the agent — runs no bootstrap, so the attach writes it.

const runtime = (overrides: Record<string, unknown> = {}) => ({
    id: 'art_1',
    userId: 'user-1',
    name: 'sandbox-001-pi',
    framework: 'pi',
    kind: 'sprites',
    status: 'ready',
    hostId: 'sbx_1',
    spriteName: 'sbx-1',
    spriteId: 'sprite-1',
    accountId: 'spa_1',
    daemonId: null,
    mountPath: '/home/sprite/.manyfold/workspaces',
    primaryAgentId: null,
    ...overrides
})

const attachWith = async (
    runtimeRow: ReturnType<typeof runtime>
): Promise<Array<{ id: string; runtime: string; status: string }>> => {
    const written: Array<{ id: string; runtime: string; status: string }> = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        runtimeRow.kind === 'daemon' ? [{ managed: false }] : []
                })
            })
        }),
        insert: () => ({
            values: (row: NewAgent) => ({
                returning: async () => [
                    { ...row, createdAt: new Date(), updatedAt: new Date() }
                ]
            })
        }),
        update: () => ({ set: () => ({ where: async () => {} }) })
    }
    const attach = new RuntimeAgentAttachService(
        db as never,
        {
            get: () => ({
                addAgent: async (input: { agentId: string }) => ({
                    internalId: input.agentId,
                    workspace: `/home/sprite/.manyfold/workspaces/${input.agentId}`,
                    model: null,
                    extras: {}
                })
            })
        } as never,
        { touchAfterWrite: () => {} } as never,
        { assertManagedChannelBindable: async () => {} } as never,
        { installDefaults: async () => {} } as never,
        undefined,
        {
            refreshOnChange: async (agent: {
                id: string
                runtime: string
                status: string
            }) => {
                written.push({
                    id: agent.id,
                    runtime: agent.runtime,
                    status: agent.status
                })
            }
        } as never
    )
    await attach.attach({ runtime: runtimeRow as never, name: 'second' })
    return written
}

test('an agent added to a running sandbox gets its context doc written', async () => {
    const written = await attachWith(runtime())
    assert.equal(written.length, 1)
    assert.equal(written[0].runtime, 'sprites')
    assert.equal(written[0].status, 'running')
})

test('a daemon agent is left to its configuration delivery', async () => {
    const written = await attachWith(
        runtime({ kind: 'daemon', daemonId: 'dh_1', spriteName: null })
    )
    assert.deepEqual(written, [])
})
