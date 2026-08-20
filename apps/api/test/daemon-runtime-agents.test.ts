import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentRuntimeRow, Database, NewAgent } from '@manyfold/db'
import { RuntimeAgentsController } from '../src/modules/agents/runtime-agents.controller'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'

const runtime = (overrides: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    ({
        id: 'art-daemon-1',
        userId: 'u1',
        name: 'laptop-claude-code',
        framework: 'claude-code',
        kind: 'daemon',
        status: 'ready',
        accountId: null,
        spriteName: null,
        spriteId: null,
        clusterId: null,
        daemonId: 'dh-1',
        homeDir: '/Users/me',
        workspaceBaseDir: '/Users/me/.nca/workspaces',
        capabilitiesJson: {},
        lastSeenAt: new Date(),
        namespace: null,
        ingressHost: null,
        mountPath: '/workspace',
        primaryAgentId: null,
        controlUiEnabled: true,
        dashboardEnabled: false,
        currentPhase: null,
        failureReason: null,
        startedAt: new Date(),
        lastBootstrappedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as AgentRuntimeRow

test('adding an agent to a daemon runtime inserts it as running', async () => {
    let inserted: NewAgent | null = null
    const now = new Date()
    const db = {
        insert: () => ({
            values: (row: NewAgent) => {
                inserted = row
                return {
                    returning: async () => [
                        {
                            ...row,
                            createdAt: now,
                            updatedAt: now
                        }
                    ]
                }
            }
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) })
    } as unknown as Database
    const adapterRegistry = {
        get: () => ({
            addAgent: async (args: { agentId: string }) => ({
                internalId: args.agentId,
                workspace: `/Users/me/.nca/workspaces/${args.agentId}`,
                model: null,
                extras: {}
            })
        })
    }
    const attach = new RuntimeAgentAttachService(
        db,
        adapterRegistry as never,
        { touchAfterWrite: () => undefined } as never,
        { assertManagedChannelBindable: async () => undefined } as never
    )
    const controller = new RuntimeAgentsController(
        { findById: async () => runtime() } as never,
        adapterRegistry as never,
        attach,
        { recordFirstAgentCreated: async () => {} } as never
    )

    const result = await controller.addAgent(
        { userId: 'u1' } as never,
        'art-daemon-1',
        { name: 'local claude' } as never
    )

    const capturedInserted = inserted as NewAgent | null
    assert.equal(capturedInserted?.runtime, 'daemon')
    assert.equal(capturedInserted?.status, 'running')
    assert.equal(result.status, 'running')
})

test('a daemon attach gates the managed provider inherited by the new agent', async () => {
    let adapterCalls = 0
    let gateArgs: unknown[] | null = null
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'provider-managed-open' }]
                })
            })
        })
    } as unknown as Database
    const attach = new RuntimeAgentAttachService(
        db,
        {
            get: () => ({
                addAgent: async () => {
                    adapterCalls += 1
                    return {}
                }
            })
        } as never,
        { touchAfterWrite: () => undefined } as never,
        {
            assertManagedChannelBindable: async (...args: unknown[]) => {
                gateArgs = args
                throw new Error('managed channel unavailable')
            }
        } as never
    )

    await assert.rejects(
        attach.attach({
            runtime: runtime({ primaryAgentId: 'agt_primary' }),
            name: 'attached'
        }),
        /managed channel unavailable/
    )
    assert.deepEqual(gateArgs, ['u1', 'provider-managed-open', null])
    assert.equal(adapterCalls, 0)
})
