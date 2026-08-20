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
    chatMessageSources,
    chatMessages,
    chatSessions,
    chatStreamEvents,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { buildChatMessageSourceRow } from '../src/modules/chat/raw-message-source'

// safeResumeSeqForMessage decides how far a runner resume may SKIP, so a wrong
// answer here means silently dropped content. Two independent conditions have to
// hold for a line's seq to become the cursor, and both are pinned below:
//   1. the chunk ended on a line boundary (adapter stamps runner_seq only then;
//      NULL means "unsafe to resume past me");
//   2. the derived events are already in chat_stream_events — token events are
//      coalesced in the broadcaster, so a durable source row does NOT imply its
//      events were written.
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 npx tsx --test test/turn-resume-cursor.pg.test.ts --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChatRepository
    sessionId: string
    messageId: string
    otherMessageId: string
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
    const otherMessageId = `msg2_pgtest_${suffix}`

    await db.insert(users).values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'daemon'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'pgtest-agent',
        framework: 'claude-code',
        runtime: 'daemon',
        runtimeId,
        internalId: `internal-${agentId}`
    })
    await db.insert(chatSessions).values({ id: sessionId, userId, agentId })
    for (const id of [messageId, otherMessageId])
        await db.insert(chatMessages).values({
            id,
            sessionId,
            role: 'assistant',
            contentBlocksJson: []
        })

    return {
        db,
        repo: new ChatRepository(db),
        sessionId,
        messageId,
        otherMessageId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

// One raw line of runner output. runnerSeq === undefined models a line whose
// chunk ended mid-line (the adapter refuses to stamp those).
const insertSource = async (
    h: Harness,
    messageId: string,
    sourceSeq: number,
    runnerSeq: number | undefined,
    rawText: string
): Promise<string> => {
    const row = buildChatMessageSourceRow({
        sourceKind: 'live_stream',
        sessionId: h.sessionId,
        messageId,
        framework: 'claude-code',
        runtime: 'daemon',
        source: {
            sourceRef: 'sess-ref',
            sourceSeq,
            externalId: `uuid-${messageId}-${sourceSeq}`,
            parentExternalId: null,
            rawFormat: 'jsonl',
            rawText,
            parserName: 'claude-stream-json',
            parserVersion: '1'
        },
        runnerSeq
    })
    await h.db.insert(chatMessageSources).values(row)
    return row.sourceEventKey
}

// A durable event derived from that line — the proof the broadcaster flushed it.
let seqCounter = 0
const insertStreamEvent = async (
    h: Harness,
    messageId: string,
    sourceEventKey: string
): Promise<void> => {
    await h.db.insert(chatStreamEvents).values({
        sessionId: h.sessionId,
        messageId,
        seq: ++seqCounter,
        eventType: 'token',
        payloadJson: { text: 'x' },
        sourceEventKey,
        sourceEventOrdinal: 0
    })
}

test('no source rows ⇒ cursor 0 (replay the whole turn)', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        assert.equal(await h.repo.safeResumeSeqForMessage(h.messageId), 0)
    } finally {
        await h.close()
    }
})

test('source rows whose events are NOT durable yet ⇒ cursor 0', { skip: !RUN }, async () => {
    // The rows exist but nothing derived from them reached chat_stream_events,
    // so skipping them could drop content still sitting in the token buffer.
    const h = await buildHarness()
    try {
        await insertSource(h, h.messageId, 1, 4, '{"i":1}')
        await insertSource(h, h.messageId, 2, 9, '{"i":2}')
        assert.equal(await h.repo.safeResumeSeqForMessage(h.messageId), 0)
    } finally {
        await h.close()
    }
})

test('cursor stops short of the newest line proven durable', { skip: !RUN }, async () => {
    // Events are written in emit order, so a durable event for line 3 proves
    // lines 1-2 are fully durable — but line 3 itself may be half-written, so
    // the cursor must be line 2's seq, not line 3's.
    const h = await buildHarness()
    try {
        await insertSource(h, h.messageId, 1, 4, '{"i":1}')
        await insertSource(h, h.messageId, 2, 9, '{"i":2}')
        const key3 = await insertSource(h, h.messageId, 3, 14, '{"i":3}')
        await insertStreamEvent(h, h.messageId, key3)
        assert.equal(await h.repo.safeResumeSeqForMessage(h.messageId), 9)
    } finally {
        await h.close()
    }
})

test('lines with no stamp (chunk ended mid-line) never become the cursor', { skip: !RUN }, async () => {
    // Line 2 straddled two chunks so it is unstamped; resuming past it would
    // deliver line 2 truncated. The cursor must fall back to line 1.
    const h = await buildHarness()
    try {
        await insertSource(h, h.messageId, 1, 4, '{"i":1}')
        await insertSource(h, h.messageId, 2, undefined, '{"i":2}')
        const key3 = await insertSource(h, h.messageId, 3, 14, '{"i":3}')
        await insertStreamEvent(h, h.messageId, key3)
        assert.equal(await h.repo.safeResumeSeqForMessage(h.messageId), 4)
    } finally {
        await h.close()
    }
})

test('a transport without sequencing (sprite exec) ⇒ cursor 0, not a crash', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        await insertSource(h, h.messageId, 1, undefined, '{"i":1}')
        const key2 = await insertSource(h, h.messageId, 2, undefined, '{"i":2}')
        await insertStreamEvent(h, h.messageId, key2)
        assert.equal(await h.repo.safeResumeSeqForMessage(h.messageId), 0)
    } finally {
        await h.close()
    }
})

test('a concurrent turn in the same session cannot move our cursor', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        await insertSource(h, h.messageId, 1, 4, '{"i":1}')
        const key2 = await insertSource(h, h.messageId, 2, 9, '{"i":2}')
        await insertStreamEvent(h, h.messageId, key2)

        await insertSource(h, h.otherMessageId, 1, 99, '{"other":1}')
        const otherKey2 = await insertSource(
            h,
            h.otherMessageId,
            2,
            120,
            '{"other":2}'
        )
        await insertStreamEvent(h, h.otherMessageId, otherKey2)

        assert.equal(await h.repo.safeResumeSeqForMessage(h.messageId), 4)
        assert.equal(await h.repo.safeResumeSeqForMessage(h.otherMessageId), 99)
    } finally {
        await h.close()
    }
})

test('replaying an already-stored line does not duplicate or move the cursor', { skip: !RUN }, async () => {
    // The tail after the cursor is re-sent on resume and re-derives byte-
    // identical rows. The source_event_key unique index must swallow them.
    const h = await buildHarness()
    try {
        await insertSource(h, h.messageId, 1, 3, '{"i":1}')
        const key2 = await insertSource(h, h.messageId, 2, 8, '{"i":2}')
        await insertStreamEvent(h, h.messageId, key2)
        const replay = buildChatMessageSourceRow({
            sourceKind: 'live_stream',
            sessionId: h.sessionId,
            messageId: h.messageId,
            framework: 'claude-code',
            runtime: 'daemon',
            source: {
                sourceRef: 'sess-ref',
                sourceSeq: 1,
                externalId: `uuid-${h.messageId}-1`,
                parentExternalId: null,
                rawFormat: 'jsonl',
                rawText: '{"i":1}',
                parserName: 'claude-stream-json',
                parserVersion: '1'
            },
            // Same line, re-delivered by a later transport event.
            runnerSeq: 11
        })
        await h.db
            .insert(chatMessageSources)
            .values(replay)
            .onConflictDoNothing({
                target: chatMessageSources.sourceEventKey
            })
        const rows = await h.db
            .select({ id: chatMessageSources.id })
            .from(chatMessageSources)
            .where(eq(chatMessageSources.messageId, h.messageId))
        assert.equal(rows.length, 2, 'replayed line must not create a new row')
        assert.equal(await h.repo.safeResumeSeqForMessage(h.messageId), 3)
    } finally {
        await h.close()
    }
})
