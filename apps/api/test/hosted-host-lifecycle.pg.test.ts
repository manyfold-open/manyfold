import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    createDb,
    plans,
    runtimeHosts,
    runtimeProviders,
    users,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { withScratchDatabase } from '../scripts/scratch-db'
import { HostedHostLifecycleService } from '../src/modules/agent-runtimes/hosted-host-lifecycle.service'
import { HostsService } from '../src/modules/hosts/hosts.service'
import { RuntimeProvidersService } from '../src/modules/hosts/runtime-providers.service'

// Deleting a hosted host asks its adapter to destroy the machine even when the
// create never recorded one: a sprite that came up after its create timed out
// carries the host's name and nothing else points at it. A destroy that fails
// keeps the row at `deleting` for the reaper. Run per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/hosted-host-lifecycle.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    lifecycle: HostedHostLifecycleService
    destroyed: RuntimeHostRow[]
    failDestroy: { current: Error | null }
    host: (values: Partial<typeof runtimeHosts.$inferInsert>) => Promise<string>
    row: (id: string) => Promise<RuntimeHostRow | undefined>
}

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

const withHarness = (body: (h: Harness) => Promise<void>): Promise<void> =>
    withScratchDatabase('hostlife', async ({ url }) => {
        const db = createDb(url, { max: 2 })
        const sfx = randomBytes(6).toString('hex')
        const ids = {
            plan: `plan_pgtest_${sfx}`,
            user: `user_pgtest_${sfx}`,
            provider: `rtp_pgtest_${sfx}`
        }
        const destroyed: RuntimeHostRow[] = []
        const failDestroy: Harness['failDestroy'] = { current: null }
        const adapter = {
            destroy: async ({ host }: { host: RuntimeHostRow }) => {
                destroyed.push(host)
                if (failDestroy.current) throw failDestroy.current
            }
        }
        const lifecycle = new HostedHostLifecycleService(
            db,
            new HostsService(db as never),
            new RuntimeProvidersService(db as never),
            { for: () => adapter } as never,
            { settleHostNotRunning: async () => {} } as never,
            { event() {} } as never
        )
        try {
            await db.insert(plans).values({
                id: ids.plan,
                name: `pgtest-${sfx}`,
                maxAgentsProvisioned: 3,
                maxConcurrentActive: 1,
                maxStorageGb: 3
            })
            await db.insert(users).values({
                id: ids.user,
                email: `${sfx}@pgtest.local`,
                planId: ids.plan
            })
            await db.insert(runtimeProviders).values({
                id: ids.provider,
                kind: 'sprites',
                name: `pgtest-${sfx}`,
                credentialCiphertext: 'encrypted'
            })
            let seq = 0
            await body({
                db,
                lifecycle,
                destroyed,
                failDestroy,
                host: async (values) => {
                    seq += 1
                    const id = `sbx_pgtest_${seq}_${sfx}`
                    await db.insert(runtimeHosts).values({
                        id,
                        userId: ids.user,
                        kind: 'hosted',
                        providerId: ids.provider,
                        providerRef: null,
                        name: `pgtest-${seq}`,
                        status: 'failed',
                        ...values
                    })
                    return id
                },
                row: async (id) => {
                    const [row] = await db
                        .select()
                        .from(runtimeHosts)
                        .where(eq(runtimeHosts.id, id))
                        .limit(1)
                    return row
                }
            })
        } finally {
            await closeDb(db)
        }
    })

test(
    'a host whose create never recorded its machine still has the adapter destroy it',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = await h.host({})

            await h.lifecycle.deleteHost(id)

            assert.equal(h.destroyed.length, 1)
            assert.equal(h.destroyed[0].id, id)
            assert.equal(h.destroyed[0].providerRef, null)
            assert.equal(h.destroyed[0].status, 'deleting')
            assert.equal(await h.row(id), undefined)
        })
)

test(
    'a destroy that fails keeps the host at deleting with the reason',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const id = await h.host({})
            h.failDestroy.current = new Error('sprites.dev DELETE timed out')

            await assert.rejects(h.lifecycle.deleteHost(id), /timed out/)

            const row = await h.row(id)
            assert.equal(row?.status, 'deleting')
            assert.equal(row?.failureReason, 'sprites.dev DELETE timed out')
        })
)
