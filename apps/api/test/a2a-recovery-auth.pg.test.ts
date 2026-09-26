import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { ConfigService } from '@nestjs/config'
import {
    a2aTasks,
    agentRuntimes,
    agents,
    auditLogs,
    chatMessages,
    chatSessions,
    chatStreamEvents,
    createDb,
    jsonbMerge,
    users,
    type Database
} from '@manyfold/db'
import type { A2aStreamEvent } from '@manyfold/a2a'
import { withScratchDatabase } from '../scripts/scratch-db'
import { A2aService, type A2aAuthContext } from '../src/modules/a2a/a2a.service'
import { A2aRpcController } from '../src/modules/a2a/a2a-rpc.controller'
import { A2aTaskRepository } from '../src/modules/a2a/a2a-task.repository'
import { A2aTicketService } from '../src/modules/a2a/a2a-ticket.service'
import { ApiTokenService } from '../src/modules/auth/api-token.service'
import { ChatService } from '../src/modules/chat/chat.service'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { CryptoService } from '../src/modules/secrets/crypto.service'

const RUN = process.env.RUN_PG_E2E === '1'
const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
const ctx: A2aAuthContext = {
    userId: 'owner',
    targetAgentId: 'target',
    callerAgentId: 'caller',
    externalSubject: null
}

test(
    'A2A owner deactivation, atomic exposure and recovered terminals on PostgreSQL',
    { skip: !RUN },
    async (t) => {
        await withScratchDatabase('a2a_recovery', async ({ url }) => {
            const db = createDb(url, { max: 4 })
            try {
                await db
                    .insert(users)
                    .values({ id: 'owner', email: 'owner@example.test' })
                await db.insert(agentRuntimes).values({
                    id: 'runtime',
                    userId: 'owner',
                    name: 'runtime',
                    framework: 'codex',
                    kind: 'sprites'
                })
                for (const id of ['caller', 'target'])
                    await db.insert(agents).values({
                        id,
                        userId: 'owner',
                        name: id,
                        framework: 'codex',
                        runtime: 'sprites',
                        runtimeId: 'runtime',
                        internalId: id,
                        extras: {
                            a2aExposure: { enabled: true },
                            modelConfig: { source: 'platform' }
                        }
                    })
                const tasks = new A2aTaskRepository(db)
                const chat = Object.assign(
                    Object.create(ChatService.prototype),
                    {
                        repo: new ChatRepository(db)
                    }
                ) as ChatService
                const service = () => new A2aService(db, chat, tasks)

                await t.test(
                    'a previously minted peer ticket is refused immediately after owner deactivation',
                    async () => {
                        const tokens = new ApiTokenService(db)
                        await tokens.mintA2aGrants({
                            userId: 'owner',
                            targetAgentId: 'target',
                            callerAgentIds: ['caller']
                        })
                        const tickets = new A2aTicketService(
                            new CryptoService(
                                new ConfigService({
                                    API_CRYPTO_KEY: Buffer.alloc(
                                        32,
                                        19
                                    ).toString('base64')
                                })
                            )
                        )
                        const { ticket } = tickets.sign({
                            userId: 'owner',
                            callerAgentId: 'caller',
                            targetAgentId: 'target'
                        })
                        let dispatched = 0
                        const rpc = new A2aRpcController(
                            {
                                getExposure: (id: string) =>
                                    service().getExposure(id),
                                getTask: async () => {
                                    dispatched++
                                    return { kind: 'task' }
                                }
                            } as never,
                            {
                                verifyBearerToken: async () => {
                                    throw new Error(
                                        'tickets do not use API credentials'
                                    )
                                }
                            } as never,
                            { assertAndIncrement: async () => {} } as never,
                            { consume: () => {} } as never,
                            tokens,
                            tickets
                        )
                        const call = async () => {
                            let status = 0
                            const reply = {
                                status: (code: number) => {
                                    status = code
                                    return reply
                                },
                                send: () => {}
                            }
                            await rpc.rpc(
                                'target',
                                {
                                    jsonrpc: '2.0',
                                    id: 1,
                                    method: 'tasks/get',
                                    params: { id: 'task' }
                                },
                                {
                                    headers: {
                                        authorization: `Bearer ${ticket}`
                                    }
                                } as never,
                                reply as never
                            )
                            return status
                        }
                        assert.equal(await call(), 200)
                        await db
                            .update(users)
                            .set({ deactivatedAt: new Date() })
                            .where(eq(users.id, 'owner'))
                        assert.equal(await call(), 403)
                        assert.equal(dispatched, 1)
                        await db
                            .update(users)
                            .set({ deactivatedAt: null })
                            .where(eq(users.id, 'owner'))
                    }
                )

                await t.test(
                    'exposure cannot overwrite a model or delivery update committed after its read',
                    async () => {
                        const read = deferred(),
                            release = deferred()
                        const paused = {
                            select: () => ({
                                from: () => ({
                                    where: () => ({
                                        limit: async () => {
                                            const snapshot = await db
                                                .select({
                                                    extras: agents.extras
                                                })
                                                .from(agents)
                                                .where(eq(agents.id, 'target'))
                                            read.resolve()
                                            await release.promise
                                            return snapshot
                                        }
                                    })
                                })
                            }),
                            update: db.update.bind(db)
                        } as unknown as Pick<Database, 'select' | 'update'>
                        const update = service().setExposure(
                            'target',
                            { enabled: false },
                            paused
                        )
                        await read.promise
                        await db
                            .update(agents)
                            .set({
                                extras: jsonbMerge(agents.extras, {
                                    modelConfig: { source: 'runtime-local' },
                                    mcpDeliveryRevision: 'new-revision'
                                })
                            })
                            .where(eq(agents.id, 'target'))
                        release.resolve()
                        await update
                        const [row] = await db
                            .select()
                            .from(agents)
                            .where(eq(agents.id, 'target'))
                        const extras = row.extras as Record<string, unknown>
                        assert.deepEqual(extras.modelConfig, {
                            source: 'runtime-local'
                        })
                        assert.equal(extras.mcpDeliveryRevision, 'new-revision')
                        assert.equal(
                            (extras.a2aExposure as { enabled: boolean })
                                .enabled,
                            false
                        )
                    }
                )

                const recovered = async (
                    id: string,
                    result: 'done' | 'failed' | 'canceled'
                ) => {
                    await db.insert(chatSessions).values({
                        id: `session-${id}`,
                        userId: 'owner',
                        agentId: 'target'
                    })
                    await db.insert(chatMessages).values({
                        id: `message-${id}`,
                        sessionId: `session-${id}`,
                        role: 'assistant',
                        contentBlocksJson: [
                            { type: 'text', text: `answer-${id}` }
                        ]
                    })
                    await db.insert(chatStreamEvents).values({
                        sessionId: `session-${id}`,
                        messageId: `message-${id}`,
                        seq: 1,
                        eventType: result === 'done' ? 'done' : 'error',
                        payloadJson:
                            result === 'done'
                                ? {}
                                : {
                                      error: {
                                          code:
                                              result === 'canceled'
                                                  ? 'cancelled_by_user'
                                                  : 'provider_failed',
                                          message: result
                                      }
                                  }
                    })
                    await tasks.create({
                        id,
                        ...ctx,
                        contextId: `context-${id}`,
                        chatSessionId: `session-${id}`,
                        clientMessageId: id
                    })
                    await db
                        .update(a2aTasks)
                        .set({
                            state: 'working',
                            assistantMessageId: `message-${id}`,
                            updatedAt: new Date(Date.now() - 8_000_000)
                        })
                        .where(eq(a2aTasks.id, id))
                }
                for (const [result, expected] of [
                    ['done', 'completed'],
                    ['failed', 'failed'],
                    ['canceled', 'canceled']
                ] as const) {
                    await t.test(
                        `a fresh service recovers ${result} without replaying the prompt`,
                        async () => {
                            await recovered(result, result)
                            const task = await service().getTask(ctx, result)
                            assert.equal(task.status.state, expected)
                            if (result === 'done')
                                assert.deepEqual(task.artifacts?.[0]?.parts, [
                                    { kind: 'text', text: `answer-${result}` }
                                ])
                            else
                                assert.equal(
                                    task.status.message?.parts[0]?.kind,
                                    'text'
                                )
                            assert.equal(
                                (await service().getTask(ctx, result)).status
                                    .state,
                                expected
                            )
                            const audit = await db
                                .select()
                                .from(auditLogs)
                                .where(eq(auditLogs.subject, result))
                            assert.equal(audit.length, 1)
                        }
                    )
                }
                await t.test(
                    'resubscribe and stale sweep recover durable results instead of orphaning them',
                    async () => {
                        await recovered('resubscribe', 'done')
                        const events: A2aStreamEvent[] = []
                        await service().resubscribe(
                            ctx,
                            'resubscribe',
                            (event) => events.push(event)
                        )
                        assert.ok(
                            events.some(
                                (event) =>
                                    event.kind === 'status-update' &&
                                    event.final &&
                                    event.status.state === 'completed'
                            )
                        )
                        await recovered('sweep', 'done')
                        await (
                            service() as unknown as {
                                sweepStaleTasks(): Promise<void>
                            }
                        ).sweepStaleTasks()
                        const [row] = await db
                            .select()
                            .from(a2aTasks)
                            .where(eq(a2aTasks.id, 'sweep'))
                        assert.equal(row.state, 'completed')
                        assert.equal(row.errorJson, null)
                    }
                )
                await t.test(
                    'task lists recover results while preserving their state filter',
                    async () => {
                        await recovered('listed', 'done')
                        const working = await service().listTasks(ctx, {
                            state: 'working'
                        })
                        assert.ok(
                            !working.tasks.some((task) => task.id === 'listed')
                        )
                        const completed = await service().listTasks(ctx, {
                            state: 'completed'
                        })
                        assert.ok(
                            completed.tasks.some((task) => task.id === 'listed')
                        )
                        await recovered('owner-list', 'done')
                        const owned = await service().listAgentTasks(
                            'owner',
                            'target',
                            {}
                        )
                        assert.equal(
                            owned.tasks.find((task) => task.id === 'owner-list')
                                ?.state,
                            'completed'
                        )
                    }
                )
                await t.test(
                    'a cancellation committed during reconciliation keeps its terminal state',
                    async () => {
                        await recovered('race', 'done')
                        const read = deferred(),
                            release = deferred()
                        const racingChat = {
                            getTurnOutcome: async (id: string) => {
                                const outcome = await chat.getTurnOutcome(id)
                                read.resolve()
                                await release.promise
                                return outcome
                            }
                        } as ChatService
                        const reading = new A2aService(
                            db,
                            racingChat,
                            tasks
                        ).getTask(ctx, 'race')
                        await read.promise
                        await tasks.updateIfActive('race', {
                            state: 'canceled',
                            completedAt: new Date()
                        })
                        release.resolve()
                        assert.equal((await reading).status.state, 'canceled')
                        const [row] = await db
                            .select()
                            .from(a2aTasks)
                            .where(eq(a2aTasks.id, 'race'))
                        assert.equal(row.artifactJson, null)
                    }
                )
            } finally {
                await db.$client.end({ timeout: 5 })
            }
        })
    }
)
