// One connection-close scenario per process (argv[2]); prints RESULT <json>.
// Terminates only backends this process opened. An uncaught exception or an
// unhandled rejection is recorded instead of ending the process, so the
// parent can assert there was none.
import postgres from 'postgres'
import { sql as drizzleSql } from 'drizzle-orm'
import { createDb } from '@manyfold/db'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const escaped: string[] = []
process.on('uncaughtException', (err) => {
    escaped.push(`uncaughtException: ${err.message}`)
})
process.on('unhandledRejection', (reason) => {
    escaped.push(`unhandledRejection: ${(reason as Error)?.message}`)
})

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))
const PENDING = 'pending'
const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> =>
    Promise.race([promise, sleep(ms).then(() => PENDING as 'pending')])
const codeOf = (err: unknown) => ({
    code: (err as { code?: string }).code ?? null
})

// The production client: drizzle over createDb, a transaction whose backend
// dies while one of its queries runs. postgres.js then issues the automatic
// ROLLBACK on the closed connection.
const inflight = async () => {
    const db = createDb(url, { max: 2 })
    const admin = postgres(url, { max: 1 })
    try {
        let pid = 0
        let started!: () => void
        const running = new Promise<void>((resolve) => (started = resolve))
        const tx = db
            .transaction(async (t) => {
                const [row] = await t.execute<{ pid: number }>(
                    drizzleSql`select pg_backend_pid() as pid`
                )
                pid = row.pid
                started()
                await t.execute(drizzleSql`select pg_sleep(5)`)
            })
            .then(
                () => ({ outcome: 'resolved' }),
                (err) => ({ outcome: 'rejected', ...codeOf(err) })
            )
        await running
        await sleep(100)
        await admin`select pg_terminate_backend(${pid}::int)`
        const transaction = await within(tx, 4_000)
        await sleep(200)
        const [{ x }] = await db.execute<{ x: number }>(
            drizzleSql`select 1 as x`
        )
        return { transaction, after: x }
    } finally {
        await Promise.all([
            db.$client.end({ timeout: 0 }),
            admin.end({ timeout: 0 })
        ])
    }
}

// Queries queued inside the transaction behind the one that kills it.
const queued = async () => {
    const sql = postgres(url, { max: 1, max_pipeline: 1, fetch_types: false })
    try {
        let queries: Promise<unknown>[] = []
        const transaction = await sql
            .begin((tx) => {
                queries = [
                    tx`select pg_terminate_backend(pg_backend_pid())`.execute(),
                    tx`select 1`.execute(),
                    tx`select 2`.execute()
                ]
                return Promise.allSettled(queries)
            })
            .then(
                () => ({ outcome: 'resolved' }),
                (err) => ({ outcome: 'rejected', ...codeOf(err) })
            )
        const settled = await within(Promise.allSettled(queries), 3_000)
        const [{ x }] = await sql`select 1 as x`
        return {
            transaction,
            queries:
                settled === PENDING
                    ? PENDING
                    : settled.map((result) => result.status),
            after: x
        }
    } finally {
        await sql.end({ timeout: 0 })
    }
}

// A transaction callback that outlives its connection, then resumes while a
// replacement transaction holds the same pool connection.
const disconnected = async (
    inReplacement: (args: {
        replacement: postgres.TransactionSql
        stale: postgres.TransactionSql
        finish: (error?: Error) => void
    }) => Promise<unknown>
) => {
    const pool = postgres(url, { max: 1, fetch_types: false })
    const admin = postgres(url, { max: 1 })
    let finish!: (error?: Error) => void
    const gate = new Promise<void>(
        (resolve, reject) =>
            (finish = (error) => (error ? reject(error) : resolve()))
    )
    let ready!: (value: { stale: postgres.TransactionSql; pid: number }) => void
    const connected = new Promise<{
        stale: postgres.TransactionSql
        pid: number
    }>((resolve) => (ready = resolve))
    const failed = pool
        .begin(async (tx) => {
            const [{ pid }] = await tx`select pg_backend_pid() as pid`
            ready({ stale: tx, pid })
            await gate
        })
        .then(
            () => ({ outcome: 'resolved' }),
            (err) => ({ outcome: 'rejected', ...codeOf(err) })
        )
    try {
        const { stale, pid } = await connected
        await admin`select pg_terminate_backend(${pid}::int)`
        const original = await within(failed, 3_000)
        const replacement = await within(
            pool.begin((tx) => inReplacement({ replacement: tx, stale, finish })),
            5_000
        )
        return { original, replacement }
    } finally {
        finish()
        await sleep(50)
        await Promise.all([
            pool.end({ timeout: 0 }),
            admin.end({ timeout: 0 })
        ])
    }
}

const lateQuery = () =>
    disconnected(async ({ replacement, stale }) => {
        await replacement`select set_config('mf843.marker', 'replacement', true)`
        return stale`select current_setting('mf843.marker', true) as x`.then(
            (rows) => ({ ranOn: rows[0].x }),
            (err) => codeOf(err)
        )
    })

const lateFinish = (error?: Error) => () =>
    disconnected(async ({ replacement, finish }) => {
        const [{ x: before }] =
            await replacement`select txid_current()::text as x`
        finish(error)
        await sleep(50)
        const [{ x: after }] =
            await replacement`select txid_current()::text as x`
        return { sameTransaction: before === after }
    })

const scenarios: Record<string, () => Promise<unknown>> = {
    inflight,
    queued,
    'late-query': lateQuery,
    'late-commit': lateFinish(),
    'late-rollback': lateFinish(new Error('original callback failed'))
}

const run = scenarios[process.argv[2] ?? '']
if (!run) throw new Error(`unknown scenario ${process.argv[2]}`)
void run().then(
    async (result) => {
        await sleep(100)
        console.log(`RESULT ${JSON.stringify({ result, escaped })}`)
        process.exit(0)
    },
    (err: Error) => {
        console.log(
            `RESULT ${JSON.stringify({ error: err.message, escaped })}`
        )
        process.exit(0)
    }
)
