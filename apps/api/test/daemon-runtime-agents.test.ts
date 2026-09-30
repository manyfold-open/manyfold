import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentRuntimeRow, Database, NewAgent } from '@manyfold/db'
import { agentRuntimes, agents } from '@manyfold/db'
import { PLATFORM_DEFAULT_SKILL_IDS } from '@manyfold/shared'
import { Logger } from '@nestjs/common'
import { RuntimeAgentsController } from '../src/modules/agents/runtime-agents.controller'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'
import { SkillsService } from '../src/modules/skills/skills.service'
import {
    contextOf,
    fakeRuntimeContext,
    hostRow,
    k8sHostRow,
    runtimeRow as fixtureRuntime,
    spritesHostRow
} from './helpers/runtime-context-fixture'
import {
    headerOnlyReply,
    passThroughCreateRequests
} from './helpers/create-requests-fake'

const runtime = (overrides: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    fixtureRuntime({
        id: 'art-daemon-1',
        userId: 'u1',
        name: 'laptop-claude-code',
        framework: 'claude-code',
        hostId: 'dh-1',
        mountPath: '/workspace',
        ...overrides
    })

const hostFor = (kind: 'daemon' | 'sprites' | 'k8s') =>
    kind === 'daemon'
        ? hostRow({
              id: 'dh-1',
              userId: 'u1',
              homeDir: '/Users/me',
              workspaceBaseDir: '/Users/me/.nca/workspaces'
          })
        : kind === 'sprites'
          ? spritesHostRow({ id: 'dh-1', userId: 'u1' })
          : k8sHostRow({ id: 'dh-1', userId: 'u1' })

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
                                ? [runtime()]
                                : [{ managed: false }],
                        // An agent is already there, so this one joins beside it.
                        orderBy: () => ({
                            limit: async () =>
                                table === agents
                                    ? [{ modelProviderId: null }]
                                    : []
                        })
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
                assert.equal(inserted.status, 'ready')
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
            skills,
            fakeRuntimeContext(
                contextOf({ runtime: runtime(), host: hostFor(kind) })
            ) as never
        )
        const controller = new RuntimeAgentsController(
            { findById: async () => runtime() } as never,
            adapterRegistry as never,
            attach,
            {} as never,
            { recordFirstAgentCreated: async () => {} } as never,
            passThroughCreateRequests(),
            {} as never,
            {} as never
        )

        const result = await controller.addAgent(
            { userId: 'u1' } as never,
            'art-daemon-1',
            { name: 'local claude' } as never,
            headerOnlyReply()
        )

        const capturedInserted = inserted as NewAgent | null
        assert.equal(capturedInserted?.status, 'ready')
        assert.equal(result.status, 'ready')
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
    // The runtime's first agent, whose provider a joiner inherits.
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    orderBy: () => ({
                        limit: async () => [
                            { modelProviderId: 'provider-managed-open' }
                        ]
                    })
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
        } as never,
        fakeRuntimeContext(
            contextOf({
                runtime: runtime(),
                host: hostFor('daemon')
            })
        ) as never
    )

    await assert.rejects(
        attach.attach({
            runtime: runtime(),
            expectedOwnerUserId: 'u1',
            name: 'attached'
        }),
        /managed channel unavailable/
    )
    assert.deepEqual(gateArgs, ['u1', 'provider-managed-open', null])
    assert.equal(adapterCalls, 0)
})
