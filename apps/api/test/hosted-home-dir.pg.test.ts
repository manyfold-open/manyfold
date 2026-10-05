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
import { K8S_HOME_BASE, SPRITE_HOME_BASE } from '@manyfold/shared'
import { CONCURRENT_INDEXES } from '../src/db/concurrent-index'
import { runJournal } from '../src/db/migration-runner'
import { withScratchDatabase } from '../scripts/scratch-db'

// Migration 0032: a sandbox or cloud computer created before the host merge
// (0027) lost its home, because the merge moved its daemon but not the
// declaration the daemon's own row held. The home its provider's image runs
// under is restored; the declared workspace and skill roots stay unset, and a
// machine whose daemon declared its contract keeps what it declared. Run
// per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/hosted-home-dir.pg.test.ts

const RUN = process.env.RUN_PG_E2E === '1'
const FOLDER = path.join(process.cwd(), 'drizzle')
const TAG = '0032_hosted_home_dir'

const connect = (url: string) =>
    postgres(url, { max: 1, onnotice: () => undefined })

const journalBefore = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hosted-home-journal-'))
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

test(
    '0032 restores the provider home of a merged hosted machine and leaves declared contracts alone',
    { skip: !RUN },
    async () => {
        const before = journalBefore()
        try {
            await withScratchDatabase(
                'hosted_home_dir',
                async ({ url }) => {
                    const sql = connect(url)
                    try {
                        await sql`insert into users (id, email) values ('usr_hd', 'hd@pgtest.local')`
                        await sql`insert into runtime_providers (id, kind, name, credential_ciphertext)
                        values ('rtp_spr', 'sprites', 'org-hd', 'enc'), ('rtp_k8s', 'k8s', 'cluster-hd', 'enc')`
                        await sql`insert into runtime_hosts (id, user_id, kind, provider_id, name, status, home_dir, workspace_base_dir, skills_dir)
                        values ('sbx_merged', 'usr_hd', 'hosted', 'rtp_spr', 'merged', 'ready', null, null, null),
                               ('sbx_declared', 'usr_hd', 'hosted', 'rtp_spr', 'declared', 'ready', '/home/sprite', '/home/sprite/.manyfold/workspaces', '/home/sprite/.manyfold/skills'),
                               ('pod_merged', 'usr_hd', 'hosted', 'rtp_k8s', 'pod', 'ready', null, null, null),
                               ('dmn_local', 'usr_hd', 'local', null, 'laptop', 'ready', null, null, null)`
                        await apply(url, FOLDER)
                        const hosts = await sql<
                            Array<{
                                id: string
                                home_dir: string | null
                                workspace_base_dir: string | null
                                skills_dir: string | null
                            }>
                        >`
                        select id, home_dir, workspace_base_dir, skills_dir from runtime_hosts order by id`
                        assert.deepEqual(
                            hosts.map((h) => [
                                h.id,
                                h.home_dir,
                                h.workspace_base_dir,
                                h.skills_dir
                            ]),
                            [
                                ['dmn_local', null, null, null],
                                ['pod_merged', K8S_HOME_BASE, null, null],
                                [
                                    'sbx_declared',
                                    '/home/sprite',
                                    '/home/sprite/.manyfold/workspaces',
                                    '/home/sprite/.manyfold/skills'
                                ],
                                ['sbx_merged', SPRITE_HOME_BASE, null, null]
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
    }
)
