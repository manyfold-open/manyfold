import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import {
    AgentsService,
    agentRowToSummary
} from '../src/modules/agents/agents.service'
import { UpdateAgentDto } from '../src/modules/agents/dto/update-agent.dto'
import { readJsonbMergeNestedPatch } from './jsonb-merge'
import {
    contextOf,
    fakeRuntimeContext,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

const baseAgent = {
    id: 'agt_test',
    userId: 'user_test',
    runtimeId: 'art_test',
    name: 'old-name',
    framework: 'claude-code',
    status: 'ready',
    mountPath: '/workspace',
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

const summaryRow = (agent = baseAgent) =>
    contextOf({
        agent: agent as never,
        runtime: runtimeRow({ id: agent.runtimeId, framework: agent.framework }),
        host: spritesHostRow()
    })

const makeService = (agent = baseAgent) => {
    let selectCalls = 0
    let lastPatch: Record<string, unknown> | null = null
    const db = {
        select: (cols?: unknown) => ({
            from: () => ({
                where: () => ({
                    limit: async () => {
                        if (cols) return []
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
            fakeRuntimeContext(summaryRow(agent)) as never,
            { get: () => ({}) } as never,
            {
                latestFor: async () => null,
                blockedRangesFor: async () => []
            } as never,
            {} as never,
            {} as never,
            {
                refreshOnChange: async () => {
                    mcpRefreshCount += 1
                }
            } as never,
            {
                getCachedLatest: async () => ({ version: null, channel: 'stable' })
            } as never
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
    const { service, lastPatch } = makeService()

    await assert.rejects(
        () =>
            service.update(
                baseAgent.id,
                baseAgent.userId,
                { name: 'renamed', model: 'sonnet' },
                false
            ),
        (err: unknown) => {
            assert.ok(err instanceof BadRequestException)
            // The code lets a client send the model to the model settings
            // instead (the CLI names mf model-config update).
            assert.deepEqual(err.getResponse(), {
                message: `Use /agents/${baseAgent.id}/model-config to update claude-code models`,
                code: 'AGENT_MODEL_IN_MODEL_CONFIG',
                details: { agentId: baseAgent.id, framework: 'claude-code' }
            })
            return true
        }
    )
    assert.equal(lastPatch(), null, 'the rename must not be written either')
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

// A PATCH names the scopes it changes: the ones it leaves out keep their
// config. The write merges the body's scopes into the stored map in SQL
// (not the whole map replaced, which dropped every other scope).
test('AgentsService merges MCP config per scope', async () => {
    const { service, lastPatch } = makeService()

    await service.update(
        baseAgent.id,
        baseAgent.userId,
        { mcp: { user: '{"fs":{"command":"npx"}}' } },
        false
    )

    const write = readJsonbMergeNestedPatch(lastPatch()?.extras)
    assert.ok(write, 'mcp is merged one level deeper, per scope')
    assert.equal(write.key, 'mcp')
    assert.deepEqual(write.nested, { user: '{"fs":{"command":"npx"}}' })
    assert.equal(Object.hasOwn(write.patch, 'mcp'), false)
    assert.equal(
        (write.patch.mcpDelivery as Record<string, { status: string }>).user
            .status,
        'failed'
    )
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

test('agentRowToSummary carries lastMessageAt separately from the liveness timestamps', () => {
    const reconciledJustNow = new Date('2026-01-05T00:00:00Z')
    const summary = agentRowToSummary(
        summaryRow({
            ...baseAgent,
            lastReconciledAt: reconciledJustNow,
            lastMessageAt: new Date('2026-01-02T00:00:00Z')
        } as never) as never
    )

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
    const summary = agentRowToSummary(
        summaryRow({ ...baseAgent, lastMessageAt: null } as never) as never
    )

    assert.equal(
        summary.lastMessageAt,
        null,
        'the createdAt fallback belongs to the client so the detail page can render "-" instead of a fake prompt time'
    )
})
