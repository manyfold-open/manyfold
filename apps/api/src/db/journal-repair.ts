import type { MigrationMeta } from 'drizzle-orm/migrator'

export interface RecordedMigration {
    hash: string
    createdAt: string | number
}

export interface JournalRepair {
    hash: string
    from: string
    to: number
}

// drizzle decides what to run by comparing the highest created_at already in
// drizzle.__drizzle_migrations against each journal `when`; it never compares
// hashes. One journal entry carrying a future-dated `when` therefore parks that
// high-water mark ahead of every later migration and skips them silently, exit
// code 0 included (#445). Correcting the journal alone cannot rescue a database
// that already recorded the bad value, so the recorded timestamps are realigned
// with the journal — matched by hash — before the migrator reads them.
export const planJournalRepairs = (
    migrations: MigrationMeta[],
    recorded: RecordedMigration[]
): JournalRepair[] => {
    const byHash = new Map(
        recorded.map((row) => [row.hash, String(row.createdAt)])
    )
    const repairs: JournalRepair[] = []
    for (const migration of migrations) {
        const current = byHash.get(migration.hash)
        if (current === undefined) continue
        if (Number(current) === migration.folderMillis) continue
        repairs.push({
            hash: migration.hash,
            from: current,
            to: migration.folderMillis
        })
    }
    return repairs
}
