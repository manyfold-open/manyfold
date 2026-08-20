import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException, NotFoundException } from '@nestjs/common'
import type { AgentRuntimeRow } from '@manyfold/db'
import type { AuthPrincipal } from '../src/common/guards/auth.guard'
import { AgentRuntimesController } from '../src/modules/agent-runtimes/agent-runtimes.controller'

// DELETE /agent-runtimes/:id used to handle only the sprites and k8s kinds and
// fall through to InternalServerErrorException for everything else — so both
// remaining kinds returned a 500 for a routine request: daemon runtimes (one is
// auto-created per framework at `mf daemon register`) and external runtimes
// (created per Dify/Langflow/A2A agent). Neither is deletable through this
// route by design, and for external it MUST NOT be: agents.runtime_id cascades,
// so dropping the row would silently delete the agent. These pin the contract
// per kind — a 500 is reserved for a kind nobody taught this route about.

const user = { userId: 'user-1' } as AuthPrincipal

const runtimeRow = (overrides: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    ({
        id: 'art_test',
        userId: 'user-1',
        name: 'main',
        framework: 'claude-code',
        kind: 'daemon',
        status: 'ready',
        daemonId: 'dh_test',
        skuId: null,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        ...overrides
    }) as AgentRuntimeRow

const buildHarness = (opts: {
    row: AgentRuntimeRow | null
    boundAgentId?: string | null
}) => {
    const calls: string[] = []
    const runtimes = {
        findById: async (id: string) =>
            opts.row && opts.row.id === id ? opts.row : null,
        delete: async (id: string) => {
            calls.push(`delete:${id}`)
        }
    }
    // Minimal drizzle shape for `select({id}).from(agents).where(...).limit(1)`.
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () =>
                        opts.boundAgentId ? [{ id: opts.boundAgentId }] : []
                })
            })
        })
    }
    const spritesProvisioner = {
        teardownRuntime: async () => {
            calls.push('sprites:teardownRuntime')
        }
    }
    const controller = new AgentRuntimesController(
        db as never,
        runtimes as never,
        spritesProvisioner as never,
        {} as never,
        {} as never
    )
    return { controller, calls }
}

test('deleting a daemon runtime is refused with a typed conflict, not a 500', async () => {
    const { controller, calls } = buildHarness({ row: runtimeRow() })

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
            assert.equal(body.code, 'runtime.daemon_managed')
            // The message has to point at the ONE lifecycle that removes them.
            assert.match(String(body.message), /revoke/i)
            return true
        }
    )
    assert.deepEqual(calls, [], 'nothing may be torn down')
})

test('deleting an external runtime with an agent bound is refused (the FK would cascade the agent away)', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ kind: 'external', framework: 'dify' }),
        boundAgentId: 'agt_dify_1'
    })

    await assert.rejects(
        () => controller.delete(user, 'art_test'),
        (err: unknown) => {
            assert.ok(err instanceof ConflictException)
            const body = (err as ConflictException).getResponse() as {
                code?: string
                message?: string
            }
            assert.equal(body.code, 'runtime.external_agent_bound')
            assert.match(String(body.message), /agt_dify_1/)
            return true
        }
    )
    assert.deepEqual(calls, [], 'the row must survive so the agent survives')
})

test('an external runtime with no agent left is deletable', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ kind: 'external', framework: 'dify' }),
        boundAgentId: null
    })

    await controller.delete(user, 'art_test')

    assert.deepEqual(calls, ['delete:art_test'])
})

test('a sprites runtime still tears down the VM (unchanged path)', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ kind: 'sprites', daemonId: null })
    })

    await controller.delete(user, 'art_test')

    assert.deepEqual(calls, ['sprites:teardownRuntime'])
})

test('another user cannot reach the kind branches at all', async () => {
    const { controller, calls } = buildHarness({
        row: runtimeRow({ userId: 'user-2' })
    })

    await assert.rejects(
        () => controller.delete(user, 'art_test'),
        NotFoundException
    )
    assert.deepEqual(calls, [])
})
