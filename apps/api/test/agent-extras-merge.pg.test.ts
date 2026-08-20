import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    createDb,
    jsonbMerge,
    users,
    type Database
} from '@manyfold/db'

// Real-Postgres proof that agents.extras writes are atomic key-level merges, not
// whole-column read-modify-write. The bug: a user saved env vars (extras.envText)
// and on refresh they were occasionally gone, because a concurrent background
// writer (reconcile / model-config) held an extras snapshot read BEFORE the save
// and wrote it back, clobbering envText. jsonbMerge merges against the LIVE row in
// SQL, so a stale-snapshot writer can only touch its own keys. Env-gated like the
// other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    agentId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agt_pgtest_${suffix}`

    await db.insert(users).values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'sprites'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'pgtest-agent',
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId,
        internalId: `internal-${agentId}`
    })

    return {
        db,
        agentId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const readExtras = async (h: Harness): Promise<Record<string, unknown>> => {
    const [row] = await h.db
        .select({ extras: agents.extras })
        .from(agents)
        .where(eq(agents.id, h.agentId))
        .limit(1)
    return (row?.extras ?? {}) as Record<string, unknown>
}

test(
    'a stale-snapshot background write does not clobber a freshly-saved envText',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // A background writer (reconcile) reads the agent's extras here, BEFORE
            // any env vars exist. This snapshot is what the buggy spread used.
            const staleSnapshot = await readExtras(h)
            assert.deepEqual(staleSnapshot, {})

            // The user saves env vars in between the snapshot read and the
            // background write.
            await h.db
                .update(agents)
                .set({ extras: jsonbMerge(agents.extras, { envText: 'API_KEY=secret' }) })
                .where(eq(agents.id, h.agentId))

            // The background writer now lands its write. It owns only spriteId +
            // workspaceManaged; with the old `{ ...staleSnapshot, ...live }` spread
            // this whole-column overwrite would drop envText. jsonbMerge overlays
            // only its keys onto the live row.
            void staleSnapshot
            await h.db
                .update(agents)
                .set({
                    extras: jsonbMerge(agents.extras, {
                        spriteId: 'spr_123',
                        workspaceManaged: true
                    })
                })
                .where(eq(agents.id, h.agentId))

            const extras = await readExtras(h)
            assert.equal(extras.envText, 'API_KEY=secret')
            assert.equal(extras.spriteId, 'spr_123')
            assert.equal(extras.workspaceManaged, true)
        } finally {
            await h.close()
        }
    }
)

test(
    'jsonbMerge overwrites only the keys it owns and leaves siblings intact',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.db
                .update(agents)
                .set({
                    extras: jsonbMerge(agents.extras, {
                        envText: 'A=1',
                        modelConfig: { source: 'platform' }
                    })
                })
                .where(eq(agents.id, h.agentId))

            await h.db
                .update(agents)
                .set({
                    extras: jsonbMerge(agents.extras, {
                        modelConfig: { source: 'agent-refresh' }
                    })
                })
                .where(eq(agents.id, h.agentId))

            const extras = await readExtras(h)
            assert.equal(extras.envText, 'A=1')
            assert.deepEqual(extras.modelConfig, { source: 'agent-refresh' })
        } finally {
            await h.close()
        }
    }
)
