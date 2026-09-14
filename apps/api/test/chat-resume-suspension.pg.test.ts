import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { asc, eq } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    chatMessages,
    chatSessions,
    chatStreamEvents,
    createDb,
    turnExecutions,
    users
} from '@manyfold/db'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'
import { ChatService } from '../src/modules/chat/chat.service'
import { buildChatMessageSourceRow } from '../src/modules/chat/raw-message-source'

const RUN = process.env.RUN_PG_E2E === '1'
const noopBus = {
    onMessage: () => undefined,
    onListenEstablished: () => undefined,
    notify: () => undefined
} as unknown as ChatStreamBus

test(
    'replayed output cannot deduplicate a new suspension or release its inflight turn',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        if (!url) throw new Error('DATABASE_URL must be set')
        const db = createDb(url)
        const suffix = randomBytes(8).toString('hex')
        const userId = `user_pgtest_${suffix}`
        const runtimeId = `art_pgtest_${suffix}`
        const agentId = `agt_pgtest_${suffix}`
        const sessionId = `cts_pgtest_${suffix}`
        const messageId = `msg_pgtest_${suffix}`
        const repo = new ChatRepository(db)
        const broadcaster = new ChatSseBroadcaster(repo, noopBus)
        const telemetry: Array<{
            name: string
            attrs: Record<string, unknown>
        }> = []
        let finish = false
        const source = {
            sourceRef: 'framework-session',
            sourceSeq: 1,
            externalId: 'same-output-uuid',
            parentExternalId: null,
            rawFormat: 'jsonl' as const,
            rawText: '{"type":"assistant","uuid":"same-output-uuid"}',
            parserName: 'claude-code-stream-json',
            parserVersion: '1'
        }
        const adapter = {
            resumeMessage: async function* (): AsyncIterable<EmittedChatEvent> {
                yield { type: 'raw_source', source }
                yield { type: 'token', text: 'prefix' }
                if (!finish) {
                    yield {
                        type: 'suspended',
                        daemonId: 'daemon-fixture',
                        daemonExecRef: 'exec-fixture',
                        reason: 'connection closed'
                    }
                    return
                }
                yield {
                    type: 'raw_source',
                    source: {
                        ...source,
                        sourceSeq: 2,
                        externalId: 'new-output-uuid',
                        rawText: '{"type":"assistant","uuid":"new-output-uuid"}'
                    }
                }
                yield { type: 'token', text: ' tail' }
                yield { type: 'done', finalMessageId: messageId }
            }
        }
        const service = new ChatService(
            db,
            repo,
            broadcaster,
            { get: () => adapter } as never,
            { record: async () => {} } as never,
            {} as never,
            { publishStatus: () => {} } as never,
            {
                event: (name: string, attrs: Record<string, unknown>) =>
                    telemetry.push({ name, attrs }),
                error: () => {}
            } as never,
            undefined as never,
            undefined as never,
            undefined as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { ownerId: 'resume-owner', enabled: true } as never
        )
        try {
            await db
                .insert(users)
                .values({ id: userId, email: `${suffix}@pgtest.local` })
            await db.insert(agentRuntimes).values({
                id: runtimeId,
                userId,
                name: `runtime-${suffix}`,
                framework: 'claude-code',
                kind: 'daemon'
            })
            await db.insert(agents).values({
                id: agentId,
                userId,
                name: 'suspension-fixture',
                framework: 'claude-code',
                runtime: 'daemon',
                runtimeId,
                internalId: agentId
            })
            await db
                .insert(chatSessions)
                .values({ id: sessionId, userId, agentId })
            await db.insert(chatMessages).values({
                id: messageId,
                sessionId,
                role: 'assistant',
                daemonId: 'daemon-fixture',
                daemonExecRef: 'exec-fixture',
                contentBlocksJson: [{ type: 'text', text: 'prefix' }]
            })
            await db
                .update(chatSessions)
                .set({ inflightMessageId: messageId })
                .where(eq(chatSessions.id, sessionId))
            await db.insert(turnExecutions).values({
                messageId,
                sessionId,
                agentId,
                runtime: 'daemon',
                ownerId: 'dispatch-owner',
                generation: 1,
                state: 'handoff',
                leaseExpiresAt: new Date(0)
            })
            const raw = buildChatMessageSourceRow({
                sourceKind: 'live_stream',
                sessionId,
                messageId,
                framework: 'claude-code',
                runtime: 'daemon',
                source
            })
            await repo.upsertMessageSources([raw])
            // A turn started by the previous version may already have this identity.
            await db.insert(chatStreamEvents).values([
                {
                    sessionId,
                    messageId,
                    seq: 1,
                    eventType: 'token',
                    payloadJson: { type: 'token', text: 'prefix' },
                    sourceEventKey: raw.sourceEventKey,
                    sourceEventOrdinal: 0
                },
                {
                    sessionId,
                    messageId,
                    seq: 2,
                    eventType: 'suspended',
                    payloadJson: {
                        daemonId: 'daemon-fixture',
                        daemonExecRef: 'exec-fixture',
                        reason: 'connection closed'
                    },
                    sourceEventKey: raw.sourceEventKey,
                    sourceEventOrdinal: 1
                }
            ])
            const rows = () =>
                db
                    .select()
                    .from(chatStreamEvents)
                    .where(eq(chatStreamEvents.messageId, messageId))
                    .orderBy(asc(chatStreamEvents.id))
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const message = await repo.getMessageById(messageId)
                assert.ok(message)
                await service.resumeAssistantTurn({
                    message,
                    daemonId: 'daemon-fixture',
                    refId: 'exec-fixture'
                })
                const events = await rows()
                assert.equal(
                    events.filter((e) =>
                        ['done', 'error'].includes(e.eventType)
                    ).length,
                    0
                )
                assert.equal(
                    events.filter((e) => e.eventType === 'suspended').length,
                    attempt + 2
                )
                assert.equal(events.at(-1)?.eventType, 'suspended')
                assert.equal(events.at(-1)?.sourceEventKey, null)
                assert.equal(
                    (await repo.getSessionById(sessionId))?.inflightMessageId,
                    messageId
                )
                assert.equal(
                    (await repo.getTurnExecution(messageId))?.state,
                    'handoff'
                )
                await db
                    .update(turnExecutions)
                    .set({ leaseExpiresAt: new Date(0) })
                    .where(eq(turnExecutions.messageId, messageId))
            }
            finish = true
            const message = await repo.getMessageById(messageId)
            assert.ok(message)
            await service.resumeAssistantTurn({
                message,
                daemonId: 'daemon-fixture',
                refId: 'exec-fixture'
            })
            const events = await rows()
            assert.deepEqual(
                events
                    .filter((e) => e.eventType === 'turn_status')
                    .map((e) => e.sourceEventOrdinal),
                [0, 1, 2]
            )
            assert.equal(
                events.filter((e) => ['done', 'error'].includes(e.eventType))
                    .length,
                1
            )
            assert.equal(events.at(-1)?.eventType, 'done')
            assert.equal(
                (await repo.getSessionById(sessionId))?.inflightMessageId,
                null
            )
            assert.deepEqual(
                (await repo.getMessageById(messageId))?.contentBlocksJson,
                [{ type: 'text', text: 'prefix tail' }]
            )
            assert.equal(
                telemetry.filter((e) => e.name === 'chat.turn.terminal').length,
                1
            )
        } finally {
            broadcaster.onModuleDestroy()
            await db.delete(users).where(eq(users.id, userId))
            await (
                db as unknown as { $client: { end: () => Promise<void> } }
            ).$client.end()
        }
    }
)
