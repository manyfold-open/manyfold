import type { ChatStreamEvent } from '@manyfold/shared'
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
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'

// What a cold attach to a long-running turn actually costs, measured on real
// Postgres with real row ids.
//
// A subscriber with no cursor is attached to the session's inflight turn at
// its FIRST event, so it is replayed the whole turn: every row read back out
// of chat_stream_events, serialised, pushed down the socket, and re-applied
// by the browser one event at a time. Every new tab, cold load and cursorless
// reconnect pays it, and a deploy makes the whole fleet pay it at once.
//
// With a checkpoint cursor the same client renders the content the message
// page already shipped it and attaches at the cursor, so only the tail since
// the last checkpoint crosses the wire. This measures both, over the same
// turn, through the real broadcaster and the real subscribe path — the frames
// are byte-counted exactly as chat.controller serialises them.
//
// Env-gated like the other *.pg.test.ts. Point it at a THROWAWAY database —
// it writes a few thousand rows and drops its fixture afterwards:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://user:pw@localhost:5432/scratch \
//     node --import tsx --test test/chat-checkpoint-attach-cost.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

// A turn long enough to be worth attaching cheaply, at the shape the 120ms
// merge window produces: roughly 8 token rows a second, each holding the text
// that arrived inside one window, plus a tool pair every so often. 2400 rows
// is about a five-minute agentic turn.
//
// Written straight through the repository rather than through emit(): the
// merge window is read once at module load, so a tight emit loop would
// collapse the whole fixture into a handful of rows and measure a turn shape
// nobody has. What is under measurement is the ATTACH — subscribe, pump,
// frame — and that reads rows, not the path that wrote them.
const TOKEN_ROWS = 2000
const TOOL_PAIRS = 200
const TOKEN_TEXT = 'the model keeps producing plausible-looking prose. '

// Where the last checkpoint landed. The growth rule checkpoints every +10% of
// content, so a cold attach lands within the last tenth of the turn; 90% is
// the pessimistic end of that.
const CHECKPOINT_AT_FRACTION = 0.9

interface Harness {
    db: Database
    repo: ChatRepository
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

// Exactly what chat.controller writes per event, so the byte counts below are
// the bytes that leave the process rather than a proxy for them.
const frameBytes = (event: ChatStreamEvent): number =>
    Buffer.byteLength(
        `id: ${event.eventId}\n` +
            `event: ${event.type}\n` +
            `data: ${JSON.stringify(event)}\n\n`
    )

interface Attach {
    rows: number
    bytes: number
}

const attach = async (
    harness: Harness,
    lastEventId: string | null,
    replayMessageId: string | null
): Promise<Attach> => {
    let rows = 0
    let bytes = 0
    let idle = 0
    const unsubscribe = await harness.broadcaster.subscribe(
        harness.sessionId,
        {
            send: (event) => {
                rows += 1
                bytes += frameBytes(event)
                idle = 0
            },
            close: () => undefined
        },
        lastEventId,
        replayMessageId
    )
    // The pump batches at PUMP_BATCH_LIMIT and re-kicks itself; wait until it
    // has been quiet for a few ticks rather than guessing a duration.
    while (idle < 20) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        idle += 1
    }
    unsubscribe()
    return { rows, bytes }
}

test(
    'a cold attach to a long turn costs a tail instead of the whole turn',
    { skip: !RUN && 'RUN_PG_E2E!=1' },
    async () => {
        const harness = await buildHarness()
        try {
            const totalRows = await harness.db.$count(
                chatStreamEvents,
                eq(chatStreamEvents.messageId, harness.messageId)
            )
            const cutoff = Math.floor(totalRows * CHECKPOINT_AT_FRACTION)
            const ids = await harness.repo.listStreamEventsSince(
                harness.messageId,
                0n
            )
            const cursor = ids[cutoff - 1]!.id

            const before = await attach(harness, null, harness.messageId)
            const after = await attach(harness, String(cursor), null)

            // What the checkpoint content itself weighs, folded the way the
            // message page ships it. Those bytes are NOT new — the page
            // already returns contentBlocks for the inflight row — but the
            // comparison is what says the design would still be worth it if
            // they were: the same prose without a per-event SSE envelope
            // around every 120ms of it.
            const skipped = ids.slice(0, cutoff)
            const contentBytes = Buffer.byteLength(
                JSON.stringify(foldToContentBlocks(skipped))
            )
            const skippedBytes = before.bytes - after.bytes

            console.log(
                `checkpoint attach: rows ${before.rows} -> ${after.rows} ` +
                    `(${(before.rows / Math.max(1, after.rows)).toFixed(1)}x), ` +
                    `bytes ${before.bytes} -> ${after.bytes} ` +
                    `(${(before.bytes / Math.max(1, after.bytes)).toFixed(1)}x) ` +
                    `over ${totalRows} rows; the ${cutoff} skipped rows are ` +
                    `${skippedBytes} bytes of frames against ${contentBytes} ` +
                    `bytes of checkpoint content ` +
                    `(${(skippedBytes / Math.max(1, contentBytes)).toFixed(1)}x)`
            )

            assert.ok(
                contentBytes * 2 < skippedBytes,
                `the checkpoint must be smaller than the frames it replaces, saw ${contentBytes} against ${skippedBytes}`
            )

            assert.equal(
                before.rows,
                totalRows,
                'the cursorless attach must replay the whole turn'
            )
            assert.equal(
                after.rows,
                totalRows - cutoff,
                'the checkpoint attach must deliver exactly the tail'
            )
            assert.ok(
                after.bytes * 5 < before.bytes,
                `expected the tail to be a fraction of the replay, saw ${after.bytes} of ${before.bytes}`
            )
        } finally {
            await harness.close()
        }
    }
)

// The same fold the client performs, over the rows the cursor covers.
const foldToContentBlocks = (
    rows: Array<{ eventType: string; payloadJson: unknown }>
): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = []
    for (const row of rows) {
        const p = (row.payloadJson ?? {}) as Record<string, unknown>
        if (row.eventType === 'token') {
            const tail = out.at(-1)
            if (tail?.type === 'text') tail.text = String(tail.text) + p.text
            else out.push({ type: 'text', text: String(p.text) })
        } else out.push({ ...p })
    }
    return out
}

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

    const repo = new ChatRepository(db)
    const broadcaster = new ChatSseBroadcaster(repo, noopBus)
    let seq = 0
    const write = async (
        eventType: 'token' | 'tool_call' | 'tool_result',
        payloadJson: Record<string, unknown>
    ): Promise<void> => {
        seq += 1
        await repo.insertStreamEvent({
            sessionId,
            messageId,
            seq,
            eventType,
            payloadJson,
            sourceEventKey: null,
            sourceEventOrdinal: null,
            runnerSeq: null,
            createdAt: new Date()
        })
    }
    // Interleaved, not blocked: a tool pair every tenth token row is the
    // shape an agentic turn actually has, and it is what makes the tail a
    // representative slice rather than 200 tool rows in a row.
    for (let i = 0; i < TOKEN_ROWS; i += 1) {
        await write('token', { type: 'token', text: TOKEN_TEXT })
        if (i % 10 === 9 && i / 10 < TOOL_PAIRS) {
            const call = Math.floor(i / 10)
            await write('tool_call', {
                type: 'tool_call',
                toolCallId: `call-${call}`,
                toolName: 'read',
                args: { path: `/workspace/src/module-${call}.ts` }
            })
            await write('tool_result', {
                type: 'tool_result',
                toolCallId: `call-${call}`,
                result: { ok: true, bytes: 4096 }
            })
        }
    }

    return {
        db,
        repo,
        broadcaster,
        sessionId,
        messageId,
        close: async () => {
            broadcaster.onModuleDestroy()
            await db
                .update(chatSessions)
                .set({ inflightMessageId: null })
                .where(eq(chatSessions.id, sessionId))
            await db.delete(users).where(eq(users.id, userId))
            await db.$client.end()
        }
    }
}
