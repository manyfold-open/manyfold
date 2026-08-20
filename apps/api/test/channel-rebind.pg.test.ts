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
    automations,
    channels,
    channelSessions,
    chatSessions,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ChannelsRepository } from '../src/modules/channels/channels.repository'

// Real-Postgres proof for rebindAgent: the flip of channels.agent_id, the
// archive sweep over channel_sessions and the delivery clear on other agents'
// automations must land in ONE transaction — a fake db cannot show that.
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/channel-rebind.pg.test.ts
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChannelsRepository
    userId: string
    channelId: string
    agentA: string
    agentB: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentA = `agt_pgtest_a_${suffix}`
    const agentB = `agt_pgtest_b_${suffix}`
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
    await db.insert(agents).values([
        {
            id: agentA,
            userId,
            name: 'pgtest-agent-a',
            framework: 'claude-code',
            runtime: 'sprites',
            runtimeId,
            internalId: `internal-${agentA}`
        },
        {
            id: agentB,
            userId,
            name: 'pgtest-agent-b',
            framework: 'claude-code',
            runtime: 'sprites',
            runtimeId,
            internalId: `internal-${agentB}`
        }
    ])
    await db.insert(channels).values({
        id: channelId,
        userId,
        agentId: agentA,
        provider: 'fake',
        label: 'pgtest-channel',
        status: 'active',
        configJson: {}
    })

    return {
        db,
        repo: new ChannelsRepository(db),
        userId,
        channelId,
        agentA,
        agentB,
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
    scopeKey: string,
    opts: { isActive?: boolean; archivedAt?: Date | null } = {}
): Promise<void> => {
    const chatSessionId = `chat_${id}`
    await h.db.insert(chatSessions).values({
        id: chatSessionId,
        userId: h.userId,
        agentId: h.agentA
    })
    await h.db.insert(channelSessions).values({
        id,
        channelId: h.channelId,
        chatSessionId,
        scopeKey,
        isActive: opts.isActive ?? true,
        archivedAt: opts.archivedAt ?? null
    })
}

test(
    'rebindAgent flips the agent, archives live sessions and clears foreign automation delivery',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedSession(h, `cs_active_${h.channelId}`, 'scope-1')
            await seedSession(h, `cs_inactive_${h.channelId}`, 'scope-1', {
                isActive: false
            })
            const archivedAt = new Date('2026-01-01T00:00:00Z')
            await seedSession(h, `cs_archived_${h.channelId}`, 'scope-2', {
                isActive: false,
                archivedAt
            })
            await h.db.insert(automations).values([
                {
                    id: `auto_a_${h.channelId}`,
                    userId: h.userId,
                    agentId: h.agentA,
                    title: 'old-agent automation',
                    prompt: 'p',
                    schedulePreset: 'daily',
                    rrule: 'FREQ=DAILY',
                    timezone: 'UTC',
                    dtstart: new Date(),
                    deliveryChannelId: h.channelId,
                    deliveryTarget: { kind: 'chat', id: 'c1' }
                },
                {
                    id: `auto_b_${h.channelId}`,
                    userId: h.userId,
                    agentId: h.agentB,
                    title: 'new-agent automation',
                    prompt: 'p',
                    schedulePreset: 'daily',
                    rrule: 'FREQ=DAILY',
                    timezone: 'UTC',
                    dtstart: new Date(),
                    deliveryChannelId: h.channelId,
                    deliveryTarget: { kind: 'chat', id: 'c2' }
                }
            ])

            const rebound = await h.repo.rebindAgent(h.channelId, h.agentB)
            assert.equal(rebound?.agentId, h.agentB)

            const sessions = await h.db
                .select()
                .from(channelSessions)
                .where(eq(channelSessions.channelId, h.channelId))
            assert.equal(sessions.length, 3)
            for (const session of sessions) {
                assert.equal(session.isActive, false)
                assert.notEqual(session.archivedAt, null)
            }
            const prearchived = sessions.find(
                (s) => s.id === `cs_archived_${h.channelId}`
            )
            assert.equal(
                prearchived?.archivedAt?.getTime(),
                archivedAt.getTime(),
                'already-archived sessions keep their original archive time'
            )

            const autos = await h.db
                .select()
                .from(automations)
                .where(eq(automations.userId, h.userId))
            const oldAgentAuto = autos.find((a) => a.agentId === h.agentA)
            const newAgentAuto = autos.find((a) => a.agentId === h.agentB)
            assert.equal(oldAgentAuto?.deliveryChannelId, null)
            assert.equal(oldAgentAuto?.deliveryTarget, null)
            assert.equal(
                newAgentAuto?.deliveryChannelId,
                h.channelId,
                'automation already on the target agent keeps its delivery'
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'rebindAgent to a missing channel touches nothing',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await seedSession(h, `cs_keep_${h.channelId}`, 'scope-1')
            const rebound = await h.repo.rebindAgent(
                'chn_does_not_exist',
                h.agentB
            )
            assert.equal(rebound, null)
            const [session] = await h.db
                .select()
                .from(channelSessions)
                .where(eq(channelSessions.channelId, h.channelId))
            assert.equal(session.isActive, true)
            assert.equal(session.archivedAt, null)
        } finally {
            await h.close()
        }
    }
)
