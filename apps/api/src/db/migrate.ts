import 'reflect-metadata'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import postgres from 'postgres'
import { CONCURRENT_INDEXES } from './concurrent-index'
import { runJournal } from './migration-runner'

// The OSS entrypoint: the single core journal under drizzle's default table
// name, so a fresh install behaves exactly as it always has. The cloud
// entrypoint (apps/api-cloud/src/db/migrate.ts) chains the legacy cutover and
// a second cloud journal through the same runner and mutex.
const run = async (): Promise<void> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required')

    const client = postgres(url, { max: 1 })
    try {
        // A journal whose first entry is not this chain's baseline predates
        // the editions journal split (or belongs to some other product
        // entirely). Refusing beats the alternative: the migrator's
        // high-watermark would try to replay the baseline into a database
        // whose tables already exist.
        const [first] = await client<{ hash: string }[]>`
            select hash from drizzle.__drizzle_migrations
            order by created_at asc, id asc limit 1
        `.catch(() => [])
        const baseline = readMigrationFiles({ migrationsFolder: './drizzle' })
        if (first && first.hash !== baseline[0].hash)
            throw new Error(
                'this database predates the editions journal split — run the cloud migrate entrypoint once (just db-migrate in the private repo) or reset the database'
            )

        await runJournal(client, {
            folder: './drizzle',
            migrationsTable: '__drizzle_migrations',
            concurrentIndexes: CONCURRENT_INDEXES
        })
    } finally {
        await client.end()
    }
}

run().catch((error) => {
    console.error('migrate', error)
    process.exit(1)
})
