import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'
import {
    acquireMigrationMutex,
    releaseMigrationMutex,
    runJournal
} from '../src/db/migration-runner'

// Real-Postgres proof of what the parameterised runner adds over plain
// drizzle migrate: every run serialises on one fixed advisory mutex (drizzle
// itself has none — a concurrent runner would race the journal repairs and
// the CONCURRENTLY index builds that live outside its batch transaction, and
// the M2 editions cutover joins the same mutex), and the journal table name
// is honoured, which is what lets the core and cloud journals share one
// database. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
const RUN = process.env.RUN_PG_E2E === '1'

const FIXTURE = path.join(process.cwd(), 'test/fixtures/migration-runner')
const TABLE = '__drizzle_migrations_runner_test'

const connect = (): ReturnType<typeof postgres> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    return postgres(url, { max: 1, onnotice: () => undefined })
}

const journalRows = async (
    client: ReturnType<typeof postgres>
): Promise<Array<{ hash: string; created_at: string }>> =>
    await client.unsafe(
        `select hash, created_at from drizzle."${TABLE}" order by created_at`
    )

test('runner mutex + parameterised journal table', { skip: !RUN }, async () => {
    const holder = connect()
    const runner = connect()
    try {
        await runner.unsafe(`drop table if exists drizzle."${TABLE}"`)

        // While another session holds the mutex, a run must fail loudly
        // within its bounded wait instead of proceeding in parallel.
        await acquireMigrationMutex(holder)
        await assert.rejects(
            runJournal(runner, {
                folder: FIXTURE,
                migrationsTable: TABLE,
                concurrentIndexes: [],
                lockTimeoutMs: 1200
            }),
            (error: unknown) =>
                /lock timeout|canceling statement/i.test(String(error))
        )
        const [blocked] = await runner`
            select to_regclass(${'drizzle.' + TABLE})::text as present
        `
        assert.equal(blocked?.present, null)

        await releaseMigrationMutex(holder)
        await runJournal(runner, {
            folder: FIXTURE,
            migrationsTable: TABLE,
            concurrentIndexes: []
        })
        const applied = await journalRows(runner)
        const [expected] = readMigrationFiles({ migrationsFolder: FIXTURE })
        assert.equal(applied.length, 1)
        assert.equal(applied[0].hash, expected.hash)
        assert.equal(Number(applied[0].created_at), expected.folderMillis)

        // High-watermark semantics survive the table rename: a re-run is a
        // no-op, and the default journal never learns about this table.
        await runJournal(runner, {
            folder: FIXTURE,
            migrationsTable: TABLE,
            concurrentIndexes: []
        })
        assert.equal((await journalRows(runner)).length, 1)
        const [defaultJournal] = await runner`
            select count(*)::int as hits from drizzle.__drizzle_migrations
            where hash = ${expected.hash}
        `
        assert.equal(defaultJournal.hits, 0)
    } finally {
        await runner.unsafe(`drop table if exists drizzle."${TABLE}"`)
        await holder.end()
        await runner.end()
    }
})
