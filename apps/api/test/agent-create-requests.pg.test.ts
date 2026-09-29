import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException, HttpException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import {
    agentCreateRequests,
    agentRuntimes,
    agents,
    createDb,
    users
} from '@manyfold/db'
import { eq, inArray } from 'drizzle-orm'
import { withScratchDatabase } from '../scripts/scratch-db'
import {
    AgentCreateRequestsService,
    CREATE_REQUEST_STALE_MS
} from '../src/modules/agents/create-requests/agent-create-requests.service'

// Agent create requests (the name a create holds while it runs, and what a
// repeat of it gets): the claim runs under a per-user advisory lock and every
// outcome write is conditional on the row still being in progress, so these
// run against real Postgres.
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 PG_TEST_ADMIN_URL=postgres://… \
//     node --import tsx --test test/agent-create-requests.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

const config = { get: () => undefined } as unknown as ConfigService

const codeOf = (err: unknown): string | undefined =>
    err instanceof HttpException
        ? (err.getResponse() as { code?: string }).code
        : undefined

const gate = (): { wait: Promise<void>; open: () => void } => {
    let open!: () => void
    const wait = new Promise<void>((resolve) => (open = resolve))
    return { wait, open }
}

const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition never held')
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}

// What an outcome turns into for a caller, without leaving a rejection
// unhandled while the test does something else.
const settled = <T>(promise: Promise<T>): Promise<T | Error> =>
    promise.catch((err: Error) => err)

test('agent create requests', { skip: !RUN, timeout: 120_000 }, async (t) => {
    await withScratchDatabase('agent_create_requests', async ({ url }) => {
        const db = createDb(url, { max: 6 })
        try {
            await db.insert(users).values([
                { id: 'u1', email: 'u1@example.test' },
                { id: 'u2', email: 'u2@example.test' }
            ])
            await db.insert(agentRuntimes).values({
                id: 'art_1',
                userId: 'u1',
                name: 'runtime',
                framework: 'codex'
            })
            const service = new AgentCreateRequestsService(db, config)
            const claim = (name: string, fingerprint: string, userId = 'u1') =>
                service.claim({
                    userId,
                    actorUserId: userId,
                    name,
                    fingerprint
                })
            const rowOf = async (id: string) =>
                (
                    await db
                        .select()
                        .from(agentCreateRequests)
                        .where(eq(agentCreateRequests.id, id))
                )[0]
            // As if its API process stopped touching it.
            const goQuiet = (id: string) =>
                db
                    .update(agentCreateRequests)
                    .set({
                        updatedAt: new Date(
                            Date.now() - CREATE_REQUEST_STALE_MS - 1_000
                        )
                    })
                    .where(eq(agentCreateRequests.id, id))
            const insertAgent = (id: string, name: string) =>
                db.insert(agents).values({
                    id,
                    userId: 'u1',
                    name,
                    framework: 'codex',
                    runtimeId: 'art_1',
                    internalId: id
                })

            await t.test(
                'one of two concurrent claims runs; the same request attaches, another is refused',
                async () => {
                    const [a, b] = await Promise.all([
                        claim('alpha', 'fp-1'),
                        claim('alpha', 'fp-1')
                    ])
                    assert.deepEqual([a.kind, b.kind].sort(), ['attach', 'run'])
                    assert.equal(a.request.id, b.request.id)
                    assert.equal(
                        (await claim('  alpha ', 'fp-1')).kind,
                        'attach'
                    )
                    await assert.rejects(
                        claim('alpha', 'fp-2'),
                        (err) => codeOf(err) === 'AGENT_CREATE_IN_PROGRESS'
                    )
                    assert.equal(
                        (await claim('alpha', 'fp-2', 'u2')).kind,
                        'run'
                    )
                    // The index backs the lock: never two creates of a name.
                    await assert.rejects(
                        db.insert(agentCreateRequests).values({
                            id: 'acq_dup',
                            userId: 'u1',
                            actorUserId: 'u1',
                            name: 'alpha',
                            fingerprint: 'fp-1'
                        })
                    )
                }
            )

            await t.test(
                "a repeat follows the running create's steps to its agent",
                async () => {
                    const first = await claim('beta', 'fp')
                    assert.equal(first.kind, 'run')
                    const release = gate()
                    const running = service.run(
                        first.request,
                        undefined,
                        async (emitter) => {
                            emitter.step('creating_sprite')
                            emitter.placed?.({
                                hostId: 'rth_beta',
                                runtimeId: 'art_beta',
                                hostCreated: true
                            })
                            await release.wait
                            return { id: 'agt_beta' }
                        }
                    )
                    await waitFor(
                        async () =>
                            (await rowOf(first.request.id))?.hostId ===
                            'rth_beta'
                    )
                    const repeat = await claim('beta', 'fp')
                    assert.equal(repeat.kind, 'attach')
                    const steps: string[] = []
                    const followed = settled(
                        service.follow(repeat.request.id, (step) =>
                            steps.push(step)
                        )
                    )
                    await waitFor(async () => steps.length > 0)
                    release.open()
                    assert.equal(await followed, 'agt_beta')
                    assert.deepEqual(steps, ['creating_sprite'])
                    assert.deepEqual(await running, { id: 'agt_beta' })
                    const row = await rowOf(first.request.id)
                    assert.equal(row?.status, 'succeeded')
                    assert.equal(row?.agentId, 'agt_beta')
                    assert.equal(row?.runtimeId, 'art_beta')
                }
            )

            await t.test(
                'a failure reaches the followers with its code, and the request can run again',
                async () => {
                    const first = await claim('gamma', 'fp')
                    const release = gate()
                    const running = settled(
                        service.run(first.request, undefined, async () => {
                            await release.wait
                            throw new ConflictException({
                                message: 'runtime limit reached',
                                code: 'RUNTIME_LIMIT_REACHED',
                                details: { limit: 3 }
                            })
                        })
                    )
                    const repeat = await claim('gamma', 'fp')
                    const followed = settled(
                        service.follow(repeat.request.id, () => undefined)
                    )
                    release.open()
                    assert.equal(codeOf(await running), 'RUNTIME_LIMIT_REACHED')
                    const err = await followed
                    assert.ok(err instanceof HttpException)
                    assert.equal(err.getStatus(), 409)
                    assert.equal(codeOf(err), 'RUNTIME_LIMIT_REACHED')
                    assert.deepEqual(
                        (err.getResponse() as { details?: unknown }).details,
                        { limit: 3 }
                    )
                    const again = await claim('gamma', 'fp')
                    assert.equal(again.kind, 'run')
                    assert.notEqual(again.request.id, first.request.id)
                }
            )

            await t.test(
                'a create gone quiet is taken over, and its late outcome does not overwrite that',
                async () => {
                    const first = await claim('delta', 'fp-1')
                    const release = gate()
                    const running = service.run(
                        first.request,
                        undefined,
                        async (emitter) => {
                            emitter.placed?.({
                                hostId: 'rth_left',
                                runtimeId: 'art_left',
                                hostCreated: true
                            })
                            await release.wait
                            return { id: 'agt_late' }
                        }
                    )
                    await waitFor(
                        async () =>
                            (await rowOf(first.request.id))?.hostId ===
                            'rth_left'
                    )
                    await goQuiet(first.request.id)
                    const takeover = await claim('delta', 'fp-2')
                    assert.equal(takeover.kind, 'run')
                    const ended = await rowOf(first.request.id)
                    assert.equal(ended?.status, 'failed')
                    assert.deepEqual(ended?.error, {
                        code: 'AGENT_CREATE_INTERRUPTED',
                        status: 503,
                        message:
                            'the create of "delta" stopped when its API process did; it may have left sandbox rth_left behind',
                        details: {
                            name: 'delta',
                            hostId: 'rth_left',
                            runtimeId: 'art_left'
                        }
                    })
                    release.open()
                    assert.deepEqual(await running, { id: 'agt_late' })
                    assert.equal(
                        (await rowOf(first.request.id))?.status,
                        'failed'
                    )
                    assert.equal(
                        (await rowOf(takeover.request.id))?.status,
                        'in_progress'
                    )
                }
            )

            await t.test(
                'a follower ends a create whose heartbeat stopped',
                async () => {
                    const first = await claim('epsilon', 'fp')
                    const repeat = await claim('epsilon', 'fp')
                    assert.equal(repeat.kind, 'attach')
                    await goQuiet(first.request.id)
                    const err = await settled(
                        service.follow(repeat.request.id, () => undefined)
                    )
                    assert.ok(err instanceof HttpException)
                    assert.equal(err.getStatus(), 503)
                    assert.equal(codeOf(err), 'AGENT_CREATE_INTERRUPTED')
                    assert.equal(
                        (await rowOf(first.request.id))?.status,
                        'failed'
                    )
                }
            )

            await t.test(
                'a repeat of a finished create gets its agent; anything else is told the name is taken',
                async () => {
                    const first = await claim('zeta', 'fp')
                    await service.run(
                        first.request,
                        undefined,
                        async (emitter) => {
                            emitter.step('finalizing')
                            await insertAgent('agt_zeta', 'zeta')
                            return { id: 'agt_zeta' }
                        }
                    )
                    const repeat = await claim('zeta', 'fp')
                    assert.equal(repeat.kind, 'attach')
                    assert.equal(repeat.request.id, first.request.id)
                    assert.equal(
                        await service.follow(repeat.request.id, () =>
                            assert.fail(
                                'a finished create has no steps to replay'
                            )
                        ),
                        'agt_zeta'
                    )
                    await assert.rejects(claim('zeta', 'fp-other'), (err) => {
                        assert.equal(codeOf(err), 'AGENT_NAME_TAKEN')
                        assert.deepEqual(
                            (
                                (err as HttpException).getResponse() as {
                                    details?: unknown
                                }
                            ).details,
                            { agentId: 'agt_zeta' }
                        )
                        return true
                    })
                    await insertAgent('agt_eta', 'eta')
                    await assert.rejects(
                        claim('eta', 'fp'),
                        (err) => codeOf(err) === 'AGENT_NAME_TAKEN'
                    )
                    // Deleted since: the name is free for the same request.
                    await db.delete(agents).where(eq(agents.id, 'agt_zeta'))
                    assert.equal((await claim('zeta', 'fp')).kind, 'run')
                }
            )

            await t.test(
                'a resumed request follows its own create to its end and never starts another',
                async () => {
                    const resume = (
                        requestId: string,
                        name: string,
                        fingerprint = 'fp'
                    ) =>
                        service.claim({
                            userId: 'u1',
                            actorUserId: 'u1',
                            name,
                            fingerprint,
                            resume: requestId
                        })
                    const failed = await claim('iota', 'fp')
                    await settled(
                        service.run(failed.request, undefined, async () => {
                            throw new ConflictException({
                                message: 'no room',
                                code: 'RUNTIME_LIMIT_REACHED'
                            })
                        })
                    )
                    const again = await resume(failed.request.id, 'iota')
                    assert.equal(again.kind, 'attach')
                    assert.equal(again.request.id, failed.request.id)
                    assert.equal(
                        codeOf(
                            await settled(
                                service.follow(
                                    again.request.id,
                                    () => undefined
                                )
                            )
                        ),
                        'RUNTIME_LIMIT_REACHED'
                    )
                    const running = await claim('kappa', 'fp')
                    assert.equal(
                        (await resume(running.request.id, 'kappa')).request.id,
                        running.request.id
                    )
                    for (const [id, name, fingerprint] of [
                        [running.request.id, 'kappa', 'fp-other'],
                        [running.request.id, 'lambda', 'fp'],
                        ['acq_unknown', 'kappa', 'fp']
                    ])
                        await assert.rejects(
                            resume(id, name, fingerprint),
                            (err) => codeOf(err) === 'AGENT_CREATE_NOT_FOUND'
                        )
                    await assert.rejects(
                        service.claim({
                            userId: 'u2',
                            actorUserId: 'u2',
                            name: 'kappa',
                            fingerprint: 'fp',
                            resume: running.request.id
                        }),
                        (err) => codeOf(err) === 'AGENT_CREATE_NOT_FOUND'
                    )
                }
            )

            await t.test(
                "finished requests go a day later, on the owner's next claim",
                async () => {
                    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
                    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
                    const row = (
                        id: string,
                        userId: string,
                        status: 'in_progress' | 'succeeded' | 'failed',
                        updatedAt: Date
                    ) => ({
                        id,
                        userId,
                        actorUserId: userId,
                        name: id,
                        fingerprint: 'fp',
                        status,
                        createdAt: updatedAt,
                        updatedAt
                    })
                    await db
                        .insert(agentCreateRequests)
                        .values([
                            row('acq_old_ok', 'u1', 'succeeded', dayAgo),
                            row('acq_old_failed', 'u1', 'failed', dayAgo),
                            row('acq_old_running', 'u1', 'in_progress', dayAgo),
                            row('acq_recent', 'u1', 'failed', hourAgo),
                            row('acq_other_user', 'u2', 'succeeded', dayAgo)
                        ])
                    await claim('theta', 'fp')
                    const left = await db
                        .select({ id: agentCreateRequests.id })
                        .from(agentCreateRequests)
                        .where(
                            inArray(agentCreateRequests.id, [
                                'acq_old_ok',
                                'acq_old_failed',
                                'acq_old_running',
                                'acq_recent',
                                'acq_other_user'
                            ])
                        )
                    assert.deepEqual(left.map((r) => r.id).sort(), [
                        'acq_old_running',
                        'acq_other_user',
                        'acq_recent'
                    ])
                }
            )
        } finally {
            await db.$client.end({ timeout: 5 })
        }
    })
})
