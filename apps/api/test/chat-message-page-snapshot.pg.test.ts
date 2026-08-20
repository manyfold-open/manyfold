import type { ChatStreamEvent } from '@manyfold/shared'
import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
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
import { ChatService } from '../src/modules/chat/chat.service'
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'

// Real-Postgres proof for #723, where the in-memory suite runs out of things
// it can honestly claim.
//
// The bug was three reads answering one message-page request — the rows, the
// terminal errors, the inflight turn — each under its own READ COMMITTED
// snapshot. A turn terminating between the first and the third produced a
// response describing two instants: a PRE-terminal partial assistant row,
// paired with a POST-terminal "nothing is inflight". A tab that took that
// answer had half a reply rendered as settled history and no turn named to
// replay, and a bare attach made after the terminal starts past it, so
// nothing short of a reload ever finished the message.
//
// The fix runs those reads inside one REPEATABLE READ READ ONLY transaction.
// That is a claim about Postgres snapshot semantics, and a fake repository is
// exactly the wrong instrument for it: modelling "the snapshot holds" in
// JavaScript is assuming the conclusion. So these tests interleave a real
// commit from a SECOND connection into the middle of a real read, in the
// order runAdapter commits it — final content first, terminal row second —
// and ask what the reading transaction sees.
//
// The control at the end runs the same interleaving WITHOUT the snapshot and
// reproduces the original wrong answer, which is what makes the rest evidence
// rather than assertion.
//
// Env-gated like the other *.pg.test.ts. Point it at a THROWAWAY database —
// it writes a handful of rows and drops its fixture afterwards:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://user:pw@localhost:5432/scratch \
//     node --import tsx --test test/chat-message-page-snapshot.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

const PARTIAL = [{ type: 'text', text: 'half an ans' }]
const FINAL = [{ type: 'text', text: 'half an answer, and then the rest.' }]

interface Harness {
    db: Database
    repo: ChatRepository
    writer: Database
    userId: string
    agentId: string
    sessionId: string
    assistantId: string
    checkpointId: bigint
    close: () => Promise<void>
}

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

// A session parked exactly where the race needs it: an assistant turn with
// partial content, a checkpoint cursor describing that content, and no
// terminal row yet — so latestInflightMessageId() names it.
const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set')
    const db = createDb(url)
    // The turn's owner. A separate pool, because the whole point is a commit
    // landing from a connection the reader is not sharing.
    const writer = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agt_pgtest_${suffix}`
    const sessionId = `cts_pgtest_${suffix}`
    const userMessageId = `cmg_pgtest_u_${suffix}`
    const assistantId = `cmg_pgtest_a_${suffix}`

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
        id: userMessageId,
        sessionId,
        role: 'user',
        contentBlocksJson: [{ type: 'text', text: 'ask' }],
        createdAt: new Date('2026-04-30T00:00:00Z')
    })
    await db.insert(chatMessages).values({
        id: assistantId,
        sessionId,
        role: 'assistant',
        contentBlocksJson: PARTIAL,
        createdAt: new Date('2026-04-30T00:00:01Z')
    })
    const [checkpoint] = await db
        .insert(chatStreamEvents)
        .values({
            sessionId,
            messageId: assistantId,
            seq: 1,
            eventType: 'token',
            payloadJson: { text: 'half an ans' }
        })
        .returning({ id: chatStreamEvents.id })
    await db
        .update(chatMessages)
        .set({ contentCheckpointEventId: checkpoint.id })
        .where(eq(chatMessages.id, assistantId))

    return {
        db,
        repo: new ChatRepository(db),
        writer,
        userId,
        agentId,
        sessionId,
        assistantId,
        checkpointId: checkpoint.id,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            await closeDb(writer)
            await closeDb(db)
        }
    }
}

// The turn terminating, in runAdapter's order and from the writer's
// connection: persistTerminalContent() commits the FINAL blocks cursor-less
// FIRST, and only then does emitEvent() insert the row that ends the turn.
// That order is what makes one snapshot sufficient — a snapshot old enough to
// still see the turn as inflight cannot have seen the terminal, and a
// snapshot new enough to see the terminal has the finished content to go with
// it. Reverse these two statements upstream and #723 comes back.
const terminate = async (
    h: Harness,
    kind: 'done' | 'error' = 'done'
): Promise<bigint> => {
    await h.writer
        .update(chatMessages)
        .set({ contentBlocksJson: FINAL, contentCheckpointEventId: null })
        .where(eq(chatMessages.id, h.assistantId))
    const [terminal] = await h.writer
        .insert(chatStreamEvents)
        .values({
            sessionId: h.sessionId,
            messageId: h.assistantId,
            seq: 2,
            eventType: kind,
            payloadJson:
                kind === 'done'
                    ? { finalMessageId: h.assistantId }
                    : {
                          error: {
                              code: 'adapter_failed',
                              message: 'upstream gave up',
                              retryable: true
                          }
                      }
        })
        .returning({ id: chatStreamEvents.id })
    return terminal.id
}

const blocksOf = (row: { contentBlocksJson: unknown }): unknown =>
    row.contentBlocksJson

interface TransactionSettings {
    isolation: string
    read_only: string
}

// What the server says about the transaction the reads are running in, asked
// from inside it on the same connection.
const settingsInside = async (
    repo: ChatRepository
): Promise<TransactionSettings> => {
    const db = (repo as unknown as { db: Database }).db
    const rows = (await db.execute(sql`
        select current_setting('transaction_isolation') as isolation,
               current_setting('transaction_read_only') as read_only
    `)) as unknown as TransactionSettings[]
    return rows[0]
}

test(
    'readSnapshot runs its reads at repeatable read, read only',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // Load-bearing and invisible if it silently regressed: drizzle emits
            // the isolation level as a `set transaction` after `begin`, and
            // nothing else in the suite would notice it going missing.
            const settings = await h.repo.readSnapshot(settingsInside)
            assert.equal(settings.isolation, 'repeatable read')
            assert.equal(settings.read_only, 'on')
        } finally {
            await h.close()
        }
    }
)

test(
    'streamAttachAnchor returns one-statement inflight and max state',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const before = await h.repo.streamAttachAnchor(h.sessionId)
            assert.equal(before.inflightMessageId, h.assistantId)
            assert.equal(before.maxEventId, h.checkpointId)
            assert.equal(
                await h.repo.streamReplayCursor(h.sessionId, h.assistantId),
                h.checkpointId - 1n
            )
            assert.equal(
                await h.repo.streamReplayCursor(
                    h.sessionId,
                    'message-with-no-rows'
                ),
                h.checkpointId
            )

            const terminalId = await terminate(h, 'done')
            const after = await h.repo.streamAttachAnchor(h.sessionId)
            assert.equal(after.inflightMessageId, null)
            assert.equal(after.maxEventId, terminalId)
        } finally {
            await h.close()
        }
    }
)

test(
    'a done terminal committed mid-snapshot leaves the page reads consistent',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const seen = await h.repo.readSnapshot(async (repo) => {
                const rows = await repo.listMessagePageWithUsage(h.sessionId, {
                    limit: 50,
                    before: null
                })
                // The barrier. The page rows are read; the turn now finishes on
                // another connection and commits, which is precisely the window
                // the three-statement version answered across.
                await terminate(h, 'done')
                return {
                    rows,
                    inflight: await repo.latestInflightMessageId(h.sessionId)
                }
            })

            const assistant = seen.rows.find(
                (row) => row.message.id === h.assistantId
            )
            assert.deepEqual(blocksOf(assistant!.message), PARTIAL)
            // The page shipped the pre-terminal row, so the snapshot must still
            // name its turn — the client has to be told what to replay.
            assert.equal(seen.inflight, h.assistantId)
            assert.equal(
                assistant!.message.contentCheckpointEventId,
                h.checkpointId
            )

            // And the commit really did land: it was invisible to the snapshot,
            // not absent from the database.
            assert.equal(
                await h.repo.latestInflightMessageId(h.sessionId),
                null
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'an error terminal committed mid-snapshot is not attached to pre-terminal content',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const seen = await h.repo.readSnapshot(async (repo) => {
                const rows = await repo.listMessagePageWithUsage(h.sessionId, {
                    limit: 50,
                    before: null
                })
                await terminate(h, 'error')
                return {
                    rows,
                    errors: await repo.terminalErrorsForMessages(
                        rows.map((row) => row.message.id)
                    ),
                    inflight: await repo.latestInflightMessageId(h.sessionId)
                }
            })

            const assistant = seen.rows.find(
                (row) => row.message.id === h.assistantId
            )
            assert.deepEqual(blocksOf(assistant!.message), PARTIAL)
            // An error stamped onto content that predates it is the same
            // contradiction read from the other end. It arrives with the replay.
            assert.equal(seen.errors.get(h.assistantId), undefined)
            assert.equal(seen.inflight, h.assistantId)

            const after = await h.repo.terminalErrorsForMessages([
                h.assistantId
            ])
            assert.equal(
                (after.get(h.assistantId) as { error: { code: string } }).error
                    .code,
                'adapter_failed'
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'listMessagePage answers a mid-read terminal with a partial row AND its replay target',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // The real repository, wrapped only to fire the barrier between two
            // real SQL statements inside the real transaction. Everything the
            // service reads still comes from Postgres.
            const wrapped = Object.create(h.repo) as ChatRepository & {
                readSnapshot: ChatRepository['readSnapshot']
            }
            wrapped.readSnapshot = (fn) =>
                h.repo.readSnapshot((tx) => {
                    const armed = Object.create(tx) as ChatRepository
                    armed.listMessagePageWithUsage = async (...args) => {
                        const rows =
                            await ChatRepository.prototype.listMessagePageWithUsage.apply(
                                tx,
                                args
                            )
                        await terminate(h, 'done')
                        return rows
                    }
                    return fn(armed)
                })

            const service = new ChatService(
                h.db,
                wrapped,
                undefined as never,
                undefined as never,
                undefined as never,
                undefined as never,
                undefined as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never
            )
            const page = await service.listMessagePage(
                h.userId,
                h.agentId,
                h.sessionId,
                { limit: 50 }
            )

            const assistant = page.messages.find(
                (message) => message.id === h.assistantId
            )
            assert.deepEqual(assistant?.contentBlocks, PARTIAL)
            assert.equal(assistant?.error, null)
            assert.equal(page.inflightAssistantMessageId, h.assistantId)
            // The cursor still describes the content shipped beside it, which is
            // what lets the client resume instead of replaying from zero.
            assert.equal(page.inflightCheckpointEventId, String(h.checkpointId))
        } finally {
            await h.close()
        }
    }
)

// The control. Same interleaving, same statements, no shared snapshot — and
// the answer is the one from the bug report. Without this the tests above
// prove only that the code does what it does.
test(
    'READ COMMITTED reproduces the partial row with no replay target',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const rows = await h.repo.listMessagePageWithUsage(h.sessionId, {
                limit: 50,
                before: null
            })
            await terminate(h, 'done')
            const inflight = await h.repo.latestInflightMessageId(h.sessionId)

            const assistant = rows.find(
                (row) => row.message.id === h.assistantId
            )
            assert.deepEqual(blocksOf(assistant!.message), PARTIAL)
            assert.equal(inflight, null)
        } finally {
            await h.close()
        }
    }
)

// The race read backwards, which is the direction a reordered-queries fix
// gets wrong. A turn that begins after the snapshot opens must be absent from
// it — no row, no inflight id, nothing half-present — because a page that
// named a turn it had no row for would still be describing two instants. The
// page cursor carries anything that commits after this snapshot into SSE.
test(
    'a turn starting after the snapshot opens is invisible to it, not half visible',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // Settle the existing turn first, so the session starts the read with
            // nothing inflight.
            await terminate(h, 'done')

            const laterId = `cmg_pgtest_b_${randomBytes(6).toString('hex')}`
            const seen = await h.repo.readSnapshot(async (repo) => {
                const rows = await repo.listMessagePageWithUsage(h.sessionId, {
                    limit: 50,
                    before: null
                })
                await h.writer.insert(chatMessages).values({
                    id: laterId,
                    sessionId: h.sessionId,
                    role: 'assistant',
                    contentBlocksJson: PARTIAL,
                    createdAt: new Date('2026-04-30T00:00:02Z')
                })
                return {
                    rows,
                    inflight: await repo.latestInflightMessageId(h.sessionId)
                }
            })

            assert.equal(
                seen.rows.some((row) => row.message.id === laterId),
                false
            )
            assert.equal(seen.inflight, null)
            assert.equal(
                await h.repo.latestInflightMessageId(h.sessionId),
                laterId
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'the page stream cursor delivers a turn completed before SSE subscribe',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        let broadcaster: ChatSseBroadcaster | null = null
        try {
            const firstTerminalId = await terminate(h, 'done')
            const service = new ChatService(
                h.db,
                h.repo,
                undefined as never,
                undefined as never,
                undefined as never,
                undefined as never,
                undefined as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never
            )
            const page = await service.listMessagePage(
                h.userId,
                h.agentId,
                h.sessionId,
                { limit: 50 }
            )
            assert.equal(page.inflightAssistantMessageId, null)
            assert.equal(page.streamCursorEventId, String(firstTerminalId))

            const laterId = `cmg_pgtest_gap_${randomBytes(6).toString('hex')}`
            await h.writer.insert(chatMessages).values({
                id: laterId,
                sessionId: h.sessionId,
                role: 'assistant',
                contentBlocksJson: FINAL,
                createdAt: new Date('2026-04-30T00:00:02Z')
            })
            await h.writer.insert(chatStreamEvents).values([
                {
                    sessionId: h.sessionId,
                    messageId: laterId,
                    seq: 1,
                    eventType: 'token',
                    payloadJson: { text: 'turn completed in the handoff gap' }
                },
                {
                    sessionId: h.sessionId,
                    messageId: laterId,
                    seq: 2,
                    eventType: 'done',
                    payloadJson: { finalMessageId: laterId }
                }
            ])

            const bus = {
                onMessage: () => undefined,
                onListenEstablished: () => undefined,
                notify: () => undefined
            } as unknown as ChatStreamBus
            broadcaster = new ChatSseBroadcaster(h.repo, bus)
            const events: ChatStreamEvent[] = []
            let resolve = (): void => undefined
            const delivered = new Promise<void>((doneResolve) => {
                resolve = doneResolve
            })
            await broadcaster.subscribe(
                h.sessionId,
                {
                    send: (event) => {
                        events.push(event)
                        if (events.length === 2) resolve()
                    },
                    close: () => undefined
                },
                page.streamCursorEventId
            )
            await delivered

            assert.deepEqual(
                events.map((event) => event.messageId),
                [laterId, laterId]
            )
            assert.deepEqual(
                events.map((event) => event.type),
                ['token', 'done']
            )
        } finally {
            broadcaster?.onModuleDestroy()
            await h.close()
        }
    }
)
