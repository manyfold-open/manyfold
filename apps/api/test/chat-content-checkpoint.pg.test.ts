import type { ChatContentBlock } from '@manyfold/shared'
import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { and, asc, eq, sql } from 'drizzle-orm'
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
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'
import { ChatService } from '../src/modules/chat/chat.service'

// Real-Postgres proof for #749, where the in-memory suite runs out of things
// it can honestly claim.
//
// The incident was an `update chat_messages set content_blocks_json = $1,
// content_checkpoint_event_id = $2` that waited 30.327s and then failed. A
// stubbed drizzle can model "the promise does not settle", and that is enough
// to show the adapter loop no longer waits on it — but it cannot produce the
// thing that made the wait real: a statement parked in the server's lock
// queue, holding a pooled connection, while the same pool serves every stream
// write the turn is still making. Nor can it produce a real cursor, since the
// pairing invariant is a claim about ids the bigint sequence hands out at
// COMMIT time.
//
// So both tests here work against a live row: one takes an exclusive lock on
// the message and watches the turn run past a genuinely blocked UPDATE, the
// other reads a landed checkpoint back and folds the rows it claims.
//
// Env-gated like the other *.pg.test.ts. Point it at a THROWAWAY database —
// it writes a few dozen rows and drops its fixture afterwards:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://user:pw@localhost:5432/scratch \
//     node --import tsx --test test/chat-content-checkpoint.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

// Over the 8 KiB checkpoint floor, so every chunk is a checkpoint the cadence
// asks for and the first one lands on the lock.
const CHUNK = 'x'.repeat(10 * 1024)
const CHUNKS = 5
// Under it, so nothing is written before the test has the row locked.
const WARMUP = 'warming up '

interface TelemetryEvent {
    name: string
    attrs: Record<string, unknown>
}

interface Harness {
    db: Database
    locker: Database
    appName: string
    service: ChatService
    userId: string
    agentId: string
    sessionId: string
    openGate: () => void
    telemetry: TelemetryEvent[]
    turnFinished: Promise<void>
    close: () => Promise<void>
}

const noopBus = {
    onMessage: () => undefined,
    onListenEstablished: () => undefined,
    notify: () => undefined
} as unknown as ChatStreamBus

const until = async (
    what: string,
    ready: () => Promise<boolean>,
    ms: number
): Promise<void> => {
    const deadline = Date.now() + ms
    while (!(await ready())) {
        if (Date.now() > deadline)
            throw new Error(`timed out after ${ms}ms waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

const buildHarness = async (tail: EmittedChatEvent[]): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set')
    const suffix = randomBytes(8).toString('hex')
    // Named so pg_stat_activity can be asked about THIS turn's backends and
    // nothing else on the database.
    const appName = `pg749-${suffix}`
    const db = createDb(url, { applicationName: appName })
    const locker = createDb(url)
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agt_pgtest_${suffix}`
    const sessionId = `cts_pgtest_${suffix}`

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

    let openGate!: () => void
    const gate = new Promise<void>((r) => {
        openGate = r
    })
    const adapter = {
        sendMessage: async function* (): AsyncIterable<EmittedChatEvent> {
            yield { type: 'token', text: WARMUP }
            // The turn does not produce checkpointable content until the test
            // says so, which is how the lock gets in front of the first
            // UPDATE without racing it.
            await gate
            for (let i = 0; i < CHUNKS; i += 1)
                yield { type: 'token', text: CHUNK }
            for (const event of tail) yield event
        }
    }
    const telemetry: TelemetryEvent[] = []
    const service = new ChatService(
        db,
        new ChatRepository(db),
        new ChatSseBroadcaster(new ChatRepository(db), noopBus),
        { get: () => adapter } as never,
        {} as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) =>
                telemetry.push({ name, attrs }),
            error: () => {}
        } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )
    let turnFinishedResolve!: () => void
    const turnFinished = new Promise<void>((r) => {
        turnFinishedResolve = r
    })
    const runAdapter = (
        service as unknown as {
            runAdapter: (...args: unknown[]) => Promise<void>
        }
    ).runAdapter.bind(service)
    ;(
        service as unknown as {
            runAdapter: (...args: unknown[]) => Promise<void>
        }
    ).runAdapter = async (...args: unknown[]): Promise<void> => {
        try {
            await runAdapter(...args)
        } finally {
            turnFinishedResolve()
        }
    }

    return {
        db,
        locker,
        appName,
        service,
        userId,
        agentId,
        sessionId,
        openGate,
        telemetry,
        turnFinished,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            for (const client of [db, locker]) {
                const c = (
                    client as unknown as {
                        $client?: { end?: () => Promise<void> }
                    }
                ).$client
                if (c?.end) await c.end()
            }
        }
    }
}

const tokenChars = async (h: Harness, messageId: string): Promise<number> => {
    const rows = await h.db
        .select({ payloadJson: chatStreamEvents.payloadJson })
        .from(chatStreamEvents)
        .where(
            and(
                eq(chatStreamEvents.messageId, messageId),
                eq(chatStreamEvents.eventType, 'token')
            )
        )
    return rows.reduce(
        (n, row) =>
            n +
            String((row.payloadJson as { text?: string }).text ?? '').length,
        0
    )
}

const messageRow = async (
    h: Harness,
    messageId: string
): Promise<{
    contentBlocksJson: ChatContentBlock[]
    contentCheckpointEventId: bigint | null
}> => {
    const rows = await h.db
        .select({
            contentBlocksJson: chatMessages.contentBlocksJson,
            contentCheckpointEventId: chatMessages.contentCheckpointEventId
        })
        .from(chatMessages)
        .where(eq(chatMessages.id, messageId))
    assert.equal(rows.length, 1)
    return {
        contentBlocksJson: rows[0]!.contentBlocksJson as ChatContentBlock[],
        contentCheckpointEventId: rows[0]!.contentCheckpointEventId
    }
}

// This turn's backends that are parked waiting for a lock inside the exact
// statement the incident recorded.
const blockedCheckpointUpdates = async (h: Harness): Promise<number> => {
    const rows = await h.locker.execute<{ n: number }>(sql`
        select count(*)::int as n
        from pg_stat_activity
        where application_name = ${h.appName}
          and wait_event_type = 'Lock'
          and query like '%content_blocks_json%'
    `)
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0)
}

test(
    'a locked message row stalls the checkpoint without stalling the turn',
    { skip: !RUN && 'RUN_PG_E2E!=1' },
    async () => {
        const h = await buildHarness([])
        let releaseLock!: () => void
        const lockHeld = new Promise<void>((r) => {
            releaseLock = r
        })
        let lockTaken!: () => void
        const locked = new Promise<void>((r) => {
            lockTaken = r
        })
        try {
            const { assistantMessageId } = await h.service.sendMessage(
                h.userId,
                h.agentId,
                h.sessionId,
                'hi'
            )
            // A second connection holds the row the checkpoint is about to
            // update. Every later UPDATE of it waits in the server's lock
            // queue — the incident's 30.327s, reproduced as a real wait on a
            // real statement rather than a promise the test declines to
            // settle.
            //
            // FOR NO KEY UPDATE, not FOR UPDATE. chat_stream_events.message_id
            // references this row, so every stream INSERT the turn makes takes
            // a FOR KEY SHARE lock on it — which FOR UPDATE blocks and this
            // mode does not. Locking the strong way would stall the turn
            // through the log instead of through the checkpoint, and the test
            // would "fail" against the fixed code for a reason production
            // never had.
            const lockTxn = h.locker.transaction(async (tx) => {
                await tx.execute(
                    sql`select 1 from chat_messages where id = ${assistantMessageId} for no key update`
                )
                lockTaken()
                await lockHeld
            })
            await locked
            h.openGate()

            // The regression. Every token has to reach chat_stream_events
            // while that UPDATE is stuck; before the fix the loop was inside
            // it and only the first chunk ever landed.
            await until(
                'every token to reach the stream log while the checkpoint UPDATE is blocked',
                async () =>
                    (await tokenChars(h, assistantMessageId)) >=
                    WARMUP.length + CHUNKS * CHUNK.length,
                20_000
            )
            await until(
                'the checkpoint UPDATE to be waiting on the row lock',
                async () => (await blockedCheckpointUpdates(h)) > 0,
                10_000
            )
            assert.equal(
                (await messageRow(h, assistantMessageId)).contentBlocksJson
                    .length,
                0,
                'nothing can have been written to the row while it is locked'
            )

            releaseLock()
            await lockTxn
            await h.turnFinished

            // The stuck checkpoint landed, and then the terminal landed ON
            // TOP of it: the row is the whole turn, cursorless. A late
            // checkpoint winning here is the corruption the fence prevents,
            // and it is only observable against a real row.
            const row = await messageRow(h, assistantMessageId)
            assert.deepEqual(row.contentBlocksJson, [
                { type: 'text', text: WARMUP + CHUNK.repeat(CHUNKS) }
            ])
            assert.equal(
                row.contentCheckpointEventId,
                null,
                'the terminal write clears the cursor, so it must be the last one'
            )

            // AC: the turn still terminalises and releases its claim, and the
            // transcript is recoverable from the log alone.
            const events = await h.db
                .select({ eventType: chatStreamEvents.eventType })
                .from(chatStreamEvents)
                .where(eq(chatStreamEvents.messageId, assistantMessageId))
                .orderBy(asc(chatStreamEvents.id))
            assert.equal(events.at(-1)?.eventType, 'done')
            assert.equal(
                await tokenChars(h, assistantMessageId),
                WARMUP.length + CHUNKS * CHUNK.length
            )
            const sessions = await h.db
                .select({ inflightMessageId: chatSessions.inflightMessageId })
                .from(chatSessions)
                .where(eq(chatSessions.id, h.sessionId))
            assert.equal(
                sessions[0]?.inflightMessageId,
                null,
                'a stalled checkpoint must not leave the session claimed'
            )

            const points = h.telemetry.filter(
                (e) => e.name === 'chat.content.checkpoint'
            )
            assert.ok(
                points.some((e) => e.attrs.outcome === 'written'),
                'the checkpoint that waited for the lock must still report itself'
            )
        } finally {
            // Ordered for the failure path too: a turn still mid-write when
            // the fixture is deleted logs FK violations that bury whatever
            // actually failed.
            releaseLock()
            await Promise.race([
                h.turnFinished,
                new Promise((resolve) => setTimeout(resolve, 5_000))
            ])
            await h.close()
        }
    }
)

// The other half of the contract, and the half only real ids can carry. A
// suspended turn writes no terminal, so whatever the checkpointer drained is
// the row's final state — content and cursor, committed together, waiting for
// whoever resumes. #720's invariant is an equality over ids the sequence
// assigns at commit, so this is where it can actually be checked.
test(
    'a suspended turn leaves content paired with a real event id',
    { skip: !RUN && 'RUN_PG_E2E!=1' },
    async () => {
        const h = await buildHarness([
            {
                type: 'suspended',
                daemonId: 'dh-pgtest',
                daemonExecRef: 'ref-pgtest',
                reason: 'sprite_suspended'
            } as EmittedChatEvent
        ])
        try {
            const { assistantMessageId } = await h.service.sendMessage(
                h.userId,
                h.agentId,
                h.sessionId,
                'hi'
            )
            h.openGate()
            await h.turnFinished

            const row = await messageRow(h, assistantMessageId)
            const cursor = row.contentCheckpointEventId
            assert.ok(
                cursor !== null,
                'a suspended turn must leave a cursor, or its reader replays the whole turn'
            )
            const rows = await h.db
                .select({
                    id: chatStreamEvents.id,
                    eventType: chatStreamEvents.eventType,
                    payloadJson: chatStreamEvents.payloadJson
                })
                .from(chatStreamEvents)
                .where(eq(chatStreamEvents.messageId, assistantMessageId))
                .orderBy(asc(chatStreamEvents.id))

            const covered = rows.filter((r) => r.id <= cursor)
            assert.equal(
                row.contentBlocksJson.length,
                1,
                'a token-only turn folds to one text block'
            )
            assert.equal(
                (row.contentBlocksJson[0] as { text: string }).text,
                covered
                    .filter((r) => r.eventType === 'token')
                    .map((r) => (r.payloadJson as { text?: string }).text ?? '')
                    .join(''),
                'the content must equal the fold of exactly the rows its cursor claims'
            )
            assert.ok(
                covered.length < rows.length,
                'the cursor must leave the suspended row for the subscriber to see'
            )
            for (const r of covered)
                assert.notEqual(
                    r.eventType,
                    'suspended',
                    'a cursor covering the terminal hides it from every attaching reader'
                )
        } finally {
            await h.close()
        }
    }
)
