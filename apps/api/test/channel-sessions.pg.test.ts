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
    channelSessions,
    chatSessions,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ChannelsRepository } from '../src/modules/channels/channels.repository'

// Real-Postgres proof for archiveSession: the one-active-per-scope rule is a
// partial unique index, which only a real database enforces. Env-gated like
// the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/channel-sessions.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChannelsRepository
    userId: string
    agentId: string
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
        framework: 'claude-code'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'pgtest-agent',
        framework: 'claude-code',
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
        userId,
        agentId,
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

const seedSession = async (
    h: Harness,
    id: string,
    opts: { isActive: boolean; createdAt: Date; archivedAt?: Date }
): Promise<void> => {
    const chatSessionId = `chat_${id}`
    await h.db.insert(chatSessions).values({
        id: chatSessionId,
        userId: h.userId,
        agentId: h.agentId
    })
    await h.db.insert(channelSessions).values({
        id,
        channelId: h.channelId,
        chatSessionId,
        scopeKey: 'scope-1',
        isActive: opts.isActive,
        archivedAt: opts.archivedAt ?? null,
        createdAt: opts.createdAt
    })
}

const stateOf = async (
    h: Harness,
    id: string
): Promise<{ isActive: boolean; archivedAt: Date | null }> => {
    const [row] = await h.db
        .select({
            isActive: channelSessions.isActive,
            archivedAt: channelSessions.archivedAt
        })
        .from(channelSessions)
        .where(eq(channelSessions.id, id))
    assert.ok(row, `session ${id} exists`)
    return row
}

// A is active; B and C are inactive, C the newest.
const seedScope = async (h: Harness): Promise<[string, string, string]> => {
    const [a, b, c] = ['a', 'b', 'c'].map(
        (name) => `cs_${name}_${h.channelId}`
    ) as [string, string, string]
    await seedSession(h, a, {
        isActive: true,
        createdAt: new Date('2026-09-01T00:00:00Z')
    })
    await seedSession(h, b, {
        isActive: false,
        createdAt: new Date('2026-09-02T00:00:00Z')
    })
    await seedSession(h, c, {
        isActive: false,
        createdAt: new Date('2026-09-03T00:00:00Z')
    })
    return [a, b, c]
}

test(
    'archiving an inactive session with activateFallback leaves the active one alone',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const [a, b, c] = await seedScope(h)

            const result = await h.repo.archiveSession(b, {
                activateFallback: true
            })

            assert.equal(result.archived.id, b)
            assert.equal(result.fallbackActivated, null)
            assert.equal((await stateOf(h, a)).isActive, true)
            assert.notEqual((await stateOf(h, b)).archivedAt, null)
            assert.equal((await stateOf(h, c)).isActive, false)
        } finally {
            await h.close()
        }
    }
)

test(
    'archiving an archived session again keeps the time it was archived',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const id = `cs_gone_${h.channelId}`
            const archivedAt = new Date('2026-01-01T00:00:00Z')
            await seedSession(h, id, {
                isActive: false,
                createdAt: new Date('2025-12-01T00:00:00Z'),
                archivedAt
            })

            const result = await h.repo.archiveSession(id, {
                activateFallback: true
            })

            assert.equal(result.fallbackActivated, null)
            assert.deepEqual((await stateOf(h, id)).archivedAt, archivedAt)
        } finally {
            await h.close()
        }
    }
)

test(
    'archiving the active session with activateFallback activates the newest remaining one',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const [a, b, c] = await seedScope(h)

            const result = await h.repo.archiveSession(a, {
                activateFallback: true
            })

            assert.equal(result.fallbackActivated?.id, c)
            assert.equal((await stateOf(h, a)).isActive, false)
            assert.equal((await stateOf(h, b)).isActive, false)
            assert.equal((await stateOf(h, c)).isActive, true)
        } finally {
            await h.close()
        }
    }
)
