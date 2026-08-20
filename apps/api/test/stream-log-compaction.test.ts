import assert from 'node:assert/strict'
import test from 'node:test'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { ChatRetentionService } from '../src/modules/chat-retention/chat-retention.service'
import {
    resolveCompactAfterDays,
    STREAM_LOG_COMPACT_BATCH_SIZE,
    STREAM_LOG_COMPACT_FLOOR_DAYS,
    STREAM_LOG_COMPACT_MAX_MESSAGES_PER_RUN,
    STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN
} from '../src/modules/chat-retention/stream-log-compaction'
import { ASSISTANT_BLOCKS_TRUNCATION_MARKER } from '../src/modules/chat/assistant-blocks'

// #672. The house fake db discards predicates, so a compaction sweep would look
// identical in CI whether it deleted the right rows or every row. This file
// therefore runs the real Drizzle serializer over every statement the sweep
// issues and asserts on the SQL text and bound params — statement shape, not
// statement count alone. The semantics that only Postgres can settle (which
// messages the predicate actually admits) are pinned in the .pg suite.
//
// The fake also models the row budget the way the statement enforces it: rows
// are taken message by message until the LIMIT is reached, so a batch or a
// single message larger than the budget is truncated here exactly as Postgres
// truncates it.

const dialect = new PgDialect()
const serialize = (node: unknown): { sql: string; params: unknown[] } => {
    const query = dialect.sqlToQuery(node as SQL)
    return { sql: query.sql, params: query.params }
}

interface Statement {
    op:
        | 'metric'
        | 'plan_floor'
        | 'candidate'
        | 'raw_clear'
        | 'compact'
        | 'other'
    sql: string
    afterId?: string
    limit?: number
    params?: unknown[]
    ids?: string[]
    rowBudget?: number
}

const SIZE_ROW = { estimated_rows: 578_000, total_bytes: 171_270_144 }

class FakeStreamLogDb {
    readonly statements: Statement[] = []
    // Message ids the candidate predicate would return, ascending. The fake
    // honours the keyset and limit so the batching under test is real.
    compactable: string[] = []
    rowsPerMessage = 30
    // Compactable rows a message still holds, and the evidence the stamping
    // CTE has accumulated on it. Both survive across runs, which is what makes
    // partial compaction of one oversized turn observable.
    readonly remaining = new Map<string, number>()
    readonly evidence = new Map<string, number>()
    compactLosesRace = false

    of(op: Statement['op']): Statement[] {
        return this.statements.filter((s) => s.op === op)
    }

    rowsLeft(id: string): number {
        return this.remaining.get(id) ?? this.rowsPerMessage
    }

    // The retention sweep runs in the same tick; it finds no plan candidates.
    select(): unknown {
        const chain = Object.assign(
            Promise.resolve([]),
            {}
        ) as unknown as Record<string, unknown>
        for (const method of ['from', 'innerJoin', 'where', 'limit'])
            chain[method] = () => chain
        return chain
    }

    async execute(query: unknown): Promise<unknown[]> {
        const { sql, params } = serialize(query)
        // Discriminated on the driving table, not on a mention: the
        // raw-clear statement joins "chat_messages" for the marker, and the
        // compaction statement writes it.
        if (sql.includes('from "plans"')) {
            this.statements.push({ op: 'plan_floor', sql, params })
            return [{ days: 0 }]
        }
        if (sql.includes('from "chat_message_sources" s')) {
            this.statements.push({ op: 'raw_clear', sql, params })
            return [
                { scanned: 0, cleared: 0, cursor_at: null, cursor_id: null }
            ]
        }
        if (sql.includes('from unnest(array[')) return this.compact(sql, params)
        if (sql.includes('from "chat_messages" m')) {
            const afterId = params[1] as string
            const limit = params[params.length - 1] as number
            this.statements.push({
                op: 'candidate',
                sql,
                afterId,
                limit,
                params
            })
            return this.compactable
                .filter((id) => id > afterId)
                .slice(0, limit)
                .map((id) => ({ id }))
        }
        this.statements.push({ op: 'metric', sql, params })
        return [SIZE_ROW]
    }

    // The compaction statement, modelled on its own terms: rows are consumed
    // in batch order, per message in row order, until the budget runs out. A
    // preview computes the identical figures and writes nothing.
    private compact(sql: string, params: unknown[]): unknown[] {
        const ids = params.filter(
            (v): v is string =>
                typeof v === 'string' && v !== 'token' && v !== 'thinking'
        )
        const numbers = params.filter((v): v is number => typeof v === 'number')
        const rowBudget = numbers[numbers.length - 1] ?? 0
        const apply = sql.includes('delete from "chat_stream_events"')
        this.statements.push({ op: 'compact', sql, params, ids, rowBudget })

        if (this.compactLosesRace)
            return [
                {
                    rows_deleted: 0,
                    messages_compacted: 0,
                    messages_stamped: 0
                }
            ]

        let budget = rowBudget
        let rowsDeleted = 0
        let messagesCompacted = 0
        for (const id of ids) {
            if (budget <= 0) break
            const available = this.rowsLeft(id)
            if (available <= 0) continue
            const take = Math.min(available, budget)
            budget -= take
            rowsDeleted += take
            messagesCompacted += 1
            if (!apply) continue
            this.remaining.set(id, available - take)
            this.evidence.set(id, (this.evidence.get(id) ?? 0) + take)
        }
        if (apply)
            this.compactable = this.compactable.filter(
                (id) => this.rowsLeft(id) > 0
            )
        return [
            {
                rows_deleted: rowsDeleted,
                messages_compacted: messagesCompacted,
                messages_stamped: apply ? messagesCompacted : 0
            }
        ]
    }

    // Nothing should reach this any more: the capped statement is the only
    // thing allowed to delete stream rows. Recorded as `other` so the shape
    // tests fail loudly rather than silently passing on an unbounded delete.
    delete(): unknown {
        return {
            where: (condition: unknown) => {
                const { sql, params } = serialize(condition)
                this.statements.push({ op: 'other', sql, params })
                return Promise.resolve(Object.assign([], { count: 0 }))
            }
        }
    }
}

const makeService = (
    db: FakeStreamLogDb,
    opts: {
        leaseGranted?: boolean
        events?: Array<[string, unknown]>
        dryRun?: boolean
        warnings?: string[]
    } = {}
): ChatRetentionService => {
    const service = new ChatRetentionService(
        db as never,
        {
            get: (key: string) =>
                opts.dryRun && key === 'CHAT_RETENTION_DRY_RUN'
                    ? '1'
                    : undefined
        } as never,
        opts.leaseGranted === undefined
            ? undefined
            : ({
                  tryAcquireOrRenew: async () => opts.leaseGranted,
                  release: async () => {}
              } as never),
        {
            event: (name: string, attrs: unknown) =>
                opts.events?.push([name, attrs])
        } as never
    )
    if (opts.warnings) {
        const withLogger = service as unknown as {
            log: {
                log: () => void
                warn: (message: string) => void
                error: () => void
            }
        }
        withLogger.log = {
            log: () => {},
            warn: (message) => opts.warnings?.push(message),
            error: () => {}
        }
    }
    return service
}

// The cap paths are 100+ batches apart at the shipped constants; reaching them
// with real inter-batch pauses would cost 20s of wall clock per assertion.
const tunedService = (
    db: FakeStreamLogDb,
    tuning: Partial<{
        batchSize: number
        pauseMs: number
        maxRows: number
        maxMessages: number
    }>
): ChatRetentionService => {
    const service = makeService(db)
    Object.assign(
        (service as unknown as { compaction: Record<string, number> })
            .compaction,
        tuning
    )
    return service
}

const withEnv = async (
    value: string | undefined,
    fn: () => Promise<void>
): Promise<void> => {
    const previous = process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS
    if (value === undefined) delete process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS
    else process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS = value
    try {
        await fn()
    } finally {
        if (previous === undefined)
            delete process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS
        else process.env.MF_STREAM_LOG_COMPACT_AFTER_DAYS = previous
    }
}

const ids = (count: number, from = 0): string[] =>
    Array.from(
        { length: count },
        (_, i) => `cms_${String(from + i).padStart(7, '0')}`
    )

test('an unset compaction window issues zero compaction statements', async () => {
    const db = new FakeStreamLogDb()
    db.compactable = ids(1000)

    await withEnv(undefined, async () => {
        const result = await makeService(db).runOnce()
        assert.deepEqual(result.streamLog, {
            messagesCompacted: 0,
            rowsDeleted: 0,
            capped: false,
            dryRun: false
        })
    })

    assert.deepEqual(db.of('candidate'), [], 'no candidate scan when disabled')
    assert.deepEqual(db.of('compact'), [], 'no compaction when disabled')
    assert.equal(db.compactable.length, 1000)
})

test('garbage and zero windows are inert, not "compact everything"', async () => {
    for (const value of ['0', '', '   ', 'yes', 'NaN', '-30', '0.5']) {
        const db = new FakeStreamLogDb()
        db.compactable = ids(500)

        await withEnv(value, async () => {
            await makeService(db).runOnce()
        })

        // The sibling sweeps runOnce drives in the same tick; inert here
        // means compaction itself issued nothing.
        const siblings = new Set(['metric', 'plan_floor', 'raw_clear'])
        assert.deepEqual(
            db.statements.filter((s) => !siblings.has(s.op)),
            [],
            `MF_STREAM_LOG_COMPACT_AFTER_DAYS=${JSON.stringify(value)} must be inert`
        )
    }
})

test('a sub-floor window clamps up instead of compacting live turns', () => {
    for (const day of [1, 2, 3, 4, 5, 6])
        assert.equal(
            resolveCompactAfterDays(String(day)),
            STREAM_LOG_COMPACT_FLOOR_DAYS,
            'a fat-fingered 1 must not compact yesterday'
        )
    assert.equal(resolveCompactAfterDays('7'), 7)
    assert.equal(resolveCompactAfterDays('30'), 30)
    assert.equal(resolveCompactAfterDays('30.9'), 30)
    assert.equal(resolveCompactAfterDays(undefined), 0)
})

test('the growth metric is emitted on every tick, compaction on or off', async () => {
    for (const value of [undefined, '30']) {
        const events: Array<[string, unknown]> = []
        const db = new FakeStreamLogDb()

        await withEnv(value, async () => {
            await makeService(db, { events }).runOnce()
        })

        assert.equal(db.of('metric').length, 1, 'exactly one catalog probe')
        const size = events.find(([name]) => name === 'chat.stream_log.size')
        assert.deepEqual(size?.[1], {
            estimatedRows: SIZE_ROW.estimated_rows,
            totalBytes: SIZE_ROW.total_bytes
        })
    }
})

test('an enabled sweep drains in bounded batches on a forward cursor', async () => {
    const db = new FakeStreamLogDb()
    db.compactable = ids(450)
    const events: Array<[string, unknown]> = []

    await withEnv('30', async () => {
        const result = await makeService(db, { events }).runOnce()

        assert.equal(result.streamLog.messagesCompacted, 450)
        assert.equal(result.streamLog.rowsDeleted, 450 * db.rowsPerMessage)
        assert.equal(result.streamLog.capped, false)
    })

    const candidates = db.of('candidate')
    assert.equal(
        candidates.length,
        3,
        `450 messages must cost ceil(450/${STREAM_LOG_COMPACT_BATCH_SIZE}) candidate scans`
    )
    for (const scan of candidates)
        assert.equal(scan.limit, STREAM_LOG_COMPACT_BATCH_SIZE)
    assert.deepEqual(
        candidates.map((s) => s.afterId),
        ['', 'cms_0000199', 'cms_0000399'],
        'the keyset must advance so a drain never re-walks compacted messages'
    )
    assert.deepEqual(
        db.of('compact').map((s) => s.ids?.length),
        [200, 200, 50]
    )
    const compacted = events.find(
        ([name]) => name === 'chat.stream_log.compacted'
    )
    assert.deepEqual(compacted?.[1], {
        afterDays: 30,
        messagesCompacted: 450,
        rowsDeleted: 450 * db.rowsPerMessage,
        capped: false,
        dryRun: false
    })
})

test('the row budget is a hard cap on rows deleted, not a pre-batch check', async () => {
    const db = new FakeStreamLogDb()
    // One fat turn per batch is enough to blow the row budget, which is the
    // realistic shape: a single runaway turn can carry six figures of tokens.
    // 200 of them in one batch is a million rows against a 200k budget, which
    // is what #672 reported the sweep deleting in a single statement.
    db.rowsPerMessage = 5_000
    db.compactable = ids(1000)

    await withEnv('30', async () => {
        const result = await makeService(db).runOnce()

        assert.equal(
            result.streamLog.rowsDeleted,
            STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN,
            'the run must stop AT the budget, not at the end of the batch'
        )
        assert.equal(
            result.streamLog.messagesCompacted,
            STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN / 5_000,
            'only the turns the budget actually paid for may be reported'
        )
        assert.equal(result.streamLog.capped, true)
    })

    assert.equal(db.of('candidate').length, 1, 'the cap stops the next scan')
    assert.equal(db.of('compact').length, 1)
    assert.equal(
        db.of('compact')[0].rowBudget,
        STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN,
        'the whole budget is handed to the first statement and bounds it'
    )
    assert.deepEqual(
        db.of('other'),
        [],
        'no delete may be issued outside the capped statement'
    )
    assert.equal(
        db.compactable.length,
        960,
        'the 160 untouched turns of the batch stay in the backlog'
    )
})

test('one oversized turn is compacted across runs, never in one bite', async () => {
    const db = new FakeStreamLogDb()
    const [fat] = ids(1)
    db.compactable = [fat]
    db.remaining.set(fat, 10_000)
    const service = tunedService(db, { maxRows: 1_000, pauseMs: 0 })

    await withEnv('30', async () => {
        const first = await service.runOnce()

        assert.equal(
            first.streamLog.rowsDeleted,
            1_000,
            'a turn ten times the budget may still only cost the budget'
        )
        assert.equal(first.streamLog.messagesCompacted, 1)
        assert.equal(first.streamLog.capped, true)
        assert.deepEqual(db.compactable, [fat], 'the residue stays a candidate')
        assert.equal(db.rowsLeft(fat), 9_000)
        assert.equal(db.evidence.get(fat), 1_000)

        // The keyset restarts at '' every run and the candidate predicate
        // still matches a turn holding rows, so the residue converges with no
        // cursor to skip it.
        for (let run = 2; run <= 10; run += 1) await service.runOnce()

        assert.equal(db.rowsLeft(fat), 0)
        assert.equal(db.evidence.get(fat), 10_000, 'no row counted twice')
        assert.deepEqual(db.compactable, [])

        const eleventh = await service.runOnce()
        assert.equal(eleventh.streamLog.rowsDeleted, 0)
        assert.equal(eleventh.streamLog.messagesCompacted, 0)
        assert.equal(eleventh.streamLog.capped, false)
    })
})

test('a batch that exactly spends the budget reports capped, not drained', async () => {
    const db = new FakeStreamLogDb()
    db.rowsPerMessage = 200
    db.compactable = ids(3)
    const service = tunedService(db, { maxRows: 600, pauseMs: 0 })

    await withEnv('30', async () => {
        const first = await service.runOnce()

        // The statement cannot report whether the LIMIT truncated anything,
        // so a spent budget is reported as capped even though this batch was
        // short. Over-reporting a cap only costs one extra scan tomorrow;
        // under-reporting it would strand a backlog.
        assert.equal(first.streamLog.rowsDeleted, 600)
        assert.equal(first.streamLog.messagesCompacted, 3)
        assert.equal(first.streamLog.capped, true)

        const second = await service.runOnce()
        assert.equal(second.streamLog.rowsDeleted, 0)
        assert.equal(
            second.streamLog.capped,
            false,
            'the conservative cap must clear itself on the next run'
        )
    })
})

test('the message cap bounds a fleet of one-line answers', async () => {
    const db = new FakeStreamLogDb()
    // Rows-per-message near 1 means the row budget is unreachable; without the
    // second cap the sweep would walk the whole table in one tick.
    db.rowsPerMessage = 1
    db.compactable = ids(700)
    const service = tunedService(db, { maxMessages: 500, pauseMs: 0 })

    await withEnv('30', async () => {
        const result = await service.runOnce()

        assert.equal(result.streamLog.messagesCompacted, 500)
        assert.equal(result.streamLog.rowsDeleted, 500)
        assert.equal(result.streamLog.capped, true)
    })

    assert.deepEqual(
        db.of('candidate').map((s) => s.limit),
        [200, 200, 100],
        'the last batch is clamped to the remaining message budget'
    )
    assert.equal(db.compactable.length, 200)
    assert.ok(
        STREAM_LOG_COMPACT_MAX_MESSAGES_PER_RUN > 0,
        'the shipped cap is a real bound, not disabled'
    )
})

test('the message cap also bounds stale candidates after an overlapping run wins', async () => {
    const db = new FakeStreamLogDb()
    db.rowsPerMessage = 1
    db.compactable = ids(10)
    db.compactLosesRace = true
    const service = tunedService(db, {
        batchSize: 2,
        maxMessages: 3,
        pauseMs: 0
    })

    await withEnv('30', async () => {
        const result = await service.runOnce()

        assert.equal(result.streamLog.messagesCompacted, 0)
        assert.equal(result.streamLog.rowsDeleted, 0)
        assert.equal(
            result.streamLog.capped,
            true,
            'stale candidates still spend the scan budget'
        )
    })

    assert.deepEqual(
        db.of('candidate').map((statement) => statement.limit),
        [2, 1],
        'an overlapping winner must not turn maxMessages into an unbounded scan'
    )
})

test('a re-run over already-compacted messages costs one scan and no delete', async () => {
    const db = new FakeStreamLogDb()
    db.compactable = ids(10)

    await withEnv('30', async () => {
        const service = makeService(db)
        await service.runOnce()
        db.statements.length = 0

        const second = await service.runOnce()

        assert.equal(second.streamLog.messagesCompacted, 0)
        assert.equal(second.streamLog.rowsDeleted, 0)
        assert.equal(second.streamLog.capped, false)
    })

    assert.equal(db.of('candidate').length, 1, 'one empty probe, then stop')
    assert.deepEqual(db.of('compact'), [])
})

test('a denied lease compacts nothing', async () => {
    const db = new FakeStreamLogDb()
    db.compactable = ids(400)

    await withEnv('30', async () => {
        const result = await makeService(db, { leaseGranted: false }).runOnce()
        assert.equal(result.streamLog.messagesCompacted, 0)
    })

    assert.deepEqual(db.statements, [], 'not even the catalog probe')
    assert.equal(db.compactable.length, 400)
})

test('the candidate predicate carries the truncation marker and never reads a stream-log timestamp', async () => {
    const db = new FakeStreamLogDb()
    db.compactable = ids(1)

    await withEnv('30', async () => {
        await makeService(db).runOnce()
    })

    const scan = db.of('candidate')[0]
    assert.ok(
        scan.params?.includes(ASSISTANT_BLOCKS_TRUNCATION_MARKER),
        'a message whose only full history is the stream log must be excluded in SQL'
    )
    assert.ok(
        scan.params?.includes(ASSISTANT_BLOCKS_TRUNCATION_MARKER.length),
        'the marker is matched by prefix length, not by a LIKE pattern'
    )
    assert.match(scan.sql, /m\.role = 'assistant'/)
    assert.match(scan.sql, /newest\.event_type in \('done', 'error'\)/)
    assert.match(
        scan.sql,
        /newest\.created_at < \$\d+::timestamptz/,
        'a turn that terminated inside the window is still resumable'
    )
    assert.match(scan.sql, /order by e\.id desc\s+limit 1/)
    assert.match(scan.sql, /order by m\.id\s+limit \$\d+/)
    assert.doesNotMatch(
        scan.sql,
        /chat_stream_events"? *\w* *\n? *where[^)]*created_at/,
        'candidates must never be driven off the unindexed stream-log timestamp'
    )
})

test('the capped statement selects, deletes and records in one round trip', async () => {
    const db = new FakeStreamLogDb()
    db.compactable = ids(2)

    await withEnv('30', async () => {
        await makeService(db).runOnce()
    })

    assert.deepEqual(db.of('other'), [], 'no other table is written')
    const compact = db.of('compact')
    assert.equal(compact.length, 1)
    const { sql, params } = compact[0]

    assert.match(
        sql,
        /victim as \(\s*select[\s\S]*?limit \$\d+\s*\)/,
        'the cap is a LIMIT inside the selection the delete reads'
    )
    assert.match(
        sql,
        /cross join lateral/,
        'one index range per message, so the LIMIT can stop the scan early'
    )
    assert.match(
        sql,
        /for update/,
        'the parent message must be locked before its event rows, matching retention cascade order'
    )
    assert.ok(
        sql.indexOf('for update') < sql.indexOf('from "chat_stream_events" e'),
        'the parent lock must be consumed before the event range is read'
    )
    assert.match(
        sql,
        /delete from "chat_stream_events" d\s+where d\.id in \(select id from victim\)/
    )
    assert.match(
        sql,
        /returning d\.message_id as message_id/,
        'the counts must come from the rows the delete actually took'
    )
    assert.match(
        sql,
        /update "chat_messages" m\s+set compacted_stream_rows = m\.compacted_stream_rows \+ pm\.rows_deleted,\s+stream_compacted_at = now\(\)/,
        'evidence is accumulated, never overwritten'
    )
    assert.doesNotMatch(
        sql,
        /count\(\*\) from "chat_stream_events"/,
        'a table-wide count is the scan #672 exists to avoid'
    )
    assert.deepEqual(params, [
        'cms_0000000',
        'cms_0000001',
        'token',
        'thinking',
        STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN,
        STREAM_LOG_COMPACT_MAX_ROWS_PER_RUN
    ])
})

test('a dry run previews the capped set and writes no evidence', async () => {
    const db = new FakeStreamLogDb()
    db.rowsPerMessage = 400
    db.compactable = ids(4)
    const events: Array<[string, unknown]> = []
    const warnings: string[] = []
    const service = makeService(db, { dryRun: true, events, warnings })
    Object.assign(
        (service as unknown as { compaction: Record<string, number> })
            .compaction,
        { maxRows: 1_000, pauseMs: 0 }
    )

    await withEnv('30', async () => {
        const result = await service.runOnce()

        assert.equal(result.streamLog.dryRun, true)
        assert.equal(
            result.streamLog.rowsDeleted,
            1_000,
            'the preview is bounded by the same budget the run would spend'
        )
        assert.equal(result.streamLog.messagesCompacted, 3)
        assert.equal(result.streamLog.capped, true)
    })

    const { sql } = db.of('compact')[0]
    assert.match(sql, /cross join lateral/, 'the same selection is previewed')
    assert.doesNotMatch(sql, /for update/, 'a dry run must take no row locks')
    assert.doesNotMatch(sql, /delete from/, 'a dry run deletes nothing')
    assert.doesNotMatch(
        sql,
        /update "chat_messages"/,
        'a dry run must not stamp compaction evidence on a turn it did not compact'
    )
    assert.doesNotMatch(sql, /stream_compacted_at/)
    assert.equal(db.evidence.size, 0)
    assert.deepEqual(
        warnings,
        [],
        'stamping zero messages is intentional in dry-run, not an evidence mismatch'
    )
    assert.equal(db.rowsLeft(ids(1)[0]), 400, 'no rows were taken')
    assert.deepEqual(db.compactable, ids(4))
    assert.deepEqual(
        events.find(([n]) => n === 'chat.stream_log.compacted')?.[1],
        {
            afterDays: 30,
            messagesCompacted: 3,
            rowsDeleted: 1_000,
            capped: true,
            dryRun: true
        }
    )
})

test('the size probe reads the catalog, never the table', async () => {
    const db = new FakeStreamLogDb()

    await withEnv(undefined, async () => {
        await makeService(db).runOnce()
    })

    const probe = db.of('metric')[0]
    assert.deepEqual(probe.params, [], 'no bound params, no per-row work')
    assert.match(probe.sql, /reltuples/)
    assert.match(probe.sql, /pg_total_relation_size/)
    assert.doesNotMatch(
        probe.sql,
        /count\(/i,
        'a count(*) on chat_stream_events is the scan #672 exists to avoid'
    )
    assert.doesNotMatch(probe.sql, /from "chat_stream_events"/)
})
