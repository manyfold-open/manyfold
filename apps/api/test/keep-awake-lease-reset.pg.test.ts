import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import postgres from 'postgres'
import { CONCURRENT_INDEXES } from '../src/db/concurrent-index'
import { runJournal } from '../src/db/migration-runner'
import { withScratchDatabase } from '../scripts/scratch-db'

// Migration 0028: the keep-awake switch holds its machine with a task the API
// renews, recorded as {expiresAt, verifiedAt, lastError}. The in-VM lease
// loop's bookkeeping is reset; the switch itself is left as it was, so a host
// kept awake is held again on the next reconcile. Run per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/keep-awake-lease-reset.pg.test.ts

const RUN = process.env.RUN_PG_E2E === '1'
const FOLDER = path.join(process.cwd(), 'drizzle')
const TAG = '0028_keep_awake_lease_reset'

const connect = (url: string) =>
    postgres(url, { max: 1, onnotice: () => undefined })

const journalBefore = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'keep-awake-journal-'))
    cpSync(FOLDER, dir, { recursive: true })
    const journalPath = path.join(dir, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Array<{ tag: string }>
    }
    const at = journal.entries.findIndex((e) => e.tag === TAG)
    const later = journal.entries.slice(at)
    journal.entries = journal.entries.slice(0, at)
    writeFileSync(journalPath, JSON.stringify(journal))
    for (const entry of later) unlinkSync(path.join(dir, `${entry.tag}.sql`))
    return dir
}

const apply = async (url: string, folder: string): Promise<void> => {
    const client = connect(url)
    try {
        await runJournal(client, {
            folder,
            migrationsTable: '__drizzle_migrations',
            concurrentIndexes: CONCURRENT_INDEXES
        })
    } finally {
        await client.end()
    }
}

const legacyLease = (taskName: string | null) =>
    JSON.stringify({
        generation: 3,
        taskName,
        desiredStateAt: '2026-09-27T10:00:00.000Z',
        lastVerifiedAt: '2026-09-27T10:00:01.000Z',
        lastError: null
    })

test('0028 resets the lease loop bookkeeping and leaves every switch as it was', { skip: !RUN }, async () => {
    const before = journalBefore()
    try {
        await withScratchDatabase(
            'keep_awake_reset',
            async ({ url }) => {
                const sql = connect(url)
                try {
                    await sql`insert into users (id, email) values ('usr_ka', 'ka@pgtest.local')`
                    await sql`insert into runtime_providers (id, kind, name, credential_ciphertext) values ('rtp_ka', 'sprites', 'org-ka', 'enc')`
                    await sql`insert into runtime_hosts (id, user_id, kind, provider_id, name, status, keep_awake, keep_awake_lease)
                        values ('sbx_kept', 'usr_ka', 'hosted', 'rtp_ka', 'kept', 'ready', true, ${legacyLease('nca-host-kept-3-a')}::jsonb),
                               ('sbx_off', 'usr_ka', 'hosted', 'rtp_ka', 'off', 'ready', false, ${legacyLease('nca-host-off-3-b')}::jsonb),
                               ('sbx_none', 'usr_ka', 'hosted', 'rtp_ka', 'none', 'ready', false, null)`
                    await apply(url, FOLDER)
                    const hosts = await sql<Array<{ id: string; keep_awake: boolean; keep_awake_lease: unknown }>>`
                        select id, keep_awake, keep_awake_lease from runtime_hosts order by id`
                    assert.deepEqual(
                        hosts.map((h) => [h.id, h.keep_awake, h.keep_awake_lease]),
                        [
                            ['sbx_kept', true, null],
                            ['sbx_none', false, null],
                            ['sbx_off', false, null]
                        ]
                    )
                } finally {
                    await sql.end()
                }
            },
            { migrate: (url) => apply(url, before) }
        )
    } finally {
        rmSync(before, { recursive: true, force: true })
    }
})
