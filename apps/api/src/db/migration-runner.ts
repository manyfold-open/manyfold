import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { planJournalRepairs } from './journal-repair'
import { planConcurrentIndex, type ConcurrentIndexSpec } from './concurrent-index'

type Client = ReturnType<typeof postgres>

export interface JournalSpec {
    folder: string
    migrationsTable: string
    concurrentIndexes: ConcurrentIndexSpec[]
    // Bounds only the wait for the migration mutex below, not statements
    // inside the hold.
    lockTimeoutMs?: number
}

const DEFAULT_LOCK_TIMEOUT_MS = 300_000

// One fixed advisory mutex shared by every journal run (and, from M2 on, the
// editions cutover): drizzle's pg migrator has no lock of its own — it reads
// the created_at high-water mark and applies the whole pending batch in one
// transaction — so a second runner started while one is mid-flight would race
// the journal repair updates and the CONCURRENTLY index builds, which live
// outside that transaction. pg_advisory_lock is session-scoped, which is why
// every entrypoint hands runJournal a dedicated max:1 client.
export const acquireMigrationMutex = async (
    client: Client,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS
): Promise<void> => {
    await client.unsafe(`SET lock_timeout = '${timeoutMs}ms'`)
    await client`select pg_advisory_lock(hashtextextended('mf:migration', 0))`
    // Inside the hold, statements keep their unbounded lock semantics —
    // a long CONCURRENTLY build must not be killed by the mutex's timeout.
    await client.unsafe(`SET lock_timeout = 0`)
}

export const releaseMigrationMutex = async (client: Client): Promise<void> => {
    await client`select pg_advisory_unlock(hashtextextended('mf:migration', 0))`
}

const realignJournalTimestamps = async (
    client: Client,
    spec: JournalSpec
): Promise<void> => {
    const [table] = await client<{ present: string | null }[]>`
        select to_regclass(${'drizzle.' + spec.migrationsTable})::text as present
    `
    if (!table?.present) return

    const recorded = await client.unsafe<{ hash: string; created_at: string }[]>(
        `select hash, created_at from drizzle."${spec.migrationsTable}"`
    )
    const repairs = planJournalRepairs(
        readMigrationFiles({ migrationsFolder: spec.folder }),
        recorded.map((row) => ({ hash: row.hash, createdAt: row.created_at }))
    )
    for (const repair of repairs) {
        await client.unsafe(
            `update drizzle."${spec.migrationsTable}"
            set created_at = $1
            where hash = $2`,
            [repair.to, repair.hash]
        )
        console.log(
            `migrate.journal_realigned hash=${repair.hash} from=${repair.from} to=${repair.to}`
        )
    }
}

// Both DDL statements go over the simple protocol. postgres.js only sends a
// standalone statement when nothing is parameterised, and CONCURRENTLY is
// rejected the moment it lands inside a transaction block, so the mode is
// pinned explicitly rather than left to depend on how the query was built.
const buildConcurrentIndex = async (
    client: Client,
    spec: ConcurrentIndexSpec
): Promise<void> => {
    const [table] = await client<{ present: string | null }[]>`
        select to_regclass(${spec.table})::text as present
    `
    // Resolve the index through its TABLE, not through search_path. An index
    // always lives in its parent table's schema, while to_regclass() on a
    // bare name answers with whatever the search_path finds first — so an
    // unrelated relation of the same name in an earlier schema could answer
    // for it. The wrong answer is expensive in one direction: reporting
    // "already present" skips this build and hands the index to the
    // migration's plain CREATE INDEX, which takes the SHARE lock this whole
    // step exists to avoid. The resolved name is also what the drop uses, so
    // a rebuild can never target a different schema's index.
    const [existing] = await client<{ qualified: string; valid: boolean }[]>`
        select
            quote_ident(n.nspname) || '.' || quote_ident(c.relname)
                as qualified,
            i.indisvalid as valid
        from pg_index i
        join pg_class c on c.oid = i.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where i.indrelid = to_regclass(${spec.table})
          and c.relname = ${spec.index}
    `
    const action = planConcurrentIndex({
        tableExists: Boolean(table?.present),
        indexIsValid: existing === undefined ? null : existing.valid
    })

    if (action === 'skip_absent_table') {
        console.log(
            `migrate.concurrent_index_skipped index=${spec.index} reason=table_absent`
        )
        return
    }
    if (action === 'skip_valid') {
        console.log(`migrate.concurrent_index_present index=${spec.index}`)
        return
    }
    if (action === 'rebuild_invalid') {
        console.log(`migrate.concurrent_index_invalid index=${spec.index}`)
        // quote_ident'ed by the catalog, so the name is already safe to
        // interpolate — and it names the index this table actually owns.
        await client
            .unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${existing?.qualified}`)
            .simple()
        console.log(`migrate.concurrent_index_dropped index=${spec.index}`)
    }

    console.log(
        `migrate.concurrent_index_building index=${spec.index} table=${spec.table}`
    )
    const startedAt = Date.now()
    await client.unsafe(spec.create).simple()
    console.log(
        `migrate.concurrent_index_built index=${spec.index} ms=${Date.now() - startedAt}`
    )
}

export const runJournal = async (
    client: Client,
    spec: JournalSpec
): Promise<void> => {
    await acquireMigrationMutex(client, spec.lockTimeoutMs)
    try {
        await realignJournalTimestamps(client, spec)
        for (const index of spec.concurrentIndexes)
            await buildConcurrentIndex(client, index)
        await migrate(drizzle(client), {
            migrationsFolder: spec.folder,
            migrationsTable: spec.migrationsTable
        })
    } finally {
        await releaseMigrationMutex(client)
    }
}
