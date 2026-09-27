import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException, NotFoundException } from '@nestjs/common'
import type { AgentRuntimeRow } from '@manyfold/db'
import type { AuthPrincipal } from '../src/common/guards/auth.guard'
import {
    AgentRuntimesController,
    RUNTIME_AGENTS_BOUND_CODE
} from '../src/modules/agent-runtimes/agent-runtimes.controller'
import { AdminAgentRuntimesController } from '../src/modules/agent-runtimes/admin-agent-runtimes.controller'

// DELETE /agent-runtimes/:id (ADR-0037 R8): one rule for every placement. A
// runtime with agents bound is refused — agents.runtime_id cascades, so
// dropping the row would silently delete every agent on it — and an empty one
// is just a row to delete. No kind switch, no 500, and the admin route applies
// the same rule over every user.

const user = { userId: 'user-1' } as AuthPrincipal

const runtimeRow = (overrides: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    ({
        id: 'art_test',
        userId: 'user-1',
        name: 'main',
        framework: 'claude-code',
        status: 'ready',
        hostId: 'sbx_test',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        ...overrides
    }) as AgentRuntimeRow

const buildHarness = (opts: { row: AgentRuntimeRow | null; agents?: number }) => {
    const calls: string[] = []
    const runtimes = {
        findById: async (id: string) =>
            opts.row && opts.row.id === id ? opts.row : null,
        agentsCount: async () => opts.agents ?? 0,
        delete: async (id: string) => {
            calls.push(`delete:${id}`)
        }
    }
    const controller = new AgentRuntimesController(
        runtimes as never,
        {} as never
    )
    const admin = new AdminAgentRuntimesController(
        runtimes as never,
        {} as never
    )
    return { controller, admin, calls }
}

test('a runtime with agents bound is refused with a typed conflict, not deleted', async () => {
    const { controller, calls } = buildHarness({ row: runtimeRow(), agents: 2 })

    await assert.rejects(
        () => controller.delete(user, 'art_test'),
        (err: unknown) => {
            assert.ok(
                err instanceof ConflictException,
                `expected ConflictException, got ${(err as Error).constructor.name}`
            )
            const body = (err as ConflictException).getResponse() as {
                code?: string
                message?: string
            }
            assert.equal(body.code, RUNTIME_AGENTS_BOUND_CODE)
            assert.match(String(body.message), /2 agent/)
            return true
        }
    )
    assert.deepEqual(calls, [], 'the row must survive so the agents survive')
})

test('an external runtime with no agent left is deletable — same rule, no kind switch', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ framework: 'dify', hostId: null }),
        agents: 0
    })

    await controller.delete(user, 'art_test')

    assert.deepEqual(calls, ['delete:art_test'])
})

test('a runtime on a local host is deletable once empty', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ hostId: 'dh_test' })
    })

    await controller.delete(user, 'art_test')

    assert.deepEqual(calls, ['delete:art_test'])
})

test('another user cannot reach the rule at all', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ userId: 'user-2' })
    })

    await assert.rejects(
        () => controller.delete(user, 'art_test'),
        NotFoundException
    )
    assert.deepEqual(calls, [])
})

test('the admin route answers 404 for a missing id and applies the same 409', async () => {
    const missing = buildHarness({ row: null })
    await assert.rejects(() => missing.admin.get('art_nope'), NotFoundException)
    await assert.rejects(() => missing.admin.delete('art_nope'), NotFoundException)

    const bound = buildHarness({ row: runtimeRow({ userId: 'user-2' }), agents: 1 })
    await assert.rejects(
        () => bound.admin.delete('art_test'),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                RUNTIME_AGENTS_BOUND_CODE
    )
    assert.deepEqual(bound.calls, [])

    const empty = buildHarness({ row: runtimeRow({ userId: 'user-2' }) })
    await empty.admin.delete('art_test')
    assert.deepEqual(empty.calls, ['delete:art_test'])
})
