import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
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

// A runner turn was forced to block-level output because resuming a
// DELTA stream from a cursor could silently LOSE content: delta rows are
// identified by (source_event_key, ordinal), the broadcaster's merge boundaries
// shift between runs, so a re-sent delta row can collide with a stored row
// holding different text and be dropped by the unique index. The conservative
// source-row cursor deliberately re-sends one line, so it cannot be used here.
//
// chat_stream_events.runner_seq is the exact cursor. Its meaning is "everything
// through this seq had ALREADY been emitted as an earlier row when this row was
// written" — deliberately a claim about what PRECEDES the row, because the
// broadcaster coalesces token events and a row's own extent is therefore
// unbounded. Rows land in emit order, so a durable row proves all content
// through its seq is durable: nothing skipped, nothing re-sent.
//
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test -- --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChatRepository
    sessionId: string
    messageId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agt_pgtest_${suffix}`
    const sessionId = `cts_pgtest_${suffix}`
    const messageId = `msg_pgtest_${suffix}`

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
        repo: new ChatRepository(db),
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

const addRow = async (
    h: Harness,
    seq: number,
    runnerSeq: number | null,
    opts: { key?: string | null; ordinal?: number | null } = {}
): Promise<void> => {
    await h.db.insert(chatStreamEvents).values({
        sessionId: h.sessionId,
        messageId: h.messageId,
        seq,
        eventType: 'token',
        payloadJson: { type: 'token', text: `t${seq}` },
        sourceEventKey: opts.key ?? null,
        sourceEventOrdinal: opts.ordinal ?? null,
        runnerSeq
    })
}

test(
    'the cursor is the highest watermark on any durable row',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            assert.equal(await h.repo.exactResumeSeqForMessage(h.messageId), 0)
            await addRow(h, 1, null)
            // Unstamped rows must not make the cursor jump: a row written before any
            // line boundary was crossed can prove nothing.
            assert.equal(await h.repo.exactResumeSeqForMessage(h.messageId), 0)
            await addRow(h, 2, 4)
            await addRow(h, 3, 9)
            await addRow(h, 4, null)
            // The unstamped tail row does NOT lower the answer — content after seq 9
            // simply has not been proven durable, which is what re-streaming covers.
            assert.equal(await h.repo.exactResumeSeqForMessage(h.messageId), 9)
        } finally {
            await h.close()
        }
    }
)

test('another message cannot move this cursor', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        await addRow(h, 1, 5)
        const other = `${h.messageId}_other`
        await h.db.insert(chatMessages).values({
            id: other,
            sessionId: h.sessionId,
            role: 'assistant',
            contentBlocksJson: []
        })
        await h.db.insert(chatStreamEvents).values({
            sessionId: h.sessionId,
            messageId: other,
            seq: 1,
            eventType: 'token',
            payloadJson: { type: 'token', text: 'x' },
            runnerSeq: 999
        })
        // WHY: concurrent turns in one session share the table. A cursor that
        // leaked across messages would resume a turn past content it never sent.
        assert.equal(await h.repo.exactResumeSeqForMessage(h.messageId), 5)
    } finally {
        await h.close()
    }
})

test(
    'a turn from before the watermark existed degrades, it does not lie',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // Every row NULL: an in-flight turn that started on the previous
            // build. 0 means "replay from the top", which the dedup indexes
            // absorb — the one answer that can never lose content.
            await addRow(h, 1, null)
            await addRow(h, 2, null)
            assert.equal(await h.repo.exactResumeSeqForMessage(h.messageId), 0)
        } finally {
            await h.close()
        }
    }
)

test(
    'the watermark rides alongside delta dedup keys without disturbing them',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // Delta rows share one key and differ by ordinal; that unique index
            // is what makes a re-send lossy, so the watermark must be a separate
            // column and must not participate in identity.
            await addRow(h, 1, 3, { key: 'k1', ordinal: 0 })
            await addRow(h, 2, 7, { key: 'k1', ordinal: 1 })
            assert.equal(await h.repo.exactResumeSeqForMessage(h.messageId), 7)
            // Same (key, ordinal) with a DIFFERENT watermark, through the REAL
            // write path: it is still the same row, so it is dropped and the
            // cursor does not budge. That is what stops runner_seq from
            // smuggling a duplicate past the dedup index — the exact failure a
            // re-sent delta row would otherwise cause.
            const dup = await h.repo.insertStreamEvent({
                sessionId: h.sessionId,
                messageId: h.messageId,
                seq: 3,
                eventType: 'token',
                payloadJson: { type: 'token', text: 'REPLAYED' },
                sourceEventKey: 'k1',
                sourceEventOrdinal: 1,
                runnerSeq: 99
            })
            assert.equal(dup.id, null, 'the replayed row was dropped')
            assert.equal(
                await h.repo.exactResumeSeqForMessage(h.messageId),
                7,
                'a dropped row must not advance the cursor'
            )
        } finally {
            await h.close()
        }
    }
)
