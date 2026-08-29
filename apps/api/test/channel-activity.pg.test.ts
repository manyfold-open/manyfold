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
    channelSessions,
    channels,
    chatSessions,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ChannelsRepository } from '../src/modules/channels/channels.repository'

// Real-Postgres proof for the dashboard aggregates. Both are `count(*)
// filter (...)` / `max(...)` GROUP BYs, and the api unit tests use a fake db
// whose where() is a no-op — so the direction filter, the delivered-status
// filter, the created_at cutoff and the tenant scoping can only be proven
// here. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://... npx tsx --test test/channel-activity.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChannelsRepository
    channelId: string
    otherChannelId: string
    agentId: string
    userId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const otherUserId = `user_pgtest_other_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agt_pgtest_${suffix}`
    const otherAgentId = `agt_pgtest_other_${suffix}`
    const channelId = `chn_pgtest_${suffix}`
    const otherChannelId = `chn_pgtest_other_${suffix}`

    for (const [id, email] of [
        [userId, `${suffix}@pgtest.local`],
        [otherUserId, `other-${suffix}@pgtest.local`]
    ])
        await db.insert(users).values({ id, email })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'sprites'
    })
    for (const [id, owner] of [
        [agentId, userId],
        [otherAgentId, otherUserId]
    ])
        await db.insert(agents).values({
            id,
            userId: owner,
            name: `pgtest-agent-${id}`,
            framework: 'claude-code',
            runtime: 'sprites',
            runtimeId,
            internalId: `internal-${id}`
        })
    for (const [id, owner, agent] of [
        [channelId, userId, agentId],
        [otherChannelId, otherUserId, otherAgentId]
    ])
        await db.insert(channels).values({
            id,
            userId: owner,
            agentId: agent,
            provider: 'fake',
            label: `pgtest-${id}`,
            status: 'active',
            configJson: {}
        })

    return {
        db,
        repo: new ChannelsRepository(db),
        channelId,
        otherChannelId,
        agentId,
        userId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(users).where(eq(users.id, otherUserId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const delivery = async (
    h: Harness,
    input: {
        channelId?: string
        direction: 'inbound' | 'outbound' | 'system'
        status?: string
        createdAt: Date
    }
): Promise<bigint> => {
    const [row] = await h.db
        .insert(channelDeliveries)
        .values({
            channelId: input.channelId ?? h.channelId,
            direction: input.direction,
            scopeKey: 'pgtest',
            status: (input.status ?? 'sent') as 'sent',
            createdAt: input.createdAt,
            updatedAt: input.createdAt
        })
        .returning({ id: channelDeliveries.id })
    return row.id
}

const day = (n: number): Date => new Date(Date.now() - n * 86_400_000)

test('delivery counts respect the window, direction and delivered status', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await delivery(h, { direction: 'inbound', createdAt: day(1) })
        await delivery(h, { direction: 'inbound', createdAt: day(2) })
        // Outside the 7-day window below.
        await delivery(h, { direction: 'inbound', createdAt: day(40) })
        await delivery(h, { direction: 'outbound', createdAt: day(1) })
        await delivery(h, {
            direction: 'outbound',
            status: 'accepted',
            createdAt: day(1)
        })
        // Never delivered — must not be counted as a message.
        await delivery(h, {
            direction: 'outbound',
            status: 'dropped',
            createdAt: day(1)
        })
        await delivery(h, {
            direction: 'outbound',
            status: 'failed',
            createdAt: day(1)
        })
        await delivery(h, {
            direction: 'outbound',
            status: 'pending',
            createdAt: day(1)
        })
        // Bookkeeping, not a message.
        await delivery(h, { direction: 'system', createdAt: day(1) })
        // Another tenant's channel must never leak in.
        await delivery(h, {
            channelId: h.otherChannelId,
            direction: 'inbound',
            createdAt: day(1)
        })

        const counts = await h.repo.deliveryCountsByChannel(
            [h.channelId],
            day(7)
        )
        assert.deepEqual(counts.get(h.channelId), { inbound: 2, outbound: 2 })
        assert.equal(counts.has(h.otherChannelId), false)

        const wide = await h.repo.deliveryCountsByChannel([h.channelId], day(60))
        assert.equal(wide.get(h.channelId)?.inbound, 3)
    } finally {
        await h.close()
    }
})

test('an outbound row advanced through its statuses counts once', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        const createdAt = day(1)
        const id = await delivery(h, {
            direction: 'outbound',
            status: 'pending',
            createdAt
        })
        for (const status of ['queued', 'processing', 'sent'] as const)
            await h.db
                .update(channelDeliveries)
                .set({ status })
                .where(eq(channelDeliveries.id, id))

        const counts = await h.repo.deliveryCountsByChannel(
            [h.channelId],
            day(7)
        )
        assert.deepEqual(counts.get(h.channelId), { inbound: 0, outbound: 1 })
    } finally {
        await h.close()
    }
})

test('empty id list short-circuits without querying', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        assert.equal((await h.repo.deliveryCountsByChannel([], day(7))).size, 0)
        assert.equal((await h.repo.sessionActivityByChannel([])).size, 0)
    } finally {
        await h.close()
    }
})

test('session stamps include archived sessions and survive an empty window', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        const mkSession = async (
            key: string,
            lastInboundAt: Date | null,
            lastOutboundAt: Date | null,
            archivedAt: Date | null
        ): Promise<void> => {
            const chatSessionId = `cs_pgtest_${randomBytes(6).toString('hex')}`
            await h.db.insert(chatSessions).values({
                id: chatSessionId,
                userId: h.userId,
                agentId: h.agentId,
                title: key
            })
            await h.db.insert(channelSessions).values({
                id: `chs_pgtest_${randomBytes(6).toString('hex')}`,
                channelId: h.channelId,
                chatSessionId,
                scopeKey: key,
                lastInboundAt,
                lastOutboundAt,
                archivedAt,
                isActive: archivedAt === null
            })
        }

        await mkSession('live', day(3), day(2), null)
        // Archived, and the most recent activity on the channel — archiving
        // does not un-happen the messages, so it must win the max().
        await mkSession('archived', day(1), null, day(1))
        await mkSession('quiet', null, null, null)

        const stamps = await h.repo.sessionActivityByChannel([h.channelId])
        const row = stamps.get(h.channelId)
        assert.ok(row)
        assert.ok(row.lastInboundAt)
        assert.ok(row.lastInboundAt.getTime() > day(2).getTime())
        assert.ok(row.lastOutboundAt)

        // The channel has a lifetime stamp but nothing inside a 1-hour window:
        // the dashboard must be able to show "0 messages, last seen 1d ago".
        const counts = await h.repo.deliveryCountsByChannel(
            [h.channelId],
            new Date(Date.now() - 3_600_000)
        )
        assert.equal(counts.get(h.channelId), undefined)
    } finally {
        await h.close()
    }
})
