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
    users
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'

// Real-Postgres proof that the web chat's empty-session cleanup cannot take a
// channel scope's session with it: channel_sessions.chat_session_id cascades,
// so only the NOT EXISTS in the real delete keeps the row.
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     npx tsx --test test/chat-session-delete-channel.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

test(
    'deleteSessionIfEmpty keeps an empty chat session a channel scope points at',
    { skip: !RUN },
    async (t) => {
        const url = process.env.DATABASE_URL
        if (!url) throw new Error('DATABASE_URL must be set in .env')
        const db = createDb(url)
        const suffix = randomBytes(8).toString('hex')
        const userId = `user_pgtest_${suffix}`
        const runtimeId = `art_pgtest_${suffix}`
        const agentId = `agt_pgtest_${suffix}`
        const channelId = `chn_pgtest_${suffix}`
        t.after(async () => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        })
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
        const chat = async (name: string): Promise<string> => {
            const id = `cts_${name}_${suffix}`
            await db.insert(chatSessions).values({ id, userId, agentId })
            return id
        }
        const bound = async (
            name: string,
            archivedAt: Date | null
        ): Promise<[string, string]> => {
            const chatSessionId = await chat(name)
            const id = `chs_${name}_${suffix}`
            await db.insert(channelSessions).values({
                id,
                channelId,
                chatSessionId,
                scopeKey: `scope-${name}`,
                isActive: archivedAt === null,
                archivedAt
            })
            return [chatSessionId, id]
        }
        const exists = async (
            table: typeof chatSessions | typeof channelSessions,
            id: string
        ): Promise<boolean> =>
            (await db.select().from(table).where(eq(table.id, id))).length > 0

        const [activeChat, activeScope] = await bound('active', null)
        const [archivedChat] = await bound(
            'archived',
            new Date('2026-09-01T00:00:00Z')
        )
        const loose = await chat('loose')
        const repo = new ChatRepository(db)

        assert.equal(await repo.deleteSessionIfEmpty(activeChat), false)
        assert.equal(await repo.deleteSessionIfEmpty(archivedChat), false)
        assert.equal(await exists(chatSessions, activeChat), true)
        assert.equal(await exists(channelSessions, activeScope), true)

        assert.equal(await repo.deleteSessionIfEmpty(loose), true)
        assert.equal(await exists(chatSessions, loose), false)

        assert.equal(await repo.deleteSession(activeChat), true)
        assert.equal(await exists(channelSessions, activeScope), false)
    }
)
