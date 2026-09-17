import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    createDb,
    users,
    agents,
    agentRuntimes,
    chatMessages,
    chatSessions,
    turnExecutions
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { TurnFenceLostError } from '../src/modules/chat/turn-fence'
import {
    priceScopeFromMetadata,
    UNKNOWN_PRICE_SCOPE
} from '../src/modules/usage/served-price-scope'

test(
    'served price metadata is immutable across restart, edits, and ownership transitions',
    {
        skip: process.env.RUN_PG_E2E !== '1' && 'RUN_PG_E2E!=1'
    },
    async () => {
        const db = createDb(process.env.DATABASE_URL!)
        const suffix = randomUUID()
        const userId = `user_scope_${suffix}`,
            runtimeId = `art_scope_${suffix}`
        const agentId = `agt_scope_${suffix}`,
            sessionId = `session_scope_${suffix}`,
            messageId = `message_scope_${suffix}`
        try {
            await db
                .insert(users)
                .values({ id: userId, email: `${suffix}@fixture.invalid` })
            await db
                .insert(agentRuntimes)
                .values({
                    id: runtimeId,
                    userId,
                    name: 'scope fixture',
                    framework: 'codex',
                    kind: 'daemon'
                })
            await db
                .insert(agents)
                .values({
                    id: agentId,
                    userId,
                    runtimeId,
                    name: 'scope fixture',
                    framework: 'codex',
                    runtime: 'daemon',
                    internalId: suffix
                })
            await db
                .insert(chatSessions)
                .values({
                    id: sessionId,
                    userId,
                    agentId,
                    inflightMessageId: messageId
                })
            await db
                .insert(chatMessages)
                .values({
                    id: messageId,
                    sessionId,
                    role: 'assistant',
                    contentBlocksJson: [],
                    capabilityEventsJson: { model: 'shared-model' }
                })
            await db
                .insert(turnExecutions)
                .values({
                    messageId,
                    sessionId,
                    agentId,
                    runtime: 'daemon',
                    ownerId: 'first-owner',
                    generation: 1,
                    state: 'running',
                    leaseExpiresAt: new Date(Date.now() + 60000)
                })
            const first = new ChatRepository(db)
            const original = {
                modelProviderId: 'original-provider',
                modelProviderBuiltInId: null,
                modelProviderManagedBrand: 'google'
            }
            const different = {
                modelProviderId: 'replacement-provider',
                modelProviderBuiltInId: null,
                modelProviderManagedBrand: 'antigravity'
            }
            const fence = { messageId, ownerId: 'first-owner', generation: 1 }
            await first.stampTurnPriceScope(
                messageId,
                sessionId,
                original,
                fence
            )
            await first.stampTurnPriceScope(
                messageId,
                sessionId,
                original,
                fence
            )
            await assert.rejects(
                first.stampTurnPriceScope(
                    messageId,
                    sessionId,
                    different,
                    fence
                ),
                /cannot change/
            )
            await assert.rejects(
                first.stampTurnPriceScope(messageId, sessionId, different),
                TurnFenceLostError
            )
            await assert.rejects(
                first.mergeMessageMetadata(
                    messageId,
                    sessionId,
                    { pricingScope: different },
                    fence
                ),
                /stamped once/
            )
            await first.mergeMessageMetadata(
                messageId,
                sessionId,
                { contextUsage: { used: 10, size: 100 } },
                fence
            )
            await db
                .update(turnExecutions)
                .set({ ownerId: 'second-owner', generation: 2 })
                .where(eq(turnExecutions.messageId, messageId))
            const restarted = new ChatRepository(db)
            await assert.rejects(
                restarted.stampTurnPriceScope(
                    messageId,
                    sessionId,
                    different,
                    fence
                ),
                TurnFenceLostError
            )
            await assert.rejects(
                restarted.stampTurnPriceScope(messageId, sessionId, different, {
                    ...fence,
                    ownerId: 'second-owner',
                    generation: 2
                }),
                /cannot change/
            )
            const message = await restarted.getMessageById(messageId)
            assert.deepEqual(
                priceScopeFromMetadata(message?.capabilityEventsJson),
                original
            )
            assert.deepEqual(
                (message?.capabilityEventsJson as Record<string, unknown>)
                    .contextUsage,
                { used: 10, size: 100 }
            )
            assert.equal(
                (message?.capabilityEventsJson as Record<string, unknown>)
                    .model,
                'shared-model'
            )
            assert.deepEqual(
                priceScopeFromMetadata({ model: 'old-turn' }),
                UNKNOWN_PRICE_SCOPE
            )
            for (const scenario of ['cancelled', 'replaced'] as const) {
                const lateId = `message_${scenario}_${suffix}`
                await db
                    .insert(chatMessages)
                    .values({
                        id: lateId,
                        sessionId,
                        role: 'assistant',
                        contentBlocksJson: []
                    })
                await db
                    .update(chatSessions)
                    .set({ inflightMessageId: lateId })
                    .where(eq(chatSessions.id, sessionId))
                if (scenario === 'cancelled') {
                    await restarted.insertStreamEvent({
                        messageId: lateId,
                        sessionId,
                        seq: 1,
                        eventType: 'error',
                        payloadJson: { error: { code: 'cancelled_by_user' } }
                    })
                } else {
                    await db
                        .update(chatSessions)
                        .set({ inflightMessageId: messageId })
                        .where(eq(chatSessions.id, sessionId))
                }
                await assert.rejects(
                    restarted.stampTurnPriceScope(lateId, sessionId, original),
                    TurnFenceLostError
                )
                assert.deepEqual(
                    priceScopeFromMetadata(
                        (await restarted.getMessageById(lateId))
                            ?.capabilityEventsJson
                    ),
                    UNKNOWN_PRICE_SCOPE
                )
            }
        } finally {
            await db.delete(users).where(eq(users.id, userId))
            await db.$client.end()
        }
    }
)
