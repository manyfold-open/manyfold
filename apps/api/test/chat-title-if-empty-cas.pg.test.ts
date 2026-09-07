import { createObjectId } from '@manyfold/shared'
import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    chatSessions,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'

// Real-Postgres proof for updateTitleIfEmpty, now that its boolean decides
// whether the sidebar gets a chat-sessions-changed event. The service tests
// stub the repository, so the `title IS NULL` predicate that makes this a CAS —
// and the row count that reports who won — is only exercised here. Two turns of
// the same untitled chat can land together and both derive a title; exactly one
// may report the write, or two events go out for one rename.
//
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChatRepository
    sessionId: string
    storedTitle: () => Promise<string | null>
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const userId = createObjectId('user')
    const runtimeId = createObjectId('agentRuntime')
    const agentId = createObjectId('agent')
    const sessionId = createObjectId('chatSession')
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    const closeClient = async (): Promise<void> => {
        if (client?.end) await client.end()
    }
    const cleanup = async (): Promise<void> => {
        try {
            await db.delete(users).where(eq(users.id, userId))
        } finally {
            await closeClient()
        }
    }

    try {
        await db.insert(users).values({
            id: userId,
            email: `${userId}@pgtest.local`
        })
        await db.insert(agentRuntimes).values({
            id: runtimeId,
            userId,
            name: `pgtest-runtime-${runtimeId}`,
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
        await db.insert(chatSessions).values({
            id: sessionId,
            userId,
            agentId,
            title: null
        })
    } catch (err) {
        await cleanup().catch(() => undefined)
        throw err
    }

    return {
        db,
        repo: new ChatRepository(db),
        sessionId,
        storedTitle: async () => {
            const rows = await db
                .select({ title: chatSessions.title })
                .from(chatSessions)
                .where(eq(chatSessions.id, sessionId))
            return rows[0]?.title ?? null
        },
        close: cleanup
    }
}

test(
    'an untitled session is titled and the write is reported',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            assert.equal(
                await h.repo.updateTitleIfEmpty(h.sessionId, 'ship the fix'),
                true
            )
            assert.equal(await h.storedTitle(), 'ship the fix')
        } finally {
            await h.close()
        }
    }
)

test(
    'an already titled session is left alone and reports no write',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.repo.updateTitleIfEmpty(h.sessionId, 'first title')

            assert.equal(
                await h.repo.updateTitleIfEmpty(h.sessionId, 'second title'),
                false
            )
            assert.equal(await h.storedTitle(), 'first title')
        } finally {
            await h.close()
        }
    }
)

test('only one of two concurrent titlings wins', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const results = await Promise.all([
            h.repo.updateTitleIfEmpty(h.sessionId, 'turn a'),
            h.repo.updateTitleIfEmpty(h.sessionId, 'turn b')
        ])

        assert.equal(results.filter(Boolean).length, 1)
        assert.ok(['turn a', 'turn b'].includes((await h.storedTitle()) ?? ''))
    } finally {
        await h.close()
    }
})
