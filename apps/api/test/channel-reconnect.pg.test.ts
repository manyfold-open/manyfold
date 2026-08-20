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
    channels,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ChannelsRepository } from '../src/modules/channels/channels.repository'

// Real-Postgres proof for the reconnect backoff columns: markChannelError and
// armChannelReconnect compute next_reconnect_at SQL-side (make_interval +
// power over the stored attempt count), which no in-memory test exercises.
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/channel-reconnect.pg.test.ts
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

const readChannel = async (
    h: Harness
): Promise<{
    status: string
    attempts: number
    nextReconnectAt: Date | null
    lastErrorMessage: string | null
}> => {
    const [row] = await h.db
        .select({
            status: channels.status,
            attempts: channels.reconnectAttempts,
            nextReconnectAt: channels.nextReconnectAt,
            lastErrorMessage: channels.lastErrorMessage
        })
        .from(channels)
        .where(eq(channels.id, h.channelId))
        .limit(1)
    return row
}

const delayFromNowMs = (at: Date | null): number =>
    (at?.getTime() ?? 0) - Date.now()

test('markChannelError grows the backoff exponentially and caps it', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const first = await h.repo.markChannelError(h.channelId, 'ws down')
        assert.equal(first, 1)
        let row = await readChannel(h)
        assert.equal(row.status, 'error')
        assert.equal(row.lastErrorMessage, 'ws down')
        let delay = delayFromNowMs(row.nextReconnectAt)
        assert.ok(
            delay > 25_000 && delay < 35_000,
            `attempt 1 backoff ≈30s, got ${delay}ms`
        )

        const second = await h.repo.markChannelError(h.channelId, 'still down')
        assert.equal(second, 2)
        row = await readChannel(h)
        delay = delayFromNowMs(row.nextReconnectAt)
        assert.ok(
            delay > 55_000 && delay < 65_000,
            `attempt 2 backoff ≈60s, got ${delay}ms`
        )

        await h.db
            .update(channels)
            .set({ reconnectAttempts: 12 })
            .where(eq(channels.id, h.channelId))
        const thirteenth = await h.repo.markChannelError(
            h.channelId,
            'still down'
        )
        assert.equal(thirteenth, 13)
        row = await readChannel(h)
        delay = delayFromNowMs(row.nextReconnectAt)
        assert.ok(
            delay > 590_000 && delay < 610_000,
            `backoff capped at 600s, got ${delay}ms`
        )
    } finally {
        await h.close()
    }
})

test('markChannelConnected resets status and backoff state', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        await h.repo.markChannelError(h.channelId, 'ws down')
        await h.repo.markChannelError(h.channelId, 'still down')

        await h.repo.markChannelConnected(h.channelId)

        const row = await readChannel(h)
        assert.equal(row.status, 'active')
        assert.equal(row.attempts, 0)
        assert.equal(row.nextReconnectAt, null)
        assert.equal(row.lastErrorMessage, null)
    } finally {
        await h.close()
    }
})

test('armChannelReconnect increments, arms a future window, preserves the cause, and no-ops off error status', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        await h.repo.markChannelError(h.channelId, 'ws down')

        const armed = await h.repo.armChannelReconnect(h.channelId)
        assert.equal(armed, 2)
        let row = await readChannel(h)
        assert.equal(row.status, 'error')
        assert.equal(row.attempts, 2)
        assert.equal(
            row.lastErrorMessage,
            'ws down',
            'arm preserves the original cause'
        )
        const delay = delayFromNowMs(row.nextReconnectAt)
        assert.ok(
            delay > 55_000 && delay < 65_000,
            `exponent uses the pre-increment attempt count (≈60s), got ${delay}ms`
        )

        await h.repo.markChannelConnected(h.channelId)
        const armedOffError = await h.repo.armChannelReconnect(h.channelId)
        assert.equal(armedOffError, null, 'no-op once the row left error')
        row = await readChannel(h)
        assert.equal(row.status, 'active')
        assert.equal(row.attempts, 0)
        assert.equal(row.nextReconnectAt, null)

        const missing = await h.repo.armChannelReconnect('chn_pgtest_missing')
        assert.equal(missing, null)
    } finally {
        await h.close()
    }
})

test('markChannelError on a missing channel returns null', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const result = await h.repo.markChannelError(
            'chn_pgtest_missing',
            'nope'
        )
        assert.equal(result, null)
    } finally {
        await h.close()
    }
})
