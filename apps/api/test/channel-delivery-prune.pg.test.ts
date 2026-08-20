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
    channelDeliveries,
    channels,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ChannelsRepository } from '../src/modules/channels/channels.repository'

// Real-Postgres proof for the retention prune: the delete filters a
// PK-ordered LIMIT subquery, which no in-memory mock exercises. Env-gated
// like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/channel-delivery-prune.pg.test.ts
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChannelsRepository
    channelId: string
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
    const channelId = `chn_pgtest_${suffix}`

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
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
    await db.insert(channels).values({
        id: channelId,
        userId,
        agentId,
        provider: 'fake',
        label: 'pgtest-channel',
        status: 'active',
        configJson: {}
    })

    return {
        db,
        repo: new ChannelsRepository(db),
        channelId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const insertDeliveryAt = async (
    h: Harness,
    createdAt: Date,
    status: 'sent' | 'dropped' | 'accepted' = 'sent'
): Promise<bigint> => {
    const [row] = await h.db
        .insert(channelDeliveries)
        .values({
            channelId: h.channelId,
            direction: 'outbound',
            scopeKey: 'pgtest',
            status,
            createdAt,
            updatedAt: createdAt
        })
        .returning({ id: channelDeliveries.id })
    return row.id
}

const countRows = async (h: Harness): Promise<number> => {
    const rows = await h.db
        .select({ id: channelDeliveries.id })
        .from(channelDeliveries)
        .where(eq(channelDeliveries.channelId, h.channelId))
    return rows.length
}

// The prune walks the global table head, so on a shared dev database other
// channels' expired rows drain alongside ours (that is the feature). Assert
// only on this harness's channel plus the batch-size contract.
test('pruneDeliveries removes rows past the cutoff in batches and keeps the rest', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const old = new Date(Date.now() - 40 * 24 * 60 * 60_000)
        const fresh = new Date(Date.now() - 1 * 24 * 60 * 60_000)
        for (let i = 0; i < 5; i++) await insertDeliveryAt(h, old)
        for (let i = 0; i < 3; i++) await insertDeliveryAt(h, fresh)
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000)

        const first = await h.repo.pruneDeliveries(cutoff, 2)
        assert.ok(first <= 2, `batch cap respected, deleted ${first}`)

        for (let i = 0; i < 200; i++) {
            const deleted = await h.repo.pruneDeliveries(cutoff, 100)
            if (deleted === 0) break
        }

        assert.equal(
            await countRows(h),
            3,
            'expired rows pruned, retained rows untouched'
        )
        assert.equal(
            await h.repo.pruneDeliveries(cutoff, 100),
            0,
            'steady state deletes nothing'
        )
    } finally {
        await h.close()
    }
})
