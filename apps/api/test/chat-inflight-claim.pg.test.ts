import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { and, eq, gt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
    agentRuntimes,
    agents,
    chatMessages,
    chatSessions,
    chatStreamEvents,
    createDb,
    schema,
    turnExecutions,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { nonTerminalStreamEventInsert } from '../src/modules/chat/stream-event-insert'

// Real-Postgres proof for the two locks insertStreamEvent depends on.
//
// The per-session turn lock (chat_sessions.inflight_message_id): the
// compare-and-set claim, the clear-on-terminal, and the bootstrap stale-claim
// sweep. The in-memory chat tests stub these methods, so only live PG exercises
// the actual SQL atomicity.
//
// And the per-session advisory lock that keeps event ids committing in id
// order. Non-terminal rows take it inside a single statement rather than a
// four-statement transaction, which only works because the insert selects FROM
// the lock CTE; drop that and Postgres never evaluates the CTE, every row is
// written unlocked, and nothing anywhere raises. The tests below therefore
// assert on the lock being HELD (a concurrent holder blocks the statement with
// the id sequence untouched), not merely on the rows landing.
//
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
    db: Database
    repo: ChatRepository
    userId: string
    agentId: string
    sessionId: string
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

    return {
        db,
        repo: new ChatRepository(db),
        userId,
        agentId,
        sessionId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            await closeDb(db)
        }
    }
}

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

const dbUrl = (): string => process.env.DATABASE_URL as string

// The lowest id chat_stream_events_id_seq can still hand out. Read while a
// writer is blocked, it is a floor that writer's row must clear if its id had
// not been drawn yet. Deliberately a floor and not an equality: the sequence is
// global, so any other writer in the suite moves it, and only a bound survives
// that. An equality here fails a perfectly correct implementation whenever
// another pg test file inserts a stream event during the hold below.
const nextSequenceValue = async (h: Harness): Promise<bigint> => {
    const rows = (await h.db.execute(
        sql`select last_value, is_called from chat_stream_events_id_seq`
    )) as unknown as Array<{ last_value: string; is_called: boolean }>
    return BigInt(rows[0].last_value) + (rows[0].is_called ? 1n : 0n)
}

const waitStateOf = async (h: Harness, pid: number): Promise<string> => {
    const rows = (await h.db.execute(sql`
        select coalesce(wait_event_type, '-') as t,
               coalesce(wait_event, '-') as e
        from pg_stat_activity where pid = ${pid}
    `)) as unknown as Array<{ t: string; e: string }>
    return rows[0] ? `${rows[0].t}/${rows[0].e}` : 'gone'
}

// Writing a heap tuple is what assigns a transaction id, and a backend with one
// holds a lock on it. Zero such locks means this backend has not written its
// row yet — a per-backend fact, so unlike the sequence it says nothing about
// what any other connection is doing.
const heldXidLocks = async (h: Harness, pid: number): Promise<number> => {
    const rows = (await h.db.execute(sql`
        select count(*)::int as n from pg_locks
        where pid = ${pid} and locktype = 'transactionid'
    `)) as unknown as Array<{ n: number }>
    return rows[0].n
}

// Holds the per-session advisory lock from a second connection until released.
const holdSessionLock = async (
    sessionId: string
): Promise<{ release: () => Promise<void> }> => {
    const holder = createDb(dbUrl())
    let unlock = (): void => {}
    let acquired = (): void => {}
    const held = new Promise<void>((resolve) => {
        unlock = resolve
    })
    const taken = new Promise<void>((resolve) => {
        acquired = resolve
    })
    const running = holder.transaction(async (tx) => {
        await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('chat_stream_events'), hashtext(${sessionId}))`
        )
        acquired()
        await held
    })
    await taken
    return {
        release: async (): Promise<void> => {
            unlock()
            await running
            await closeDb(holder)
        }
    }
}

const readClaim = async (h: Harness): Promise<string | null> => {
    const [row] = await h.db
        .select({ ref: chatSessions.inflightMessageId })
        .from(chatSessions)
        .where(eq(chatSessions.id, h.sessionId))
        .limit(1)
    return row?.ref ?? null
}

const readExecState = async (
    h: Harness,
    messageId: string
): Promise<string | null> => {
    const [row] = await h.db
        .select({ state: turnExecutions.state })
        .from(turnExecutions)
        .where(eq(turnExecutions.messageId, messageId))
        .limit(1)
    return row?.state ?? null
}

const insertAssistant = async (h: Harness, id: string): Promise<void> => {
    await h.db.insert(chatMessages).values({
        id,
        sessionId: h.sessionId,
        role: 'assistant',
        contentBlocksJson: []
    })
}

const claim = async (h: Harness, messageId: string): Promise<void> => {
    await h.db
        .update(chatSessions)
        .set({ inflightMessageId: messageId })
        .where(eq(chatSessions.id, h.sessionId))
}

// Backdate the session so the age-gated stale-claim sweep treats its claim as old
// (a fresh claim is intentionally protected to not race another instance's claim).
const ageOutClaim = async (h: Harness): Promise<void> => {
    await h.db
        .update(chatSessions)
        .set({ updatedAt: new Date(Date.now() - 30 * 60 * 1000) })
        .where(eq(chatSessions.id, h.sessionId))
}

test(
    'claimInflightTurn is a compare-and-set: only one claim wins',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            assert.equal(
                await h.repo.claimInflightTurn(h.sessionId, 'm1'),
                true
            )
            assert.equal(await readClaim(h), 'm1')
            // second claim while held -> rejected, claim unchanged
            assert.equal(
                await h.repo.claimInflightTurn(h.sessionId, 'm2'),
                false
            )
            assert.equal(await readClaim(h), 'm1')
            // release matching id frees the slot; a non-matching release is a no-op
            await h.repo.releaseInflightTurn(h.sessionId, 'wrong')
            assert.equal(await readClaim(h), 'm1')
            await h.repo.releaseInflightTurn(h.sessionId, 'm1')
            assert.equal(await readClaim(h), null)
            assert.equal(
                await h.repo.claimInflightTurn(h.sessionId, 'm2'),
                true
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a done/error stream event releases the claim for that message',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertAssistant(h, 'm1')
            assert.equal(
                await h.repo.claimInflightTurn(h.sessionId, 'm1'),
                true
            )
            const fence = await h.repo.upsertTurnExecution({
                messageId: 'm1',
                sessionId: h.sessionId,
                agentId: h.agentId,
                runtime: 'sprites',
                spriteName: 'sp',
                ownerId: 'owner-1',
                leaseSeconds: 60
            })
            assert.ok(fence)
            // a non-terminal event must NOT clear the claim
            await h.repo.insertStreamEvent(
                {
                    sessionId: h.sessionId,
                    messageId: 'm1',
                    seq: 1,
                    eventType: 'token',
                    payloadJson: {},
                    createdAt: new Date()
                },
                undefined,
                fence
            )
            assert.equal(await readClaim(h), 'm1')
            assert.equal(await readExecState(h, 'm1'), 'running')
            // a terminal event clears it, and closes the execution record with it —
            // the two must not be separable, or a turn is terminal and adoptable
            // at the same time
            await h.repo.insertStreamEvent(
                {
                    sessionId: h.sessionId,
                    messageId: 'm1',
                    seq: 2,
                    eventType: 'done',
                    payloadJson: {},
                    createdAt: new Date()
                },
                undefined,
                fence
            )
            assert.equal(await readClaim(h), null)
            assert.equal(await readExecState(h, 'm1'), 'done')
        } finally {
            await h.close()
        }
    }
)

test(
    'clearStaleInflightClaims clears dangling/terminalized claims but never a live one',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // a FRESH claim at a missing message is NOT swept (protects the
            // claim-before-insert window on another instance)
            assert.equal(
                await h.repo.claimInflightTurn(h.sessionId, 'ghost'),
                true
            )
            assert.equal(await h.repo.clearStaleInflightClaims(), 0)
            assert.equal(await readClaim(h), 'ghost')
            // once aged out, the dangling (missing-message) claim is swept
            await ageOutClaim(h)
            assert.equal(await h.repo.clearStaleInflightClaims(), 1)
            assert.equal(await readClaim(h), null)

            // an aged claim at a LIVE message (exists, no terminal) is KEPT — the
            // not-exists guard protects it regardless of age
            await insertAssistant(h, 'live')
            assert.equal(
                await h.repo.claimInflightTurn(h.sessionId, 'live'),
                true
            )
            await ageOutClaim(h)
            assert.equal(await h.repo.clearStaleInflightClaims(), 0)
            assert.equal(await readClaim(h), 'live')

            // once that message terminalizes, the terminal event clears the claim
            await h.repo.insertStreamEvent({
                sessionId: h.sessionId,
                messageId: 'live',
                seq: 1,
                eventType: 'error',
                payloadJson: {},
                createdAt: new Date()
            })
            assert.equal(await readClaim(h), null)
        } finally {
            await h.close()
        }
    }
)

// This is the one test in the repository that CI runs against a real Postgres:
// ci.yml's smoke-boot job selects it by name with --test-name-pattern, because
// nothing that reads only the serialized SQL can tell whether the lock is
// actually held. Its NAME is therefore load-bearing — the job greps for this
// exact `ok` line, because a pattern that matches nothing does not fail the
// runner, it just reports the file as one passing test.
//
// Every witness below is scoped to the writer's own backend, and that is not
// incidental. An earlier version compared the global id sequence before and
// during the hold, which fails a CORRECT implementation the moment anything
// else writes a stream event in the same 500ms: measured, 6 failures out of 6
// runs with daemon-exec-resume-recheck.pg.test.ts in the same process.
test(
    'a non-terminal insert holds the advisory lock before it draws the row id',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        // Pinned to a single backend so the writer's own wait state and locks can
        // be read by pid — every witness below is about this connection, which is
        // what makes the test safe to run next to anything else.
        const writerDb = createDb(dbUrl(), { max: 1 })
        const writer = new ChatRepository(writerDb)
        const pidRows = (await writerDb.execute(
            sql`select pg_backend_pid() as pid`
        )) as unknown as Array<{ pid: number }>
        const pid = Number(pidRows[0].pid)
        const lock = await holdSessionLock(h.sessionId)
        let released = false
        try {
            await insertAssistant(h, 'm1')
            await claim(h, 'm1')
            let settled = false
            const write = writer
                .insertStreamEvent({
                    sessionId: h.sessionId,
                    messageId: 'm1',
                    seq: 1,
                    eventType: 'token',
                    payloadJson: {},
                    createdAt: new Date()
                })
                .then((result) => {
                    settled = true
                    return result
                })
            await sleep(500)
            // Break the insert -> live -> lk dependency and the statement stops
            // blocking here: Postgres can skip the advisory lock and write the row.
            // Nothing that reads only the serialized SQL can prove otherwise.
            assert.equal(settled, false, 'the insert must wait for the lock')
            assert.equal(await waitStateOf(h, pid), 'Lock/advisory')
            // Blocked, and blocked before writing anything — so the lock is taken
            // ahead of the insert rather than after it.
            assert.equal(await heldXidLocks(h, pid), 0, 'nothing written yet')
            // And ahead of the id: whatever the sequence can still hand out while
            // we are stuck here is a floor our row has to clear.
            const floor = await nextSequenceValue(h)
            await lock.release()
            released = true
            const inserted = await write
            assert.equal(typeof inserted.id, 'bigint')
            assert.ok(
                (inserted.id as bigint) >= floor,
                `id ${inserted.id} predates the lock being granted (floor ${floor})`
            )
        } finally {
            if (!released) await lock.release()
            await closeDb(writerDb)
            await h.close()
        }
    }
)

test(
    'the advisory lock is per session, so other sessions write straight through',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        const lock = await holdSessionLock(h.sessionId)
        try {
            const otherSession = `${h.sessionId}_other`
            await h.db.insert(chatSessions).values({
                id: otherSession,
                userId: h.userId,
                agentId: h.agentId
            })
            await h.db.insert(chatMessages).values({
                id: 'm_other',
                sessionId: otherSession,
                role: 'assistant',
                contentBlocksJson: []
            })
            await h.db
                .update(chatSessions)
                .set({ inflightMessageId: 'm_other' })
                .where(eq(chatSessions.id, otherSession))
            const started = Date.now()
            const inserted = await h.repo.insertStreamEvent({
                sessionId: otherSession,
                messageId: 'm_other',
                seq: 1,
                eventType: 'token',
                payloadJson: {},
                createdAt: new Date()
            })
            // Serialising the whole table instead of one session would turn every
            // concurrent turn in the fleet into a queue behind the slowest writer.
            assert.notEqual(inserted.id, null)
            assert.ok(
                Date.now() - started < 2000,
                'must not block on another key'
            )
        } finally {
            await lock.release()
            await h.close()
        }
    }
)

// This states the invariant end to end. It is deliberately NOT the detector:
// with the lock removed it still passes at this scale, because the window
// between drawing an id and committing is only microseconds wide and the
// reader is paced. The test above is the one that reddens deterministically
// when the lock stops being held; this one says what the lock is for.
test(
    'concurrent writers on one session never hide a lower id behind a higher one',
    { skip: !RUN },
    async () => {
        const WRITERS = 8
        const PER_WRITER = 15
        const h = await buildHarness()
        const writerDb = createDb(dbUrl(), { max: WRITERS })
        const writers = new ChatRepository(writerDb)
        try {
            await insertAssistant(h, 'm1')
            await claim(h, 'm1')
            let cursor = 0n
            let stop = false
            const seen = new Set<string>()
            // Exactly what the SSE pump, Last-Event-ID resume and adoption replay
            // do: read forward from the highest id already handed out. An id that
            // becomes visible after a higher one is never read by anyone again.
            const reader = (async (): Promise<void> => {
                while (!stop) {
                    const rows = await h.db
                        .select({ id: chatStreamEvents.id })
                        .from(chatStreamEvents)
                        .where(
                            and(
                                eq(chatStreamEvents.sessionId, h.sessionId),
                                gt(chatStreamEvents.id, cursor)
                            )
                        )
                        .orderBy(chatStreamEvents.id)
                    for (const row of rows) {
                        seen.add(row.id.toString())
                        if (row.id > cursor) cursor = row.id
                    }
                    // Paced rather than spun. An unpaced loop reads as fast as the
                    // server can answer for the whole test, and this suite runs
                    // its files in parallel — one file monopolising a core makes
                    // the wall-clock budgets in other pg tests flake.
                    await sleep(1)
                }
            })()
            let seq = 0
            await Promise.all(
                Array.from({ length: WRITERS }, async () => {
                    for (let i = 0; i < PER_WRITER; i++)
                        await writers.insertStreamEvent({
                            sessionId: h.sessionId,
                            messageId: 'm1',
                            seq: ++seq,
                            eventType: 'token',
                            payloadJson: {},
                            createdAt: new Date()
                        })
                })
            )
            await sleep(250)
            stop = true
            await reader
            const all = await h.db
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(eq(chatStreamEvents.sessionId, h.sessionId))
            assert.equal(all.length, WRITERS * PER_WRITER)
            const skipped = all
                .map((row) => row.id.toString())
                .filter((id) => !seen.has(id))
            assert.deepEqual(
                skipped,
                [],
                'a cursor reader skipped committed ids'
            )
        } finally {
            await closeDb(writerDb)
            await h.close()
        }
    }
)

test(
    'the dedup path still drops a replayed (message, key, ordinal)',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertAssistant(h, 'm1')
            await claim(h, 'm1')
            const first = await h.repo.insertStreamEvent({
                sessionId: h.sessionId,
                messageId: 'm1',
                seq: 1,
                eventType: 'tool_call',
                payloadJson: { text: 'original' },
                sourceEventKey: 'k1',
                sourceEventOrdinal: 0,
                createdAt: new Date()
            })
            assert.equal(typeof first.id, 'bigint')
            const replay = await h.repo.insertStreamEvent({
                sessionId: h.sessionId,
                messageId: 'm1',
                seq: 2,
                eventType: 'tool_call',
                payloadJson: { text: 'REPLAYED' },
                sourceEventKey: 'k1',
                sourceEventOrdinal: 0,
                createdAt: new Date()
            })
            assert.equal(replay.id, null, 'a dropped row must report null')
            const [stored] = await h.db
                .select({ payload: chatStreamEvents.payloadJson })
                .from(chatStreamEvents)
                .where(eq(chatStreamEvents.id, first.id as bigint))
            assert.deepEqual(stored.payload, { text: 'original' })
            // A plain row shares no dedup key, so it can never be dropped.
            const plain = await h.repo.insertStreamEvent({
                sessionId: h.sessionId,
                messageId: 'm1',
                seq: 3,
                eventType: 'token',
                payloadJson: {},
                createdAt: new Date()
            })
            assert.notEqual(plain.id, null)
        } finally {
            await h.close()
        }
    }
)

// #674. Durable suspension→resume transitions and what they buy, against the
// real partial unique index rather than a fake that agrees with the
// implementation. Pinning every resume to ordinal 0 made the second
// announcement collide with the first and vanish; counting raw suspensions
// would make duplicate cross-replica writers impersonate extra attempts.
test(
    'suspension transitions advance once and distinct attempts survive dedup',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertAssistant(h, 'm1')
            await claim(h, 'm1')
            let seq = 0
            const suspend = async (): Promise<void> => {
                await h.repo.insertStreamEvent({
                    sessionId: h.sessionId,
                    messageId: 'm1',
                    seq: ++seq,
                    eventType: 'suspended',
                    payloadJson: { reason: 'daemon offline' },
                    createdAt: new Date()
                })
            }
            const announceResume = async (
                ordinal: number,
                eventSeq = ++seq
            ): Promise<bigint | null> => {
                const row = await h.repo.insertStreamEvent({
                    sessionId: h.sessionId,
                    messageId: 'm1',
                    seq: eventSeq,
                    eventType: 'turn_status',
                    payloadJson: { type: 'turn_status', phase: 'resuming' },
                    sourceEventKey: '__turn_status_resuming__',
                    sourceEventOrdinal: ordinal,
                    createdAt: new Date()
                })
                return row.id
            }

            // Token rows must not be counted as attempts, and a turn that never
            // suspended resumes under 0 — the identity this always used.
            await h.repo.insertStreamEvent({
                sessionId: h.sessionId,
                messageId: 'm1',
                seq: ++seq,
                eventType: 'token',
                payloadJson: { text: 'partial ' },
                createdAt: new Date()
            })
            assert.equal(
                await h.repo.boundedResumeStatusOrdinal(
                    'm1',
                    '__turn_status_resuming__',
                    4
                ),
                0
            )

            await suspend()
            const concurrentOrdinals = await Promise.all([
                h.repo.boundedResumeStatusOrdinal(
                    'm1',
                    '__turn_status_resuming__',
                    4
                ),
                h.repo.boundedResumeStatusOrdinal(
                    'm1',
                    '__turn_status_resuming__',
                    4
                )
            ])
            assert.deepEqual(concurrentOrdinals, [0, 0])
            const concurrentSeq = ++seq
            const concurrentRows = await Promise.all([
                announceResume(concurrentOrdinals[0], concurrentSeq),
                announceResume(concurrentOrdinals[1], concurrentSeq)
            ])
            assert.equal(
                concurrentRows.filter((id) => id !== null).length,
                1,
                'same-attempt writers collapse on the real partial unique index'
            )

            await suspend()
            await suspend()
            assert.equal(
                await h.repo.boundedResumeStatusOrdinal(
                    'm1',
                    '__turn_status_resuming__',
                    4
                ),
                1,
                'duplicate suspensions advance one transition, not two'
            )
            // The gate: the second re-dial's announcement is a new row, not a
            // silent no-op, so the client leaves stale suspended presentation.
            // Ordinal comes from the real transition query, not from the test.
            assert.notEqual(
                await announceResume(
                    await h.repo.boundedResumeStatusOrdinal(
                        'm1',
                        '__turn_status_resuming__',
                        4
                    )
                ),
                null
            )
            assert.equal(
                await h.repo.boundedResumeStatusOrdinal(
                    'm1',
                    '__turn_status_resuming__',
                    4
                ),
                1,
                'without a newer suspension the same attempt reuses its ordinal'
            )
            // A replay of the same derived identity still collapses.
            assert.equal(await announceResume(1), null)

            await suspend()
            assert.notEqual(await announceResume(2), null)
            await suspend()
            assert.notEqual(await announceResume(3), null)
            await suspend()
            assert.notEqual(await announceResume(4), null)
            await suspend()
            assert.equal(
                await h.repo.boundedResumeStatusOrdinal(
                    'm1',
                    '__turn_status_resuming__',
                    4
                ),
                4,
                'the durable transition ordinal stays capped'
            )

            // Another turn's suspensions are not this turn's attempts.
            await insertAssistant(h, 'm2')
            assert.equal(
                await h.repo.boundedResumeStatusOrdinal(
                    'm2',
                    '__turn_status_resuming__',
                    4
                ),
                0
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a terminal source-key collision changes no turn state and remains retryable',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertAssistant(h, 'm1')
            await claim(h, 'm1')
            await h.repo.insertStreamEvent({
                sessionId: h.sessionId,
                messageId: 'm1',
                seq: 1,
                eventType: 'tool_call',
                payloadJson: { toolCallId: 'call-1' },
                sourceEventKey: 'shared-key',
                sourceEventOrdinal: 0,
                createdAt: new Date()
            })

            const refused = await h.repo.insertStreamEvent(
                {
                    sessionId: h.sessionId,
                    messageId: 'm1',
                    seq: 2,
                    eventType: 'done',
                    payloadJson: { finalMessageId: 'm1' },
                    sourceEventKey: 'shared-key',
                    sourceEventOrdinal: 0,
                    createdAt: new Date()
                },
                {
                    contentBlocksJson: [{ type: 'text', text: 'wrong' }],
                    contentCheckpointEventId: null
                }
            )
            assert.equal(refused.id, null)
            assert.equal(await readClaim(h), 'm1')
            const [afterRefusal] = await h.db
                .select({ content: chatMessages.contentBlocksJson })
                .from(chatMessages)
                .where(eq(chatMessages.id, 'm1'))
            assert.deepEqual(afterRefusal.content, [])
            const terminalsAfterRefusal = await h.db
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(
                    and(
                        eq(chatStreamEvents.messageId, 'm1'),
                        eq(chatStreamEvents.eventType, 'done')
                    )
                )
            assert.equal(terminalsAfterRefusal.length, 0)

            const retry = await h.repo.insertStreamEvent(
                {
                    sessionId: h.sessionId,
                    messageId: 'm1',
                    seq: 2,
                    eventType: 'done',
                    payloadJson: { finalMessageId: 'm1' },
                    sourceEventKey: 'terminal-key',
                    sourceEventOrdinal: 0,
                    createdAt: new Date()
                },
                {
                    contentBlocksJson: [{ type: 'text', text: 'final' }],
                    contentCheckpointEventId: null
                }
            )
            assert.equal(typeof retry.id, 'bigint')
            assert.equal(await readClaim(h), null)
            const [afterRetry] = await h.db
                .select({ content: chatMessages.contentBlocksJson })
                .from(chatMessages)
                .where(eq(chatMessages.id, 'm1'))
            assert.deepEqual(afterRetry.content, [
                { type: 'text', text: 'final' }
            ])
        } finally {
            await h.close()
        }
    }
)

test(
    'a rejected terminal transaction rolls back its row and remains retryable',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        const terminalRow = {
            sessionId: h.sessionId,
            messageId: 'm1',
            seq: 1,
            eventType: 'done' as const,
            payloadJson: { finalMessageId: 'm1' },
            sourceEventKey: 'terminal-key',
            sourceEventOrdinal: 0,
            createdAt: new Date()
        }
        try {
            await insertAssistant(h, 'm1')
            await claim(h, 'm1')
            await assert.rejects(
                h.repo.insertStreamEvent(terminalRow, {
                    contentBlocksJson: [
                        {
                            type: 'text',
                            text: `invalid${String.fromCharCode(0)}`
                        }
                    ],
                    contentCheckpointEventId: null
                })
            )
            assert.equal(await readClaim(h), 'm1')
            const terminalsAfterRejection = await h.db
                .select({ id: chatStreamEvents.id })
                .from(chatStreamEvents)
                .where(
                    and(
                        eq(chatStreamEvents.messageId, 'm1'),
                        eq(chatStreamEvents.eventType, 'done')
                    )
                )
            assert.equal(terminalsAfterRejection.length, 0)

            const retry = await h.repo.insertStreamEvent(terminalRow, {
                contentBlocksJson: [{ type: 'text', text: 'final' }],
                contentCheckpointEventId: null
            })
            assert.equal(typeof retry.id, 'bigint')
            assert.equal(await readClaim(h), null)
        } finally {
            await h.close()
        }
    }
)

test(
    'Postgres plans the statement, and draws the id from the node that reads the lock',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertAssistant(h, 'm1')
            await claim(h, 'm1')
            const explain = async (
                row: Parameters<typeof nonTerminalStreamEventInsert>[0]
            ): Promise<string> => {
                const plan = (await h.db.execute(
                    sql`explain (verbose, costs off) ${nonTerminalStreamEventInsert(row)}`
                )) as unknown as Array<Record<string, string>>
                return plan.map((line) => Object.values(line)[0]).join('\n')
            }
            const base = {
                sessionId: h.sessionId,
                messageId: 'm1',
                eventType: 'token' as const,
                payloadJson: { text: 'x' },
                createdAt: new Date()
            }
            const plain = await explain({ ...base, seq: 1 })
            assert.match(plain, /CTE lk/)
            assert.match(plain, /pg_advisory_xact_lock/)
            // The id comes out of the live CTE Scan's own projection, which cannot
            // run until live has checked the claim and pulled a row out of lk.
            assert.match(
                plain,
                /CTE Scan on live\s+Output: nextval\('chat_stream_events_id_seq'/
            )
            const dedup = await explain({
                ...base,
                seq: 2,
                sourceEventKey: 'k1',
                sourceEventOrdinal: 0
            })
            assert.match(
                dedup,
                /Conflict Arbiter Indexes: chat_stream_events_source_dedup_unique/
            )
        } finally {
            await h.close()
        }
    }
)

// Statements, not round trips: the driver hook below counts calls into
// postgres.js, and with prepare: false each parameterised statement is two
// protocol exchanges (Parse/Describe/Flush, wait for the parameter metadata,
// then Bind/Execute/Sync) while an unparameterised one is a single write.
// Measured on local pg 16.10 [2026-08-09] by framing the messages on the
// socket: the old non-terminal write was 6 exchanges and is now 2. The plain
// terminal path adds terminal-admission, content-replay and cache-update
// statements because final content now commits atomically with the terminal.
test(
    'a non-terminal insert is one statement; a terminal one keeps its transaction',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        const sent: string[] = []
        let recording = false
        const client = postgres(dbUrl(), {
            prepare: false,
            max: 1,
            debug: (_connection, query) => {
                if (recording) sent.push(query.replace(/\s+/g, ' ').trim())
            }
        })
        const repo = new ChatRepository(
            drizzle(client, { schema }) as unknown as Database
        )
        try {
            await insertAssistant(h, 'm1')
            await claim(h, 'm1')
            const fence = await repo.upsertTurnExecution({
                messageId: 'm1',
                sessionId: h.sessionId,
                agentId: h.agentId,
                runtime: 'sprites',
                spriteName: 'sp',
                ownerId: 'owner-1',
                leaseSeconds: 60
            })
            assert.ok(fence)
            const row = (
                seq: number,
                eventType: 'token' | 'done'
            ): Parameters<ChatRepository['insertStreamEvent']>[0] => ({
                sessionId: h.sessionId,
                messageId: 'm1',
                seq,
                eventType,
                payloadJson: {},
                createdAt: new Date()
            })
            // Warm the connection first: postgres.js runs a one-off pg_type lookup
            // on its first parameterised query, which is not part of any insert.
            await repo.insertStreamEvent(row(1, 'token'), undefined, fence)

            recording = true
            await repo.insertStreamEvent(row(2, 'token'), undefined, fence)
            recording = false
            assert.deepEqual(sent.length, 1, sent.join(' | '))
            assert.match(
                sent[0],
                /^with lk as materialized \( select pg_advisory_xact_lock/
            )
            assert.match(sent[0], /for update of turn_executions/)

            sent.length = 0
            recording = true
            await repo.insertStreamEvent(row(3, 'done'), undefined, fence)
            recording = false
            // Deliberately still a transaction, with a terminal-admission query:
            // statements: the terminal row, the cleared inflight claim and the
            // closed turn_executions record have to become visible together or a
            // turn can be terminal and adoptable at the same time.
            assert.equal(sent.length, 11, sent.join(' | '))
            assert.equal(sent[0], 'begin')
            assert.match(sent[1], /^select pg_advisory_xact_lock/)
            assert.match(sent[2], /^select pg_advisory_xact_lock/)
            assert.match(sent[3], /^select "message_id" from "turn_executions"/)
            assert.match(sent[4], /^select "id" from "chat_stream_events"/)
            assert.match(sent[5], /^insert into "chat_stream_events"/)
            assert.match(
                sent[6],
                /^select "id", "event_type", "payload_json" from "chat_stream_events"/
            )
            assert.match(sent[7], /^update "chat_messages"/)
            assert.match(
                sent[5],
                /coalesce\(\( select max\("chat_stream_events"\."seq"\)/
            )
            assert.match(sent[8], /^update "chat_sessions"/)
            assert.match(sent[9], /^update "turn_executions"/)
            assert.equal(sent[10], 'commit')
        } finally {
            await client.end()
            await h.close()
        }
    }
)
