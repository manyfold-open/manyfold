import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
    a2aTasks,
    agentRuntimes,
    agents,
    chatMessages,
    chatSessions,
    createDb,
    users
} from '@manyfold/db'
import type { MessageSendParams } from '@manyfold/a2a'
import { withScratchDatabase } from '../scripts/scratch-db'
import { A2aService, type A2aAuthContext } from '../src/modules/a2a/a2a.service'
import { A2aTaskRepository } from '../src/modules/a2a/a2a-task.repository'
import { ChatService } from '../src/modules/chat/chat.service'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { ApiTokenService } from '../src/modules/auth/api-token.service'

const RUN = process.env.RUN_PG_E2E === '1'

test(
    'concurrent A2A retries share one committed task/session and remain caller scoped',
    { skip: !RUN },
    async () => {
        await withScratchDatabase('a2a_retry', async ({ url }) => {
            const db = createDb(url, { max: 4 })
            try {
                await db
                    .insert(users)
                    .values({ id: 'u', email: 'a2a@example.test' })
                await db
                    .insert(agentRuntimes)
                    .values({
                        id: 'runtime',
                        userId: 'u',
                        name: 'runtime',
                        framework: 'codex',
                        kind: 'sprites'
                    })
                for (const id of ['caller', 'caller2', 'target'])
                    await db
                        .insert(agents)
                        .values({
                            id,
                            userId: 'u',
                            name: id,
                            framework: 'codex',
                            runtime: 'sprites',
                            runtimeId: 'runtime',
                            internalId: id
                        })
                let turns = 0
                let announcements = 0
                const chat = Object.assign(
                    Object.create(ChatService.prototype) as ChatService,
                    {
                        db,
                        repo: new ChatRepository(db),
                        announceSessionCreated: () => {
                            announcements++
                        },
                        sendMessage: async (
                            ...args: Parameters<ChatService['sendMessage']>
                        ) => {
                            turns++
                            const userId = randomUUID(),
                                assistantId = randomUUID()
                            await db.insert(chatMessages).values([
                                {
                                    id: userId,
                                    sessionId: args[2],
                                    role: 'user',
                                    contentBlocksJson: []
                                },
                                {
                                    id: assistantId,
                                    sessionId: args[2],
                                    role: 'assistant',
                                    contentBlocksJson: []
                                }
                            ])
                            args[13]?.({ type: 'token', text: 'answer' })
                            args[13]?.({
                                type: 'done',
                                finalMessageId: assistantId
                            })
                            return {
                                userMessage: { id: userId },
                                assistantMessageId: assistantId
                            }
                        }
                    }
                )
                const service = () =>
                    new A2aService(db, chat, new A2aTaskRepository(db))
                const ctx: A2aAuthContext = {
                    userId: 'u',
                    targetAgentId: 'target',
                    callerAgentId: 'caller',
                    externalSubject: null
                }
                const input: MessageSendParams = {
                    message: {
                        kind: 'message',
                        role: 'user',
                        messageId: 'retry-me',
                        parts: [{ kind: 'text', text: 'work' }]
                    }
                }
                const results = await Promise.all(
                    Array.from({ length: 12 }, () =>
                        service().sendMessage(ctx, input)
                    )
                )
                assert.equal(
                    new Set(results.map((result) => result.id)).size,
                    1
                )
                assert.equal(turns, 1)
                assert.equal(announcements, 1)
                assert.equal((await db.select().from(chatSessions)).length, 1)
                assert.equal((await db.select().from(a2aTasks)).length, 1)
                assert.equal(
                    (await service().sendMessage(ctx, input)).id,
                    results[0].id
                )

                const second = await service().sendMessage(
                    { ...ctx, callerAgentId: 'caller2' },
                    input
                )
                assert.notEqual(second.id, results[0].id)
                const external = await service().sendMessage(
                    {
                        ...ctx,
                        callerAgentId: null,
                        externalSubject: 'external-client'
                    },
                    input
                )
                assert.notEqual(external.id, results[0].id)
                await assert.rejects(
                    service().sendMessage(
                        { ...ctx, callerAgentId: 'caller2' },
                        {
                            message: {
                                ...input.message,
                                messageId: 'other',
                                contextId: results[0].contextId
                            }
                        }
                    ),
                    /task or context not found/
                )
                assert.equal(turns, 3)

                const tokens = new ApiTokenService(db)
                const [grant] = await tokens.mintA2aGrants({
                    userId: 'u',
                    targetAgentId: 'target',
                    callerAgentIds: ['caller']
                })
                await tokens.revokeA2aGrant({
                    userId: 'u',
                    targetAgentId: 'target',
                    tokenId: grant.tokenId
                })
                assert.equal(
                    await tokens.isActiveA2aGrant('caller', 'target'),
                    false
                )
            } finally {
                await db.$client.end({ timeout: 5 })
            }
        })
    }
)
