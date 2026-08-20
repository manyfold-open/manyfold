import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    createDb,
    runtimeHosts,
    users,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { DaemonRuntimeSyncService } from '../src/modules/daemon/daemon-runtime-sync.service'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'
import type { TelemetryService } from '../src/common/telemetry/telemetry.service'

// Regression for the `mf setup` 500 (Axiom trace
// 493568c70d90636e9e5ac1b5ac77527f): a machine re-registers under a fresh
// daemon uuid — ADR-0014 profile move, or revoke + re-register — which creates
// a new runtime_hosts row while the old rows keep their names. The sync
// service dedupes by daemonId only, so inserting `<host>-<framework>` hit the
// (user_id, name) unique index: a permanent 23505 dressed up as 'Internal
// server error'. Real Postgres because the FakeDb unit suite structurally
// cannot fail on constraints — it was green against this bug.
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test -- --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    userId: string
    hostName: string
    id: (name: string) => string
    addHost: (name: string, uuid: string) => Promise<RuntimeHostRow>
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    return {
        db,
        userId,
        hostName: `dev502-${suffix}`,
        id: (name: string) => `${name}_${suffix}`,
        addHost: async (name: string, uuid: string) => {
            const [row] = await db
                .insert(runtimeHosts)
                .values({
                    id: `dh_pgtest_${uuid}_${suffix}`,
                    userId,
                    daemonUuid: `${uuid}-${suffix}`,
                    name,
                    homeDir: '/home/dev',
                    status: 'active'
                })
                .returning()
            return row
        },
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

test(
    'a machine re-registered under a new daemon uuid survives its old runtime name',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const oldHost = await h.addHost(h.hostName, 'uuid-old')
            await h.db.insert(agentRuntimes).values({
                id: h.id('art_old'),
                userId: h.userId,
                name: `${h.hostName}-claude-code`,
                framework: 'claude-code',
                kind: 'daemon',
                status: 'ready',
                daemonId: oldHost.id
            })
            const newHost = await h.addHost(h.hostName, 'uuid-new')

            const result = await new DaemonRuntimeSyncService(
                h.db
            ).syncForDaemon({
                host: newHost,
                detectedFrameworks: [
                    {
                        framework: 'claude-code',
                        version: '1.0.0',
                        path: '/usr/local/bin/claude'
                    }
                ]
            })

            assert.equal(result.length, 1)
            assert.equal(result[0].daemonId, newHost.id)
            assert.equal(result[0].status, 'ready')
            assert.equal(result[0].name, `${h.hostName}-claude-code-2`)

            const rows = await h.db
                .select()
                .from(agentRuntimes)
                .where(eq(agentRuntimes.userId, h.userId))
            assert.equal(rows.length, 2, 'old and new runtime rows coexist')
            assert.ok(rows.some((r) => r.id === h.id('art_old')))
        } finally {
            await h.close()
        }
    }
)

test(
    'rename to a name another runtime already holds succeeds',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const host = await h.addHost(h.hostName, 'uuid-a')
            for (const [id, name] of [
                [h.id('art_a'), 'first'],
                [h.id('art_b'), 'second']
            ]) {
                await h.db.insert(agentRuntimes).values({
                    id,
                    userId: h.userId,
                    name,
                    framework: 'claude-code',
                    kind: 'daemon',
                    status: 'ready',
                    daemonId: host.id
                })
            }
            const service = new AgentRuntimesService(
                h.db,
                { event: () => {} } as unknown as TelemetryService
            )

            const renamed = await service.rename(
                h.userId,
                h.id('art_b'),
                'first'
            )

            assert.equal(renamed.name, 'first')
            const rows = await h.db
                .select()
                .from(agentRuntimes)
                .where(eq(agentRuntimes.userId, h.userId))
            assert.deepEqual(
                rows.map((r) => r.name).sort(),
                ['first', 'first'],
                'duplicate names are legal — the user owns naming'
            )
        } finally {
            await h.close()
        }
    }
)
