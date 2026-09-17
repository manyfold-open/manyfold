import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentRuntimeRow, Database, NewAgent } from '@manyfold/db'
import { agentRuntimes } from '@manyfold/db'
import { PLATFORM_DEFAULT_SKILL_IDS } from '@manyfold/shared'
import { Logger } from '@nestjs/common'
import { RuntimeAgentsController } from '../src/modules/agents/runtime-agents.controller'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'
import { SkillsService } from '../src/modules/skills/skills.service'

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

for (const { kind, failInstall } of [
    { kind: 'daemon', failInstall: false },
    { kind: 'sprites', failInstall: false },
    { kind: 'k8s', failInstall: false },
    { kind: 'daemon', failInstall: true }
] as const) {
    test(`${kind} attach attempts default skills after insertion and stays running (install failure: ${failInstall})`, async (t) => {
        let inserted: NewAgent | null = null
        const defaultInstalls: unknown[] = []
        const now = new Date()
        const db = {
            select: () => ({
                from: (table: unknown) => ({
                    where: () => ({
                        limit: async () =>
                            table === agentRuntimes
                                ? [runtime({ kind })]
                                : [{ managed: false }]
                    })
                })
            }),
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
        const warning = t.mock.method(Logger.prototype, 'warn', () => {})
        const skills = new SkillsService(
            {
                select: () => ({ from: () => ({ where: async () => [] }) })
            } as never,
            {} as never,
            {} as never,
            {
                getDefaultAgentSkills: async () => ({
                    skillIds: PLATFORM_DEFAULT_SKILL_IDS
                })
            } as never
        )
        t.mock.method(
            skills,
            'install',
            async (input: Parameters<SkillsService['install']>[0]) => {
                assert.ok(inserted)
                assert.equal(inserted.status, 'running')
                defaultInstalls.push(input)
                if (failInstall) throw new Error('discovery unavailable')
                return { materializeStatus: 'installed' } as never
            }
        )
        const attach = new RuntimeAgentAttachService(
            db,
            adapterRegistry as never,
            { touchAfterWrite: () => undefined } as never,
            { assertManagedChannelBindable: async () => undefined } as never,
            skills
        )
        const controller = new RuntimeAgentsController(
            { findById: async () => runtime({ kind }) } as never,
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
        assert.equal(capturedInserted?.runtime, kind)
        assert.equal(capturedInserted?.status, 'running')
        assert.equal(result.status, 'running')
        assert.deepEqual(defaultInstalls, [
            {
                userId: 'u1',
                agentId: result.id,
                skillId: PLATFORM_DEFAULT_SKILL_IDS[0]
            }
        ])
        assert.equal(warning.mock.callCount(), failInstall ? 1 : 0)
    })
}

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
        } as never,
        {
            installDefaults: async () => assert.fail('creation was rejected')
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
