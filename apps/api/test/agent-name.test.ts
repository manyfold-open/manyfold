import {
    normalizeAgentName,
    validateAgentName
} from '@manyfold/shared'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import type { AgentRuntimeRow, Database, NewAgent } from '@manyfold/db'
import { CreateAgentDto } from '../src/modules/agents/dto/create-agent.dto'
import { UpdateAgentDto } from '../src/modules/agents/dto/update-agent.dto'
import { AddRuntimeAgentDto } from '../src/modules/agents/dto/add-runtime-agent.dto'
import { RuntimeAgentsController } from '../src/modules/agents/runtime-agents.controller'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'

test('agent name helper accepts Unicode display names', () => {
    for (const name of ['中文助手', '研发助手 🚀', 'Agent 1', 'my-agent.v2']) {
        assert.deepEqual(validateAgentName(name), {
            valid: true,
            value: name
        })
    }
})

test('agent name helper trims and NFC-normalizes names', () => {
    const value = normalizeAgentName('  Cafe\u0301  ')

    assert.equal(value, 'Café')
    assert.deepEqual(validateAgentName('  Cafe\u0301  '), {
        valid: true,
        value: 'Café'
    })
})

test('agent name helper rejects invalid names', () => {
    const invalidNames = [
        '',
        '   ',
        'Agent\nName',
        'Agent\n',
        'Agent\tName',
        '\tAgent',
        '.agent',
        'a'.repeat(65)
    ]

    for (const name of invalidNames) {
        assert.equal(validateAgentName(name).valid, false, name)
    }
})

test('agent DTOs accept normalized Chinese and emoji names', async () => {
    const cases: Array<{
        dto: object
        expectedName: string
    }> = [
        {
            dto: plainToInstance(CreateAgentDto, {
                name: '  研发助手 🚀  ',
                framework: 'claude-code',
                runtime: 'sprites'
            }),
            expectedName: '研发助手 🚀'
        },
        {
            dto: plainToInstance(UpdateAgentDto, {
                name: '  中文助手  '
            }),
            expectedName: '中文助手'
        },
        {
            dto: plainToInstance(AddRuntimeAgentDto, {
                name: '  研究助手 🚀  '
            }),
            expectedName: '研究助手 🚀'
        }
    ]

    for (const item of cases) {
        const errors = await validate(item.dto)

        assert.deepEqual(errors, [])
        assert.equal((item.dto as { name: string }).name, item.expectedName)
    }
})

test('agent DTOs reject invalid display names', async () => {
    const cases = [
        plainToInstance(CreateAgentDto, {
            name: '.agent',
            framework: 'claude-code',
            runtime: 'sprites'
        }),
        plainToInstance(UpdateAgentDto, { name: 'Agent\nName' }),
        plainToInstance(AddRuntimeAgentDto, { name: 'a'.repeat(65) })
    ]

    for (const dto of cases) {
        const errors = await validate(dto)

        assert.notEqual(errors.length, 0)
    }
})

test('agent DTOs validate optional workspace paths', async () => {
    const createOk = plainToInstance(CreateAgentDto, {
        name: 'agent-one',
        framework: 'claude-code',
        runtime: 'sprites',
        workspace: ' /repo/project '
    })
    assert.deepEqual(await validate(createOk), [])
    assert.equal(createOk.workspace, '/repo/project')

    const addBlank = plainToInstance(AddRuntimeAgentDto, {
        name: 'agent-two',
        workspace: '   '
    })
    assert.deepEqual(await validate(addBlank), [])
    assert.equal(addBlank.workspace, undefined)

    for (const dto of [
        plainToInstance(CreateAgentDto, {
            name: 'agent-three',
            framework: 'claude-code',
            runtime: 'sprites',
            workspace: 'repo/project'
        }),
        plainToInstance(AddRuntimeAgentDto, {
            name: 'agent-four',
            workspace: '/repo/project\0bad'
        })
    ]) {
        const errors = await validate(dto)
        assert.notEqual(errors.length, 0)
    }
})

test('CreateAgentDto accepts A2A external bindings', async () => {
    const dto = plainToInstance(CreateAgentDto, {
        name: 'A2A Agent',
        framework: 'a2a',
        runtime: 'external',
        a2aBinding: {
            providerId: 'provider-1',
            selectedSkillId: 'skill-1'
        }
    })

    assert.deepEqual(await validate(dto), [])
})

test('OpenClaw runtime agents use generated ASCII internal ids and Unicode display names', async () => {
    let inserted: NewAgent | null = null
    let adapterInput: {
        agentId: string
        internalId: string
        name: string
    } | null = null
    let touchedRuntimeId: string | null = null
    const now = new Date('2026-05-06T00:00:00.000Z')
    const runtime = runtimeRow()
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => []
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
            addAgent: async (ctx: {
                agentId: string
                internalId: string
                name: string
            }) => {
                adapterInput = ctx
                return {
                    internalId: ctx.internalId,
                    workspace: `/workspace/profiles/${ctx.internalId}`,
                    model: null,
                    extras: {}
                }
            },
            removeAgent: async () => {},
            listAgents: async () => []
        })
    }
    const attach = new RuntimeAgentAttachService(
        db,
        adapterRegistry as never,
        { touchAfterWrite: (id: string) => (touchedRuntimeId = id) } as never,
        { assertManagedChannelBindable: async () => undefined } as never
    )
    const controller = new RuntimeAgentsController(
        { findById: async () => runtime } as never,
        adapterRegistry as never,
        attach,
        { recordFirstAgentCreated: async () => {} } as never
    )
    const dto = plainToInstance(AddRuntimeAgentDto, {
        name: '  研究助手 🚀  '
    })

    assert.deepEqual(await validate(dto), [])
    const result = await controller.addAgent(
        { userId: 'user-1' } as never,
        runtime.id,
        dto
    )

    const capturedAdapterInput = adapterInput as {
        agentId: string
        internalId: string
        name: string
    } | null
    const capturedInserted = inserted as NewAgent | null
    assert.match(capturedAdapterInput?.agentId ?? '', /^agt_[a-z2-7]{26}$/)
    assert.match(capturedAdapterInput?.internalId ?? '', /^agt-[a-z2-7]{26}$/)
    assert.equal(capturedAdapterInput?.name, '研究助手 🚀')
    assert.equal(capturedInserted?.id, capturedAdapterInput?.agentId)
    assert.equal(capturedInserted?.name, '研究助手 🚀')
    assert.equal(capturedInserted?.internalId, capturedAdapterInput?.internalId)
    assert.equal(result.name, '研究助手 🚀')
    assert.equal(result.internalId, capturedAdapterInput?.internalId)
    assert.equal(touchedRuntimeId, runtime.id)
})

const runtimeRow = (): AgentRuntimeRow =>
    ({
        id: 'art_test',
        userId: 'user-1',
        name: 'openclaw-runtime',
        framework: 'openclaw',
        kind: 'k8s',
        status: 'ready',
        accountId: null,
        spriteName: null,
        spriteId: null,
        clusterId: 'clus_test',
        daemonId: null,
        homeDir: null,
        workspaceBaseDir: null,
        capabilitiesJson: {},
        lastSeenAt: null,
        namespace: 'nca-dev',
        ingressHost: 'openclaw.example.test',
        mountPath: '/workspace',
        primaryAgentId: 'agt_primary',
        controlUiEnabled: true,
        dashboardEnabled: false,
        currentPhase: null,
        failureReason: null,
        startedAt: new Date('2026-05-06T00:00:00.000Z'),
        lastBootstrappedAt: new Date('2026-05-06T00:00:00.000Z'),
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z')
    }) as AgentRuntimeRow
