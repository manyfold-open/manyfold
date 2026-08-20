import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import {
    AgentsService,
    agentRowToSummary
} from '../src/modules/agents/agents.service'
import { UpdateAgentDto } from '../src/modules/agents/dto/update-agent.dto'

const baseAgent = {
    id: 'agt_test',
    userId: 'user_test',
    runtimeId: null,
    name: 'old-name',
    framework: 'claude-code',
    runtime: 'sprites',
    status: 'running',
    spriteStatus: null,
    k8sPodPhase: null,
    clusterId: null,
    spriteName: 'sprite-test',
    spriteId: null,
    mountPath: '/workspace',
    namespace: null,
    ingressHost: null,
    currentPhase: null,
    failureReason: null,
    internalId: 'sprite-test',
    model: null,
    extras: {},
    workspacePath: '/workspace',
    startedAt: null,
    lastBootstrappedAt: null,
    lastReconciledAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z')
}

const makeService = (agent = baseAgent) => {
    let selectCalls = 0
    let lastPatch: Record<string, unknown> | null = null
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => {
                        selectCalls += 1
                        return selectCalls === 1 ? [agent] : []
                    }
                })
            })
        }),
        update: () => ({
            set: (patch: Record<string, unknown>) => {
                lastPatch = patch
                return {
                    where: () => ({
                        returning: async () => [{ ...agent, ...patch }]
                    })
                }
            }
        })
    }
    const reconcile = {
        loadRuntime: async () => null,
        touchRuntime: () => undefined
    }
    let mcpRefreshCount = 0
    return {
        service: new AgentsService(
            db as never,
            reconcile as never,
            {} as never,
            { resolveNeedsUpgradeMap: async () => new Map() } as never,
            {} as never,
            {} as never,
            { get: () => ({}) } as never,
            {} as never,
            {} as never,
            {} as never,
            {
                refreshOnChange: async () => {
                    mcpRefreshCount += 1
                }
            } as never,
            {} as never
        ),
        lastPatch: () => lastPatch,
        mcpRefreshCount: () => mcpRefreshCount
    }
}

const hermesAgent = { ...baseAgent, framework: 'hermes' }

test('AgentsService ignores transform-added undefined model on name-only updates', async () => {
    const { service, lastPatch } = makeService()
    const dto = plainToInstance(UpdateAgentDto, { name: 'nca-issues-cc' })

    assert.equal(Object.hasOwn(dto, 'model'), true)
    assert.equal(dto.model, undefined)

    const updated = await service.update(
        baseAgent.id,
        baseAgent.userId,
        dto,
        false
    )

    assert.equal(updated.name, 'nca-issues-cc')
    assert.equal(lastPatch()?.name, 'nca-issues-cc')
    assert.equal(Object.hasOwn(lastPatch() ?? {}, 'model'), false)
})

test('AgentsService still rejects explicit model updates for configurable frameworks', async () => {
    const { service } = makeService()

    await assert.rejects(
        () =>
            service.update(
                baseAgent.id,
                baseAgent.userId,
                { model: 'sonnet' },
                false
            ),
        BadRequestException
    )
})

// MCP config must be validated against the agent's framework before it lands in
// extras, and a successful change must trigger the best-effort sprite push.
test('AgentsService accepts valid MCP config and pushes it to the sprite', async () => {
    const { service, lastPatch, mcpRefreshCount } = makeService()

    const updated = await service.update(
        baseAgent.id,
        baseAgent.userId,
        { mcp: { user: '{"fs":{"command":"npx"}}' } },
        false
    )

    assert.equal(updated.id, baseAgent.id)
    // MCP flowed into the extras merge (same jsonbMerge path that protects
    // envText / connection ids from being clobbered).
    assert.equal(Object.hasOwn(lastPatch() ?? {}, 'extras'), true)
    assert.equal(mcpRefreshCount(), 1)
})

test('AgentsService rejects an unknown MCP scope for the framework', async () => {
    const { service } = makeService()

    await assert.rejects(
        () =>
            service.update(
                baseAgent.id,
                baseAgent.userId,
                { mcp: { global: '{}' } }, // claude-code has no "global" scope
                false
            ),
        BadRequestException
    )
})

test('AgentsService rejects invalid MCP JSON', async () => {
    const { service } = makeService()

    await assert.rejects(
        () =>
            service.update(
                baseAgent.id,
                baseAgent.userId,
                { mcp: { user: '{ not json' } },
                false
            ),
        BadRequestException
    )
})

test('AgentsService rejects MCP config for a non-MCP framework', async () => {
    const { service } = makeService(hermesAgent)

    await assert.rejects(
        () =>
            service.update(
                hermesAgent.id,
                hermesAgent.userId,
                { mcp: { user: '{}' } },
                false
            ),
        BadRequestException
    )
})

test('AgentsService stopSprite returns keep-alive release status', async () => {
    const agent = {
        ...baseAgent,
        runtimeId: 'art_test',
        spriteStatus: 'running'
    }
    const runtime = {
        id: 'art_test',
        framework: 'hermes',
        kind: 'sprites'
    }
    const auditRows: unknown[] = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agent]
                })
            })
        }),
        insert: () => ({
            values: async (row: unknown) => {
                auditRows.push(row)
            }
        })
    }
    const keepAliveCalls: string[] = []
    const service = new AgentsService(
        db as never,
        {
            loadRuntime: async () => runtime,
            touchRuntime: () => undefined
        } as never,
        {
            closeForAgent: () => 2
        } as never,
        { resolveNeedsUpgradeMap: async () => new Map() } as never,
        {
            stopAndRelease: async (rt: { id: string }) => {
                keepAliveCalls.push(rt.id)
                return { state: 'verified', maxStaleSec: 90 }
            }
        } as never,
        {
            findById: async () => runtime
        } as never,
        { get: () => ({}) } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    const result = await service.stopSprite(agent.id, agent.userId, false)

    assert.equal(result.status, 'pending')
    assert.equal(result.closedSessions, 2)
    assert.equal(result.estimatedReadyInSec, 90)
    assert.deepEqual(result.keepAliveRelease, {
        state: 'verified',
        maxStaleSec: 90
    })
    assert.deepEqual(keepAliveCalls, ['art_test'])
    assert.equal(auditRows.length, 1)
})

test('AgentsService stopSprite clears keep-alive flag before stopAndRelease', async () => {
    const agent = {
        ...baseAgent,
        runtimeId: 'art_keepalive',
        spriteStatus: 'running'
    }
    const runtime = {
        id: 'art_keepalive',
        framework: 'hermes',
        kind: 'sprites',
        keepAliveEnabled: true
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agent]
                })
            })
        }),
        insert: () => ({
            values: async () => undefined
        })
    }
    const calls: string[] = []
    const service = new AgentsService(
        db as never,
        {
            loadRuntime: async () => runtime,
            touchRuntime: () => undefined
        } as never,
        {
            closeForAgent: () => 0
        } as never,
        { resolveNeedsUpgradeMap: async () => new Map() } as never,
        {
            stopAndRelease: async () => {
                calls.push('stopAndRelease')
                return { state: 'verified', maxStaleSec: 90 }
            }
        } as never,
        {
            findById: async () => runtime,
            setKeepAliveEnabled: async (id: string, enabled: boolean) => {
                calls.push(`setKeepAliveEnabled:${id}:${enabled}`)
            }
        } as never,
        { get: () => ({}) } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    const result = await service.stopSprite(agent.id, agent.userId, false)

    assert.equal(result.status, 'pending')
    // WHY: with the flag left on, reconcile Pass B re-wakes the sprite within
    // 60s and user-stop becomes a lie — the column must flip to false BEFORE
    // stopAndRelease so even a degraded release cannot be resurrected.
    assert.deepEqual(
        calls,
        ['setKeepAliveEnabled:art_keepalive:false', 'stopAndRelease'],
        'keep-alive flag must be cleared before stopAndRelease or Pass B resurrects a user-stopped sprite'
    )
})

test('AgentsService stopSprite keeps sprite sleep estimate for exec-kind runtimes', async () => {
    const agent = {
        ...baseAgent,
        runtimeId: 'art_exec',
        spriteStatus: 'running'
    }
    const runtime = {
        id: 'art_exec',
        framework: 'claude-code',
        kind: 'sprites'
    }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agent]
                })
            })
        }),
        insert: () => ({
            values: async () => undefined
        })
    }
    const service = new AgentsService(
        db as never,
        {
            loadRuntime: async () => runtime,
            touchRuntime: () => undefined
        } as never,
        {
            closeForAgent: () => 1
        } as never,
        { resolveNeedsUpgradeMap: async () => new Map() } as never,
        {
            stopAndRelease: async () => ({
                state: 'not_applicable',
                maxStaleSec: 0
            })
        } as never,
        {
            findById: async () => runtime
        } as never,
        { get: () => ({}) } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    const result = await service.stopSprite(agent.id, agent.userId, false)

    assert.equal(result.status, 'pending')
    assert.equal(result.closedSessions, 1)
    assert.equal(result.estimatedReadyInSec, 35)
    assert.deepEqual(result.keepAliveRelease, {
        state: 'not_applicable',
        maxStaleSec: 0
    })
})

test('agentRowToSummary carries lastMessageAt separately from the liveness timestamps', () => {
    const reconciledJustNow = new Date('2026-01-05T00:00:00Z')
    const summary = agentRowToSummary({
        ...baseAgent,
        lastReconciledAt: reconciledJustNow,
        lastMessageAt: new Date('2026-01-02T00:00:00Z')
    } as never)

    assert.equal(
        summary.lastMessageAt,
        '2026-01-02T00:00:00.000Z',
        'the sidebar filters and sorts on this field, so the list payload must expose it'
    )
    assert.equal(
        summary.lastActiveAt,
        reconciledJustNow.toISOString(),
        'lastActiveAt keeps its liveness meaning — a reconcile sweep must not look like a prompt'
    )
})

test('agentRowToSummary reports a never-prompted agent as null, not as its creation time', () => {
    const summary = agentRowToSummary({
        ...baseAgent,
        lastMessageAt: null
    } as never)

    assert.equal(
        summary.lastMessageAt,
        null,
        'the createdAt fallback belongs to the client so the detail page can render "-" instead of a fake prompt time'
    )
})
