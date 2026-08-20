import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { asc, eq, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    chatMessages,
    chatSessions,
    chatStreamEvents,
    createDb,
    plans,
    users,
    type Database
} from '@manyfold/db'
import { withScratchDatabase } from '../scripts/scratch-db'
import { ChatRetentionService } from '../src/modules/chat-retention/chat-retention.service'
import {
    readStreamLogCompactBatch,
    streamLogCompactStatement
} from '../src/modules/chat-retention/stream-log-compaction'
import { ASSISTANT_BLOCKS_TRUNCATION_MARKER } from '../src/modules/chat/assistant-blocks'
import { ChatRepository } from '../src/modules/chat/chat.repository'

// #672. The compaction sweep is fleet-wide: unlike the per-user retention
// sweep it takes no user id, so pointing it at a shared database would delete
// real token rows. Every test therefore creates, migrates and drops a
// throwaway database of its own through the scratch lifecycle, and this file
// never loads .env — the destructive target can only be a database this run
// made. Everything the sweep decides is a SQL predicate the fake db cannot
// express: the survivor set, the cap the DELETE itself enforces, the evidence
// the same statement writes, and the atomicity that ties the two together.
// Run per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/stream-log-compaction.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

const DAY_MS = 24 * 60 * 60 * 1000
const OLD = new Date(Date.now() - 90 * DAY_MS)
const YOUNG = new Date(Date.now() - 1 * DAY_MS)

type EventType = (typeof chatStreamEvents.$inferSelect)['eventType']

interface Tuning {
    batchSize: number
    pauseMs: number
    maxRows: number
    maxMessages: number
}

interface Harness {
    db: Database
    url: string
    service: ChatRetentionService
    build: (opts?: {
        config?: Record<string, string>
        tuning?: Partial<Tuning>
    }) => ChatRetentionService
    events: Array<[string, Record<string, unknown>]>
    sessionId: string
}

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

// create → migrate → connect → fixture → body → close → drop. The close is in
// the unwind path, so an assertion failure lands where a passing run does and
// the drop is never left waiting on a connection this file opened.
const withHarness = async (
    body: (harness: Harness) => Promise<void>
): Promise<void> =>
    withScratchDatabase('slc', async ({ url }) => {
        const db = createDb(url)
        const errors: unknown[] = []
        try {
            const suffix = randomBytes(6).toString('hex')
            const events: Array<[string, Record<string, unknown>]> = []
            const build = (
                opts: {
                    config?: Record<string, string>
                    tuning?: Partial<Tuning>
                } = {}
            ): ChatRetentionService => {
                const service = new ChatRetentionService(
                    db,
                    { get: (key: string) => opts.config?.[key] } as never,
                    undefined,
                    {
                        event: (name: string, attrs: Record<string, unknown>) =>
                            events.push([name, attrs])
                    } as never
                )
                // The shipped caps are 200,000 rows out; a test that wanted to
                // watch one being enforced would have to seed its way there.
                // The knobs are moved so the cap under test is a few rows
                // away, and the inter-batch pause is dropped so a convergence
                // loop is not a wall-clock test.
                Object.assign(
                    (service as unknown as { compaction: Tuning }).compaction,
                    { pauseMs: 0, ...opts.tuning }
                )
                return service
            }

            const planId = `plan_${suffix}`
            const userId = `user_${suffix}`
            const runtimeId = `art_${suffix}`
            const agentId = `agt_${suffix}`
            const sessionId = `cts_${suffix}`
            // retention NULL keeps the retention sweep out of this run
            // entirely, so every deleted row is attributable to compaction.
            await db.insert(plans).values({
                id: planId,
                name: `pgtest-${suffix}`,
                maxAgentsProvisioned: 3,
                maxConcurrentActive: 1,
                maxStorageGb: 3,
                messageHistoryRetentionDays: null
            })
            await db
                .insert(users)
                .values({ id: userId, email: `${suffix}@pgtest.local`, planId })
            await db.insert(agentRuntimes).values({
                id: runtimeId,
                userId,
                name: `rt-${suffix}`,
                framework: 'dify',
                kind: 'external'
            })
            await db.insert(agents).values({
                id: agentId,
                userId,
                name: 'pgtest-agent',
                framework: 'dify',
                runtime: 'external',
                runtimeId,
                internalId: `internal-${agentId}`
            })
            await db
                .insert(chatSessions)
                .values({ id: sessionId, userId, agentId })

            await body({ db, url, service: build(), build, events, sessionId })
        } catch (error) {
            errors.push(error)
        }

        try {
            await closeDb(db)
        } catch (error) {
            errors.push(error)
        }

        if (errors.length === 1) throw errors[0]
        if (errors.length > 1)
            throw new AggregateError(
                errors,
                `compaction harness failed: ${errors
                    .map((error) =>
                        error instanceof Error ? error.message : String(error)
                    )
                    .join('; ')}`
            )
    })

const seedMessage = async (
    h: Harness,
    id: string,
    opts: {
        role?: 'assistant' | 'user'
        createdAt: Date
        truncated?: boolean
        // [eventType, createdAt] in the order the ids must be assigned
        events: Array<[EventType, Date]>
    }
): Promise<void> => {
    await h.db.insert(chatMessages).values({
        id,
        sessionId: h.sessionId,
        role: opts.role ?? 'assistant',
        contentBlocksJson: opts.truncated
            ? [
                  {
                      type: 'text',
                      text: `${ASSISTANT_BLOCKS_TRUNCATION_MARKER}what survived`
                  }
              ]
            : [{ type: 'text', text: 'an ordinary answer' }],
        createdAt: opts.createdAt
    })
    let seq = 0
    for (const [eventType, createdAt] of opts.events) {
        seq += 1
        // One insert per row: the lateral picks the newest row by id, so id
        // order has to follow the emit order these fixtures describe.
        await h.db.insert(chatStreamEvents).values({
            sessionId: h.sessionId,
            messageId: id,
            seq,
            eventType,
            payloadJson: { text: 'x' },
            createdAt
        })
    }
}

// A finished turn of arbitrary size. Two statements rather than one per row:
// the cap tests need hundreds of rows and only two orderings matter — every
// token before the terminal, and the terminal newest.
const seedTurn = async (
    h: Harness,
    id: string,
    tokens: number
): Promise<void> => {
    const at = OLD.toISOString()
    await h.db.insert(chatMessages).values({
        id,
        sessionId: h.sessionId,
        role: 'assistant',
        contentBlocksJson: [{ type: 'text', text: 'an ordinary answer' }],
        createdAt: OLD
    })
    if (tokens > 0)
        await h.db.execute(sql`
            insert into chat_stream_events
                (session_id, message_id, seq, event_type, payload_json, created_at)
            select ${h.sessionId}, ${id}, g, 'token', '{"text":"x"}'::jsonb,
                   ${at}::timestamptz
            from generate_series(1, ${tokens}) g
        `)
    await h.db.insert(chatStreamEvents).values({
        sessionId: h.sessionId,
        messageId: id,
        seq: tokens + 1,
        eventType: 'done',
        payloadJson: { text: 'x' },
        createdAt: OLD
    })
}

const survivingTypes = async (h: Harness, id: string): Promise<string[]> => {
    const rows = await h.db
        .select({ eventType: chatStreamEvents.eventType })
        .from(chatStreamEvents)
        .where(eq(chatStreamEvents.messageId, id))
        .orderBy(asc(chatStreamEvents.id))
    return rows.map((r) => r.eventType)
}

const survivingTokens = async (h: Harness, id: string): Promise<number> =>
    (await survivingTypes(h, id)).filter((type) => type === 'token').length

interface Evidence {
    rows: number
    at: Date | null
}

const evidenceOf = async (h: Harness, id: string): Promise<Evidence> => {
    const [row] = await h.db
        .select({
            rows: chatMessages.compactedStreamRows,
            at: chatMessages.streamCompactedAt
        })
        .from(chatMessages)
        .where(eq(chatMessages.id, id))
    assert.ok(row, `${id} must exist`)
    return { rows: row.rows, at: row.at }
}

const totalStreamRows = async (h: Harness): Promise<number> => {
    const rows = (await h.db.execute(
        sql`select count(*)::int as value from chat_stream_events`
    )) as Array<{ value: number | string }>
    return Number(rows[0]?.value ?? -1)
}

const totalEvidenceRows = async (h: Harness): Promise<number> => {
    const rows = (await h.db.execute(sql`
        select coalesce(sum(compacted_stream_rows), 0)::bigint as value
        from chat_messages
    `)) as Array<{ value: number | string }>
    return Number(rows[0]?.value ?? -1)
}

const withCompaction = async <T>(
    days: string | undefined,
    fn: () => Promise<T>
): Promise<T> => {
    const previous = process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS
    if (days === undefined) delete process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS
    else process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS = days
    try {
        return await fn()
    } finally {
        if (previous === undefined)
            delete process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS
        else process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS = previous
    }
}

const seedFixtures = async (h: Harness): Promise<void> => {
    // Compactable: aged assistant turn whose newest row is an aged `done`.
    await seedMessage(h, 'cms_compactable', {
        createdAt: OLD,
        events: [
            ['token', OLD],
            ['thinking', OLD],
            ['tool_call', OLD],
            ['tool_result', OLD],
            ['replace', OLD],
            ['done', OLD]
        ]
    })
    // Compactable: `error` is a terminal too.
    await seedMessage(h, 'cms_errored', {
        createdAt: OLD,
        events: [
            ['token', OLD],
            ['thinking', OLD],
            ['error', OLD]
        ]
    })
    // NEVER: content_blocks_json was truncated, so these rows are the only
    // surviving copy of what the turn produced.
    await seedMessage(h, 'cms_truncated', {
        createdAt: OLD,
        truncated: true,
        events: [
            ['token', OLD],
            ['thinking', OLD],
            ['done', OLD]
        ]
    })
    // NEVER: no terminal row at all — the turn may still be running.
    await seedMessage(h, 'cms_no_terminal', {
        createdAt: OLD,
        events: [
            ['token', OLD],
            ['thinking', OLD],
            ['tool_call', OLD]
        ]
    })
    // NEVER: something wrote after the terminal, so the log is still moving.
    await seedMessage(h, 'cms_post_terminal', {
        createdAt: OLD,
        events: [
            ['token', OLD],
            ['thinking', OLD],
            ['done', OLD],
            ['replace', OLD]
        ]
    })
    // NEVER: terminal is inside the window, readers may still resume from it.
    await seedMessage(h, 'cms_young_terminal', {
        createdAt: OLD,
        events: [
            ['token', OLD],
            ['thinking', OLD],
            ['done', YOUNG]
        ]
    })
    // NEVER: the whole turn is young.
    await seedMessage(h, 'cms_young', {
        createdAt: YOUNG,
        events: [
            ['token', YOUNG],
            ['thinking', YOUNG],
            ['done', YOUNG]
        ]
    })
    // NEVER: not an assistant message.
    await seedMessage(h, 'cms_user', {
        role: 'user',
        createdAt: OLD,
        events: [
            ['token', OLD],
            ['done', OLD]
        ]
    })
}

const UNTOUCHED = [
    'cms_truncated',
    'cms_no_terminal',
    'cms_post_terminal',
    'cms_young_terminal',
    'cms_young',
    'cms_user'
]

test(
    'stream log compaction keeps every row it cannot prove is dead',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await seedFixtures(h)

            const first = await withCompaction('7', () => h.service.runOnce())

            assert.equal(
                first.streamLog.messagesCompacted,
                2,
                'only the two aged, terminated, untruncated assistant turns'
            )
            assert.equal(
                first.streamLog.rowsDeleted,
                4,
                'two token + two thinking rows'
            )
            assert.equal(first.streamLog.capped, false)

            assert.deepEqual(
                await survivingTypes(h, 'cms_compactable'),
                ['tool_call', 'tool_result', 'replace', 'done'],
                'transcript and terminal rows survive compaction'
            )
            assert.deepEqual(await survivingTypes(h, 'cms_errored'), ['error'])

            for (const [id, expected] of [
                ['cms_truncated', ['token', 'thinking', 'done']],
                ['cms_no_terminal', ['token', 'thinking', 'tool_call']],
                ['cms_post_terminal', ['token', 'thinking', 'done', 'replace']],
                ['cms_young_terminal', ['token', 'thinking', 'done']],
                ['cms_young', ['token', 'thinking', 'done']],
                ['cms_user', ['token', 'done']]
            ] as Array<[string, string[]]>)
                assert.deepEqual(
                    await survivingTypes(h, id),
                    expected,
                    `${id} must be left untouched`
                )

            // The evidence half of #672: a reader of these two turns can now
            // tell a quiet turn from a compacted one, and every turn the sweep
            // refused still reads as never compacted.
            for (const id of ['cms_compactable', 'cms_errored']) {
                const evidence = await evidenceOf(h, id)
                assert.equal(evidence.rows, 2, `${id} lost two rows`)
                assert.ok(
                    evidence.at instanceof Date,
                    `${id} records when it was compacted`
                )
            }
            for (const id of UNTOUCHED)
                assert.deepEqual(
                    await evidenceOf(h, id),
                    { rows: 0, at: null },
                    `${id} was never compacted and must not claim it was`
                )
        })
)

test(
    'a second compaction run deletes nothing and does not inflate the evidence',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await seedFixtures(h)

            await withCompaction('7', () => h.service.runOnce())
            const after = await evidenceOf(h, 'cms_compactable')
            const second = await withCompaction('7', () => h.service.runOnce())

            assert.equal(second.streamLog.messagesCompacted, 0)
            assert.equal(second.streamLog.rowsDeleted, 0)
            assert.equal(second.streamLog.capped, false)
            assert.deepEqual(await survivingTypes(h, 'cms_compactable'), [
                'tool_call',
                'tool_result',
                'replace',
                'done'
            ])
            // A run that deleted nothing wrote nothing: same count, same
            // timestamp, so "last compacted" stays the truth rather than
            // drifting forward every night the sweep ticks.
            assert.deepEqual(
                await evidenceOf(h, 'cms_compactable'),
                after,
                'a no-op run must leave the evidence exactly as it was'
            )
        })
)

test('an unset window touches nothing at all', { skip: !RUN }, async () =>
    withHarness(async (h) => {
        await seedFixtures(h)

        const result = await withCompaction(undefined, () =>
            h.service.runOnce()
        )

        assert.equal(result.streamLog.messagesCompacted, 0)
        assert.deepEqual(await survivingTypes(h, 'cms_compactable'), [
            'token',
            'thinking',
            'tool_call',
            'tool_result',
            'replace',
            'done'
        ])
        assert.deepEqual(await evidenceOf(h, 'cms_compactable'), {
            rows: 0,
            at: null
        })
    })
)

test(
    'the growth metric reports real catalog numbers',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await seedFixtures(h)
            // reltuples is -1 until the table has been analyzed at least once.
            await h.db.execute(sql`analyze chat_stream_events`)

            await withCompaction(undefined, () => h.service.runOnce())

            const size = h.events.find(
                ([name]) => name === 'chat.stream_log.size'
            )
            assert.ok(size, 'the size event fires with compaction disabled')
            const attrs = size[1] as {
                estimatedRows: number
                totalBytes: number
            }
            assert.equal(
                attrs.estimatedRows,
                27,
                'reltuples matches the seeded row count after ANALYZE'
            )
            assert.ok(
                attrs.totalBytes > 0,
                `total relation size must be real, got ${attrs.totalBytes}`
            )
        })
)

// The half of #672 that made "just set MF_STREAM_LOG_COMPACT_AFTER_DAYS to
// preview it" an unsafe instruction: compaction ignored CHAT_RETENTION_DRY_RUN
// entirely, so the preview deleted.
test(
    'a compaction dry run reports the rows it would delete, deletes none and records none',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await seedFixtures(h)
            const before = await survivingTypes(h, 'cms_compactable')

            const preview = await withCompaction('7', () =>
                h
                    .build({
                        config: { CHAT_RETENTION_DRY_RUN: '1' },
                        tuning: { maxRows: 3 }
                    })
                    .runOnce()
            )

            assert.equal(preview.streamLog.dryRun, true)
            assert.equal(preview.streamLog.messagesCompacted, 2)
            assert.equal(
                preview.streamLog.rowsDeleted,
                3,
                'the preview itself obeys the hard row cap'
            )
            assert.equal(preview.streamLog.capped, true)
            assert.deepEqual(
                await survivingTypes(h, 'cms_compactable'),
                before,
                'a preview writes nothing'
            )
            assert.deepEqual(await survivingTypes(h, 'cms_errored'), [
                'token',
                'thinking',
                'error'
            ])
            // Evidence is a record of deletion, so a preview must leave none:
            // a turn that still holds every row it produced would otherwise
            // read as compacted for the rest of its life.
            for (const id of ['cms_compactable', 'cms_errored', ...UNTOUCHED])
                assert.deepEqual(
                    await evidenceOf(h, id),
                    { rows: 0, at: null },
                    `${id} must carry no evidence after a dry run`
                )

            // And the same window, applied for real, takes exactly what the
            // preview promised.
            const real = await withCompaction('7', () =>
                h.build({ tuning: { maxRows: 3 } }).runOnce()
            )
            assert.equal(real.streamLog.dryRun, false)
            assert.equal(real.streamLog.rowsDeleted, 3)
            assert.deepEqual(await survivingTypes(h, 'cms_compactable'), [
                'tool_call',
                'tool_result',
                'replace',
                'done'
            ])
            assert.equal((await evidenceOf(h, 'cms_compactable')).rows, 2)

            const residue = await withCompaction('7', () =>
                h.build({ tuning: { maxRows: 3 } }).runOnce()
            )
            assert.equal(residue.streamLog.rowsDeleted, 1)
            assert.equal((await evidenceOf(h, 'cms_errored')).rows, 2)
        })
)

// #672's first gate. One turn holding more rows than the whole run's budget is
// the case the old code could not survive: it tested the budget between
// batches and then issued an unbounded delete, so this single message gave up
// all 50 rows in one statement no matter what the cap said.
test(
    'a turn larger than the run budget is compacted across runs, never in one bite',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await seedTurn(h, 'cms_oversized', 50)
            const run = (): Promise<{ rowsDeleted: number; capped: boolean }> =>
                withCompaction('7', async () => {
                    const result = await h
                        .build({ tuning: { maxRows: 20 } })
                        .runOnce()
                    return result.streamLog
                })

            const first = await run()
            assert.equal(first.rowsDeleted, 20, 'the budget is the hard cap')
            assert.equal(first.capped, true)
            assert.equal(await survivingTokens(h, 'cms_oversized'), 30)
            const afterFirst = await evidenceOf(h, 'cms_oversized')
            assert.equal(afterFirst.rows, 20)
            assert.ok(afterFirst.at instanceof Date)

            const second = await run()
            assert.equal(second.rowsDeleted, 20)
            assert.equal(second.capped, true)
            const afterSecond = await evidenceOf(h, 'cms_oversized')
            assert.equal(
                afterSecond.rows,
                40,
                'the count accumulates across runs instead of restarting'
            )
            assert.ok(
                afterSecond.at instanceof Date &&
                    afterFirst.at instanceof Date &&
                    afterSecond.at.getTime() >= afterFirst.at.getTime(),
                'the timestamp is the last compaction, not the first'
            )

            const third = await run()
            assert.equal(third.rowsDeleted, 10, 'the residue, and only that')
            assert.equal(
                third.capped,
                false,
                'a run that emptied the backlog is not capped'
            )
            assert.deepEqual(await survivingTypes(h, 'cms_oversized'), ['done'])
            assert.equal((await evidenceOf(h, 'cms_oversized')).rows, 50)

            const fourth = await run()
            assert.equal(fourth.rowsDeleted, 0)
            assert.equal(
                (await evidenceOf(h, 'cms_oversized')).rows,
                50,
                'no double counting once there is nothing left to delete'
            )
        })
)

// The same cap, reached by a batch rather than by one message: 200 ordinary
// turns used to overshoot in aggregate exactly as one fat turn did alone.
test(
    'a batch stops at the budget and leaves exactly one turn part-compacted',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const ids = ['cms_batch_a', 'cms_batch_b', 'cms_batch_c']
            for (const id of ids) await seedTurn(h, id, 10)

            const first = await withCompaction('7', () =>
                h.build({ tuning: { maxRows: 25 } }).runOnce()
            )

            assert.equal(
                first.streamLog.rowsDeleted,
                25,
                'the batch held 30 deletable rows and stopped at 25'
            )
            assert.equal(first.streamLog.messagesCompacted, 3)
            assert.equal(first.streamLog.capped, true)
            assert.equal(
                await totalStreamRows(h),
                33 - 25,
                'nothing outside the budget was touched'
            )

            let partial = 0
            let recorded = 0
            for (const id of ids) {
                const left = await survivingTokens(h, id)
                const evidence = await evidenceOf(h, id)
                recorded += evidence.rows
                if (left > 0) partial += 1
                // Per turn, not only in total: this is the property that makes
                // a truncated run readable afterwards.
                assert.equal(
                    evidence.rows + left,
                    10,
                    `${id} must account for every row it started with`
                )
                assert.ok(
                    evidence.at instanceof Date,
                    `${id} lost rows and must say when`
                )
            }
            assert.equal(recorded, 25, 'the evidence sums to the rows deleted')
            assert.equal(
                partial,
                1,
                'the cap truncates one turn, not every turn in the batch'
            )

            const second = await withCompaction('7', () =>
                h.build({ tuning: { maxRows: 25 } }).runOnce()
            )
            assert.equal(second.streamLog.rowsDeleted, 5, 'the residue')
            assert.equal(second.streamLog.capped, false)
            for (const id of ids) {
                assert.deepEqual(await survivingTypes(h, id), ['done'])
                assert.equal((await evidenceOf(h, id)).rows, 10)
            }
        })
)

test(
    'a full 200-message batch cannot exceed its remaining row budget',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const ids = Array.from(
                { length: 200 },
                (_, index) => `cms_full_batch_${String(index).padStart(3, '0')}`
            )
            for (const id of ids) await seedTurn(h, id, 2)

            const run = (): Promise<{
                rowsDeleted: number
                messagesCompacted: number
                capped: boolean
            }> =>
                withCompaction('7', async () => {
                    const result = await h
                        .build({
                            tuning: {
                                batchSize: 200,
                                maxMessages: 200,
                                maxRows: 250
                            }
                        })
                        .runOnce()
                    return result.streamLog
                })

            const first = await run()
            assert.equal(first.rowsDeleted, 250)
            assert.equal(first.messagesCompacted, 125)
            assert.equal(first.capped, true)
            assert.equal(await totalEvidenceRows(h), 250)

            const second = await run()
            assert.equal(second.rowsDeleted, 150)
            assert.equal(second.capped, false)
            assert.equal(await totalEvidenceRows(h), 400)
            assert.equal(
                await totalStreamRows(h),
                200,
                'only the terminal row of each turn survives'
            )
        })
)

test(
    'a run whose backlog exactly equals the budget reports capped, and the next one does not',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const ids = ['cms_exact_a', 'cms_exact_b', 'cms_exact_c']
            for (const id of ids) await seedTurn(h, id, 10)

            const first = await withCompaction('7', () =>
                h.build({ tuning: { maxRows: 30 } }).runOnce()
            )
            assert.equal(first.streamLog.rowsDeleted, 30)
            // A batch that spent its last row of budget cannot prove there was
            // nothing behind it, and reporting a capped run as drained is the
            // one error that would strand a backlog. Over-reporting costs one
            // more candidate scan tomorrow; the run below is that scan.
            assert.equal(first.streamLog.capped, true)

            const second = await withCompaction('7', () =>
                h.build({ tuning: { maxRows: 30 } }).runOnce()
            )
            assert.equal(second.streamLog.rowsDeleted, 0)
            assert.equal(second.streamLog.capped, false)
            for (const id of ids)
                assert.equal((await evidenceOf(h, id)).rows, 10)
        })
)

test(
    'a backlog far larger than one run drains completely, with every row counted once',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const sizes = [1, 2, 3, 5, 8, 13, 21]
            const ids = sizes.map((_, i) => `cms_backlog_${i}`)
            for (const [i, size] of sizes.entries())
                await seedTurn(h, ids[i], size)
            const total = sizes.reduce((sum, size) => sum + size, 0)

            let runs = 0
            let deleted = 0
            // Bounded so a sweep that stopped converging fails here rather
            // than hanging: 53 rows at 7 a run needs 9, never 40.
            while (runs < 40) {
                const result = await withCompaction('7', () =>
                    h.build({ tuning: { maxRows: 7, batchSize: 2 } }).runOnce()
                )
                runs += 1
                deleted += result.streamLog.rowsDeleted
                if (result.streamLog.rowsDeleted === 0) break
            }

            assert.ok(
                runs > 8,
                `the backlog must outlast one run, took ${runs} runs`
            )
            assert.equal(deleted, total, 'every deletable row, no more')
            for (const [i, size] of sizes.entries()) {
                assert.deepEqual(
                    await survivingTypes(h, ids[i]),
                    ['done'],
                    `${ids[i]} kept its terminal and nothing else`
                )
                assert.equal(
                    (await evidenceOf(h, ids[i])).rows,
                    size,
                    `${ids[i]} recorded exactly what it lost`
                )
            }
            assert.equal(
                await totalStreamRows(h),
                sizes.length,
                'one terminal row per turn is all that is left'
            )
        })
)

test(
    'overlapping delete statements never overshoot or double-count evidence',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = 'cms_overlap'
            await seedTurn(h, id, 40)

            await h.db.execute(sql`
                create function mf672_overlap_barrier() returns trigger
                language plpgsql as $$
                begin
                    perform pg_advisory_xact_lock(672, 824);
                    return old;
                end;
                $$
            `)
            await h.db.execute(sql`
                create trigger mf672_overlap_barrier
                before delete on chat_stream_events
                for each row execute function mf672_overlap_barrier()
            `)

            let waiting = 0
            let pending: Array<Promise<unknown>> = []
            await h.db.transaction(async (tx) => {
                await tx.execute(sql`select pg_advisory_xact_lock(672, 824)`)
                pending = [1, 2].map(async () => {
                    const rows = await h.db.execute(
                        streamLogCompactStatement([id], 25, true)
                    )
                    return rows
                })
                for (let attempt = 0; attempt < 300; attempt += 1) {
                    await tx.execute(sql`select pg_stat_clear_snapshot()`)
                    const rows = (await tx.execute(sql`
                        select count(*)::int as value
                        from pg_stat_activity
                        where datname = current_database()
                          and pid <> pg_backend_pid()
                          and wait_event_type = 'Lock'
                    `)) as Array<{ value: number | string }>
                    waiting = Number(rows[0]?.value ?? 0)
                    if (waiting >= 2) break
                    await new Promise((resolve) => setTimeout(resolve, 10))
                }
            })

            const batches = (await Promise.all(pending)).map((rows) =>
                readStreamLogCompactBatch(rows as unknown[])
            )
            await h.db.execute(
                sql`drop trigger mf672_overlap_barrier on chat_stream_events`
            )
            await h.db.execute(sql`drop function mf672_overlap_barrier()`)

            assert.equal(
                waiting,
                2,
                'both statements entered the mutating path before either could finish'
            )
            assert.deepEqual(
                batches.map((batch) => batch.rowsDeleted).sort((a, b) => a - b),
                [0, 25],
                'the loser must count no row the winner already deleted'
            )
            for (const batch of batches) {
                assert.ok(
                    batch.rowsDeleted <= 25,
                    `one statement deleted ${batch.rowsDeleted} rows past its budget`
                )
                assert.equal(
                    batch.messagesStamped,
                    batch.messagesCompacted,
                    'every overlapping delete records its own evidence'
                )
            }

            const concurrentDeleted = batches.reduce(
                (sum, batch) => sum + batch.rowsDeleted,
                0
            )
            const left = await survivingTokens(h, id)
            assert.equal(concurrentDeleted + left, 40)
            assert.equal((await evidenceOf(h, id)).rows, concurrentDeleted)

            const drain = await withCompaction('7', () =>
                h.build({ tuning: { maxRows: 25 } }).runOnce()
            )
            assert.equal(concurrentDeleted + drain.streamLog.rowsDeleted, 40)
            assert.deepEqual(await survivingTypes(h, id), ['done'])
            assert.equal((await evidenceOf(h, id)).rows, 40)
        })
)

test(
    'compaction and retention delete lock parent before events without deadlock',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = 'cms_retention_overlap'
            await seedTurn(h, id, 40)

            await h.db.execute(sql`
                create function mf672_retention_barrier() returns trigger
                language plpgsql as $$
                begin
                    perform pg_advisory_xact_lock(672, 825);
                    return old;
                end;
                $$
            `)
            await h.db.execute(sql`
                create trigger mf672_retention_barrier
                before delete on chat_stream_events
                for each row execute function mf672_retention_barrier()
            `)

            let compaction!: Promise<unknown>
            let retention!: Promise<unknown>
            let waiting = 0
            await h.db.transaction(async (tx) => {
                await tx.execute(sql`select pg_advisory_xact_lock(672, 825)`)
                compaction = (async () =>
                    await h.db.execute(
                        streamLogCompactStatement([id], 25, true)
                    ))()
                for (let attempt = 0; attempt < 300; attempt += 1) {
                    await tx.execute(sql`select pg_stat_clear_snapshot()`)
                    const rows = (await tx.execute(sql`
                        select count(*)::int as value
                        from pg_stat_activity
                        where datname = current_database()
                          and pid <> pg_backend_pid()
                          and wait_event_type = 'Lock'
                    `)) as Array<{ value: number | string }>
                    waiting = Number(rows[0]?.value ?? 0)
                    if (waiting >= 1) break
                    await new Promise((resolve) => setTimeout(resolve, 10))
                }
                assert.equal(
                    waiting,
                    1,
                    'compaction must reach the event delete while holding its parent lock'
                )

                retention = (async () =>
                    await h.db.execute(sql`
                        delete from chat_messages
                        where id = ${id}
                        returning id
                    `))()
                for (let attempt = 0; attempt < 300; attempt += 1) {
                    await tx.execute(sql`select pg_stat_clear_snapshot()`)
                    const rows = (await tx.execute(sql`
                        select count(*)::int as value
                        from pg_stat_activity
                        where datname = current_database()
                          and pid <> pg_backend_pid()
                          and wait_event_type = 'Lock'
                    `)) as Array<{ value: number | string }>
                    waiting = Number(rows[0]?.value ?? 0)
                    if (waiting >= 2) break
                    await new Promise((resolve) => setTimeout(resolve, 10))
                }
            })

            assert.equal(
                waiting,
                2,
                'retention must wait on the parent rather than lock it ahead of compaction'
            )
            const [compactionRows, retentionRows] = await Promise.all([
                compaction,
                retention
            ])
            assert.deepEqual(
                readStreamLogCompactBatch(compactionRows as unknown[]),
                {
                    rowsDeleted: 25,
                    messagesCompacted: 1,
                    messagesStamped: 1
                }
            )
            assert.equal((retentionRows as unknown[]).length, 1)
            assert.equal(await totalStreamRows(h), 0)
        })
)

test(
    'compaction and regenerate rewrite lock parents before stream events',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const targetId = 'cms_regenerate_target'
            const deletedId = 'cms_regenerate_deleted'
            await h.db.insert(chatMessages).values({
                id: targetId,
                sessionId: h.sessionId,
                role: 'user',
                contentBlocksJson: [{ type: 'text', text: 'original prompt' }],
                createdAt: new Date(OLD.getTime() - DAY_MS)
            })
            await seedTurn(h, deletedId, 1)

            const regenerateDb = createDb(h.url, {
                max: 1,
                applicationName: 'mf672_regenerate'
            })
            const compactionDb = createDb(h.url, {
                max: 1,
                applicationName: 'mf672_compaction'
            })
            const repo = new ChatRepository(regenerateDb)
            let regenerate: Promise<unknown> | undefined
            let compaction: Promise<unknown> | undefined

            const waitForLock = async (
                tx: Database,
                applicationName: string
            ): Promise<string> => {
                let lastActivity: unknown = null
                for (let attempt = 0; attempt < 300; attempt += 1) {
                    await tx.execute(sql`select pg_stat_clear_snapshot()`)
                    const rows = (await tx.execute(sql`
                        select state, wait_event_type, wait_event
                        from pg_stat_activity
                        where datname = current_database()
                          and application_name = ${applicationName}
                        limit 1
                    `)) as Array<{
                        state: string
                        wait_event_type: string | null
                        wait_event: string | null
                    }>
                    lastActivity = rows[0] ?? null
                    if (
                        rows[0]?.wait_event_type === 'Lock' &&
                        rows[0].wait_event
                    )
                        return rows[0].wait_event
                    await new Promise((resolve) => setTimeout(resolve, 10))
                }
                throw new Error(
                    `${applicationName} did not reach a lock wait: ${JSON.stringify(lastActivity)}`
                )
            }

            try {
                assert.equal(
                    await repo.claimInflightTurn(
                        h.sessionId,
                        'cms_regenerate_inflight'
                    ),
                    true
                )
                await h.db.execute(sql`
                    create function mf672_regenerate_barrier() returns trigger
                    language plpgsql as $$
                    begin
                        if current_setting('application_name') = 'mf672_regenerate'
                           and old.event_type = 'token' then
                            perform pg_advisory_xact_lock(672, 826);
                        end if;
                        return old;
                    end;
                    $$
                `)
                await h.db.execute(sql`
                    create trigger mf672_regenerate_barrier
                    after delete on chat_stream_events
                    for each row execute function mf672_regenerate_barrier()
                `)

                let regenerateWait = ''
                let compactionWait = ''
                await h.db.transaction(async (tx) => {
                    await tx.execute(
                        sql`select pg_advisory_xact_lock(672, 826)`
                    )
                    regenerate = repo.rewriteMessageAndDeleteAfter(
                        h.sessionId,
                        targetId,
                        [{ type: 'text', text: 'edited prompt' }]
                    )
                    regenerateWait = await waitForLock(
                        tx as unknown as Database,
                        'mf672_regenerate'
                    )
                    assert.equal(
                        regenerateWait,
                        'advisory',
                        'regenerate must hold the event row at the controlled barrier'
                    )

                    compaction = (async () =>
                        await compactionDb.execute(
                            streamLogCompactStatement([deletedId], 1, true)
                        ))()
                    compactionWait = await waitForLock(
                        tx as unknown as Database,
                        'mf672_compaction'
                    )
                    assert.ok(
                        compactionWait,
                        'compaction must reach a conflicting row lock before the barrier opens'
                    )
                })

                const outcomes = await Promise.allSettled([
                    regenerate,
                    compaction
                ])
                const deadlock = outcomes.find(
                    (outcome) =>
                        outcome.status === 'rejected' &&
                        typeof outcome.reason === 'object' &&
                        outcome.reason !== null &&
                        'code' in outcome.reason &&
                        outcome.reason.code === '40P01'
                )
                assert.equal(
                    deadlock && deadlock.status === 'rejected'
                        ? deadlock.reason.code
                        : null,
                    null,
                    'compatible parent-first paths must not deadlock'
                )

                const [rewriteOutcome, compactionOutcome] = outcomes
                if (rewriteOutcome.status === 'rejected')
                    throw rewriteOutcome.reason
                if (compactionOutcome.status === 'rejected')
                    throw compactionOutcome.reason
                assert.deepEqual(
                    (
                        rewriteOutcome.value as Awaited<
                            ReturnType<
                                ChatRepository['rewriteMessageAndDeleteAfter']
                            >
                        >
                    )?.deletedMessageIds,
                    [deletedId]
                )
                assert.deepEqual(
                    readStreamLogCompactBatch(
                        compactionOutcome.value as unknown[]
                    ),
                    {
                        rowsDeleted: 0,
                        messagesCompacted: 0,
                        messagesStamped: 0
                    }
                )
            } finally {
                await Promise.allSettled(
                    [regenerate, compaction].filter(
                        (pending): pending is Promise<unknown> =>
                            pending !== undefined
                    )
                )
                await h.db.execute(
                    sql`drop trigger if exists mf672_regenerate_barrier on chat_stream_events`
                )
                await h.db.execute(
                    sql`drop function if exists mf672_regenerate_barrier()`
                )
                await closeDb(regenerateDb)
                await closeDb(compactionDb)
            }
        })
)

// The evidence is only worth reading if it cannot outlive a delete that did
// not happen. A row-level trigger fails the delete part-way through the batch,
// where a non-atomic design would already have removed the first turn's rows
// and stamped them.
test(
    'a delete that fails leaves neither rows deleted nor evidence written',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await seedTurn(h, 'cms_fail_a', 10)
            await seedTurn(h, 'cms_fail_b', 10)
            await h.db.execute(sql`
                create function mf672_block_delete() returns trigger
                language plpgsql as $$
                begin
                    raise exception 'mf672: delete blocked';
                end;
                $$
            `)
            await h.db.execute(sql`
                create trigger mf672_block_delete
                before delete on chat_stream_events
                for each row when (old.message_id = 'cms_fail_b')
                execute function mf672_block_delete()
            `)

            await assert.rejects(
                withCompaction('7', () => h.service.runOnce()),
                /mf672: delete blocked/,
                'the sweep surfaces the failure rather than swallowing it'
            )
            for (const id of ['cms_fail_a', 'cms_fail_b']) {
                assert.equal(
                    await survivingTokens(h, id),
                    10,
                    `${id} must keep every row when the statement aborts`
                )
                assert.deepEqual(
                    await evidenceOf(h, id),
                    { rows: 0, at: null },
                    `${id} must not claim a deletion that rolled back`
                )
            }

            // Control: the same fixture and the same sweep, trigger removed.
            await h.db.execute(
                sql`drop trigger mf672_block_delete on chat_stream_events`
            )
            const after = await withCompaction('7', () => h.service.runOnce())
            assert.equal(after.streamLog.rowsDeleted, 20)
            for (const id of ['cms_fail_a', 'cms_fail_b'])
                assert.equal((await evidenceOf(h, id)).rows, 10)
        })
)

test(
    'cumulative evidence does not overflow the PostgreSQL integer boundary',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await seedTurn(h, 'cms_large_evidence', 10)
            await h.db
                .update(chatMessages)
                .set({ compactedStreamRows: 2_147_483_640 })
                .where(eq(chatMessages.id, 'cms_large_evidence'))

            const result = await withCompaction('7', () =>
                h.build({ tuning: { maxRows: 10 } }).runOnce()
            )

            assert.equal(result.streamLog.rowsDeleted, 10)
            assert.equal(
                (await evidenceOf(h, 'cms_large_evidence')).rows,
                2_147_483_650,
                'the durable counter must remain exact after INT_MAX'
            )
            assert.deepEqual(await survivingTypes(h, 'cms_large_evidence'), [
                'done'
            ])
        })
)

// The cap is only a cap if the LIMIT is reached without first materializing
// everything it would have discarded: a Sort over a turn's rows reads them all
// before the LIMIT can throw any away, which is the work #672 asked to stop
// doing on the largest table in the schema. 20 turns × 2,500 rows, because
// plan shape is a cost decision and a 100-row table answers a question nobody
// asked — at that size a seq scan really is the cheapest way to find 10 rows.
test(
    'the truncating statement stops at its LIMIT instead of sorting a turn',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const ids: string[] = []
            for (let i = 0; i < 20; i += 1) {
                const id = `cms_plan_${String(i).padStart(3, '0')}`
                ids.push(id)
                await seedTurn(h, id, 2_500)
            }
            await h.db.execute(sql`analyze chat_stream_events`)
            await h.db.execute(sql`analyze chat_messages`)

            const explain = async (
                budget: number,
                apply: boolean
            ): Promise<string> => {
                const rows = (await h.db.execute(
                    sql`explain ${streamLogCompactStatement(ids, budget, apply)}`
                )) as Array<Record<string, string>>
                return rows.map((row) => Object.values(row)[0]).join('\n')
            }

            // A budget of 10 against turns of 2,500: the cap truncates the
            // first turn, so all but 10 of the batch's 50,000 rows must go
            // unread.
            const capped = await explain(10, true)
            assert.match(capped, /Nested Loop/)
            assert.match(capped, /Function Scan on unnest/)
            assert.match(
                capped,
                /Index Scan using chat_stream_events_message_id_id_idx/,
                `one ordered index range per turn:\n${capped}`
            )
            assert.doesNotMatch(
                capped,
                /Sort/,
                `a truncated read must not sort what it discards:\n${capped}`
            )
            assert.match(
                capped,
                /Index Scan using chat_stream_events_pkey/,
                `the delete resolves its victims by id:\n${capped}`
            )
            assert.doesNotMatch(
                capped,
                /Seq Scan on chat_stream_events/,
                `nothing here reads the table end to end:\n${capped}`
            )
            assert.match(capped, /Delete on chat_stream_events/)
            assert.match(capped, /Update on chat_messages/)

            // A budget wider than the whole batch reads every candidate row —
            // and then deletes every one of them, so the per-turn sort the
            // planner adds costs nothing that is not used. What must still
            // hold is that the batch is reached one turn at a time, by index,
            // and that the preview's message count is not a second sort over
            // the whole victim set.
            const generous = await explain(1_000_000, false)
            assert.match(generous, /Nested Loop/)
            assert.match(generous, /Function Scan on unnest/)
            assert.match(
                generous,
                /Index (?:Scan|Cond).*message_id|message_id = batch\.message_id/,
                `candidates are still reached per turn by index:\n${generous}`
            )
            assert.doesNotMatch(
                generous,
                /Seq Scan on chat_stream_events/,
                `a wide budget is not a licence to scan the table:\n${generous}`
            )
            assert.match(
                generous,
                /HashAggregate/,
                `the preview counts messages by grouping, not by sorting every victim row:\n${generous}`
            )
        })
)
