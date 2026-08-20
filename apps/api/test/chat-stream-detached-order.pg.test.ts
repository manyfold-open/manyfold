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
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'

// Real-Postgres proof that detaching a non-terminal stream write from the
// adapter read loop does not cost ordering.
//
// The in-memory suite runs against a hand-written repo that never builds SQL,
// so it can only show that the write CHAIN keeps its tasks in order. What it
// cannot show is the half that matters to every cursor reader: that the rows
// those tasks write commit with ids in the same order, now that the producer
// no longer waits for each one. Only live PG exercises the single-statement
// insert, its per-session advisory lock and the id sequence together.
//
// Env-gated like the other *.pg.test.ts. Point it at a THROWAWAY database —
// it writes a few hundred rows and drops its fixture afterwards:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://user:pw@localhost:5432/scratch \
//     node --import tsx --test test/chat-stream-detached-order.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

// The measured shape this change exists for: an agentic turn whose tool_call
// and tool_result rows outnumber everything else.
const TOOL_PAIRS = 100

interface Harness {
    db: Database
    broadcaster: ChatSseBroadcaster
    sessionId: string
    messageId: string
    close: () => Promise<void>
}

const noopBus = {
    onMessage: () => undefined,
    onListenEstablished: () => undefined,
    notify: () => undefined
} as unknown as ChatStreamBus

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agt_pgtest_${suffix}`
    const sessionId = `cts_pgtest_${suffix}`
    const messageId = `cms_pgtest_${suffix}`

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'sprites'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'pgtest-agent',
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId,
        internalId: `internal-${agentId}`
    })
    await db.insert(chatSessions).values({ id: sessionId, userId, agentId })
    await db.insert(chatMessages).values({
        id: messageId,
        sessionId,
        role: 'assistant',
        contentBlocksJson: []
    })
    await db
        .update(chatSessions)
        .set({ inflightMessageId: messageId })
        .where(eq(chatSessions.id, sessionId))

    return {
        db,
        broadcaster: new ChatSseBroadcaster(new ChatRepository(db), noopBus),
        sessionId,
        messageId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

test(
    'detached tool rows commit in emit order with seq and id both monotonic',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            h.broadcaster.beginStream(h.sessionId, h.messageId)
            const emitted: string[] = []
            for (let i = 0; i < TOOL_PAIRS; i += 1) {
                // A token between each pair, exactly as the adapter loop
                // yields them, so the buffered path interleaves with the
                // detached one rather than being tested on its own.
                await h.broadcaster.emitDetached(h.messageId, {
                    type: 'token',
                    payload: { type: 'token', text: `t${i} ` },
                    sourceEventKey: `line-${i}`,
                    sourceEventOrdinal: 0
                })
                await h.broadcaster.emitDetached(h.messageId, {
                    type: 'tool_call',
                    payload: { type: 'tool_call', toolCallId: `call-${i}` },
                    sourceEventKey: `line-${i}`,
                    sourceEventOrdinal: 1
                })
                emitted.push(`call-${i}`)
                await h.broadcaster.emitDetached(h.messageId, {
                    type: 'tool_result',
                    payload: { type: 'tool_result', toolCallId: `call-${i}` },
                    sourceEventKey: `line-${i}`,
                    sourceEventOrdinal: 2
                })
                emitted.push(`result-${i}`)
            }
            const terminal = await h.broadcaster.emit(h.messageId, {
                type: 'done',
                payload: { type: 'done', finalMessageId: h.messageId },
                sourceEventKey: 'terminal',
                sourceEventOrdinal: 0
            })
            assert.equal(terminal.persisted, true)

            const rows = await h.db
                .select({
                    id: chatStreamEvents.id,
                    seq: chatStreamEvents.seq,
                    eventType: chatStreamEvents.eventType,
                    payloadJson: chatStreamEvents.payloadJson
                })
                .from(chatStreamEvents)
                .where(eq(chatStreamEvents.messageId, h.messageId))
                .orderBy(asc(chatStreamEvents.id))

            // Read back by id — the order every cursor reader (SSE pump,
            // Last-Event-ID resume, adoption replay) sees — and require seq
            // to rise with it. A write that committed out of order shows up
            // here as a seq that goes backwards while id goes forwards.
            for (let i = 1; i < rows.length; i += 1) {
                assert.ok(
                    rows[i].id > rows[i - 1].id,
                    `id not increasing at ${i}`
                )
                assert.ok(
                    rows[i].seq > rows[i - 1].seq,
                    `seq not increasing at ${i}: ${rows[i - 1].seq} then ${rows[i].seq}`
                )
            }
            assert.equal(rows.at(-1)?.eventType, 'done')
            assert.equal(
                rows.filter((row) => row.eventType === 'tool_call').length,
                TOOL_PAIRS
            )

            // Content order, not just seq order: the tool ids must come back
            // in the order the loop produced them.
            const seen = rows
                .filter(
                    (row) =>
                        row.eventType === 'tool_call' ||
                        row.eventType === 'tool_result'
                )
                .map((row) => {
                    const payload = row.payloadJson as {
                        type: string
                        toolCallId: string
                    }
                    const id = payload.toolCallId.replace('call-', '')
                    return payload.type === 'tool_call'
                        ? `call-${id}`
                        : `result-${id}`
                })
            assert.deepEqual(seen, emitted)
        } finally {
            await h.close()
        }
    }
)

// The same ordering question one step further out, on the terminal itself.
//
// A terminal's INSERT is a real round trip, and the producer feeding this
// stream does not stop for it: an offline cancel terminalizes a turn whose
// adapter is still yielding. Admission has to close when the terminal takes
// its place in the order, not when its row commits — otherwise the events
// produced during that round trip draw a seq and queue behind it, and the
// durable log ends `done, tool_call`. In memory that window is microseconds
// wide; against real PG it is milliseconds, so this is where the ordering
// claim is worth making. Only the durable table can answer it: `persisted`
// says a row landed, not that nothing landed after it (#701).
test(
    'no row commits after the terminal when the producer outruns its write',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            h.broadcaster.beginStream(h.sessionId, h.messageId)
            for (let i = 0; i < 5; i += 1)
                await h.broadcaster.emitDetached(h.messageId, {
                    type: 'tool_call',
                    payload: { type: 'tool_call', toolCallId: `early-${i}` },
                    sourceEventKey: `early-${i}`,
                    sourceEventOrdinal: 0
                })
            // Not awaited: everything below runs while this row is in flight.
            const terminal = h.broadcaster.emit(h.messageId, {
                type: 'done',
                payload: { type: 'done', finalMessageId: h.messageId },
                sourceEventKey: 'terminal',
                sourceEventOrdinal: 0
            })
            for (let i = 0; i < 5; i += 1) {
                await h.broadcaster.emitDetached(h.messageId, {
                    type: 'tool_call',
                    payload: { type: 'tool_call', toolCallId: `late-${i}` },
                    sourceEventKey: `late-${i}`,
                    sourceEventOrdinal: 0
                })
                await h.broadcaster.emitDetached(h.messageId, {
                    type: 'replace',
                    payload: { type: 'replace', text: `late-${i}` },
                    sourceEventKey: `late-${i}`,
                    sourceEventOrdinal: 1
                })
                // The buffered path too: a token accepted here would not
                // write inline, it would arm the merge window's flush timer
                // and land its row from a callback after the terminal.
                await h.broadcaster.emit(h.messageId, {
                    type: 'token',
                    payload: { type: 'token', text: `late-${i} ` },
                    sourceEventKey: `late-${i}`,
                    sourceEventOrdinal: 2
                })
            }
            assert.equal((await terminal).persisted, true)
            // Give a row that DID queue behind the terminal every chance to
            // commit, including one waiting on the 120ms flush timer. The
            // point is to catch it, so reading immediately would be the
            // weaker test.
            await new Promise((resolve) => setTimeout(resolve, 500))

            const rows = await h.db
                .select({
                    id: chatStreamEvents.id,
                    seq: chatStreamEvents.seq,
                    eventType: chatStreamEvents.eventType
                })
                .from(chatStreamEvents)
                .where(eq(chatStreamEvents.messageId, h.messageId))
                .orderBy(asc(chatStreamEvents.id))

            assert.deepEqual(
                rows.map((row) => row.eventType),
                [...Array.from({ length: 5 }, () => 'tool_call'), 'done'],
                'only the rows admitted before the terminal may exist'
            )
            assert.deepEqual(
                rows.map((row) => row.seq),
                [1, 2, 3, 4, 5, 6]
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a stale second writer terminalizes after admitted rows and closes both writers',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        const otherRepo = new ChatRepository(h.db)
        const other = new ChatSseBroadcaster(otherRepo, noopBus)
        try {
            // Both writers seed from the same empty log. The first writer then
            // commits seq 1, leaving the second writer's local seq stale.
            // Terminal seq allocation must happen under the database lock or
            // its local seq 1 collides instead of closing the turn.
            other.beginStream(h.sessionId, h.messageId)
            h.broadcaster.beginStream(h.sessionId, h.messageId)
            assert.equal(
                (
                    await h.broadcaster.emit(h.messageId, {
                        type: 'tool_call',
                        payload: {
                            type: 'tool_call',
                            toolCallId: 'admitted-first'
                        }
                    })
                ).persisted,
                true
            )
            assert.equal(
                (
                    await other.emit(
                        h.messageId,
                        {
                            type: 'error',
                            payload: {
                                type: 'error',
                                error: {
                                    code: 'cancelled_by_user',
                                    message: 'stopped',
                                    retryable: false
                                }
                            }
                        },
                        {
                            contentBlocksJson: [
                                { type: 'text', text: 'winner' }
                            ],
                            contentCheckpointEventId: null
                        }
                    )
                ).persisted,
                true
            )

            assert.deepEqual(
                await otherRepo.writeAssistantContent(
                    h.messageId,
                    [{ type: 'text', text: 'late checkpoint' }],
                    999n
                ),
                // Refused because the terminal already landed, not because the
                // turn moved owner (#570): this writer holds no fence at all.
                { written: false, fenceLost: false },
                'a checkpoint writer that observes the terminal must not replace its content'
            )

            await h.broadcaster.emitDetached(h.messageId, {
                type: 'tool_call',
                payload: { type: 'tool_call', toolCallId: 'late' }
            })
            assert.equal(
                (
                    await h.broadcaster.emit(h.messageId, {
                        type: 'done',
                        payload: {
                            type: 'done',
                            finalMessageId: h.messageId
                        }
                    })
                ).persisted,
                false
            )

            const rows = await h.db
                .select({
                    seq: chatStreamEvents.seq,
                    eventType: chatStreamEvents.eventType
                })
                .from(chatStreamEvents)
                .where(eq(chatStreamEvents.messageId, h.messageId))
                .orderBy(asc(chatStreamEvents.id))
            assert.deepEqual(
                rows.map((row) => [row.seq, row.eventType]),
                [
                    [1, 'tool_call'],
                    [2, 'error']
                ]
            )
            const [message] = await h.db
                .select({
                    contentBlocksJson: chatMessages.contentBlocksJson,
                    contentCheckpointEventId:
                        chatMessages.contentCheckpointEventId
                })
                .from(chatMessages)
                .where(eq(chatMessages.id, h.messageId))
            assert.deepEqual(message?.contentBlocksJson, [
                { type: 'text', text: 'winner' }
            ])
            assert.equal(message?.contentCheckpointEventId, null)
        } finally {
            other.onModuleDestroy()
            await h.close()
        }
    }
)

// A detached write is the one write nobody is waiting on, so a failure has to
// be contained by the chain alone. The seq unique index is the cheapest way to
// make a real statement fail for real: it is a DIFFERENT index from the
// source-key dedup one the insert's ON CONFLICT names, so the collision throws
// instead of quietly returning no id.
//
// What is being proved is the resume cursor, against the real query.
// exactResumeSeqForMessage() is max(runner_seq) over the message's rows, and
// its documented premise is that a durable row proves everything before it is
// durable. Detaching breaks that premise unless the rows queued behind a
// failed one are abandoned — otherwise the cursor walks past content that
// never landed and a runner resume skips it for good.
test(
    'a failed detached write does not let the resume cursor pass it',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        const repo = new ChatRepository(h.db)
        try {
            await repo.insertStreamEvent({
                sessionId: h.sessionId,
                messageId: h.messageId,
                seq: 5,
                eventType: 'token',
                payloadJson: { type: 'token', text: 'planted' },
                sourceEventKey: 'pre-planted',
                sourceEventOrdinal: 0,
                runnerSeq: null
            })
            h.broadcaster.beginStream(h.sessionId, h.messageId)
            // Every emit is admitted before the chain reaches the one that
            // collides, which is exactly the window the abandon rule closes.
            for (let i = 1; i <= 10; i += 1)
                await h.broadcaster.emitDetached(h.messageId, {
                    type: 'tool_call',
                    payload: { type: 'tool_call', toolCallId: `call-${i}` },
                    sourceEventKey: `line-${i}`,
                    sourceEventOrdinal: 0,
                    runnerSeq: 100 + i
                })
            const terminal = await h.broadcaster.emit(h.messageId, {
                type: 'done',
                payload: { type: 'done', finalMessageId: h.messageId },
                sourceEventKey: 'terminal',
                sourceEventOrdinal: 0
            })
            assert.equal(
                terminal.persisted,
                true,
                'the terminal must still land behind a failed write'
            )

            const rows = (
                await h.db
                    .select({
                        seq: chatStreamEvents.seq,
                        eventType: chatStreamEvents.eventType,
                        runnerSeq: chatStreamEvents.runnerSeq,
                        sourceEventKey: chatStreamEvents.sourceEventKey
                    })
                    .from(chatStreamEvents)
                    .where(eq(chatStreamEvents.messageId, h.messageId))
                    .orderBy(asc(chatStreamEvents.id))
            ).filter((row) => row.sourceEventKey !== 'pre-planted')

            assert.deepEqual(
                rows.map((row) => row.seq),
                [1, 2, 3, 4, 6],
                'seq 5 collided; 6..10 were queued behind it and only the terminal may still land'
            )
            assert.equal(rows.at(-1)?.eventType, 'done')
            assert.equal(
                await repo.exactResumeSeqForMessage(h.messageId),
                104,
                'the cursor must stop at the last row that actually landed'
            )
        } finally {
            await h.close()
        }
    }
)
