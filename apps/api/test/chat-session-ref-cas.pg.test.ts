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

// Real-Postgres proof for clearFrameworkSessionRefIfMatches, the compare-and-
// clear the gemini stale-resume self-heal depends on (#729). The adapter tests
// stub the repository, so the WHERE predicate that makes this a CAS rather than
// a blind reset — and the row count that reports who won — is only exercised
// here. A losing clear must be a no-op AND must say so, because the adapter
// picks the user-facing hint from that answer.
//
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

const STALE_REF = '8f3d5f0e-2c7a-4c1f-9a58-1b2c3d4e5f60'

interface Harness {
    db: Database
    repo: ChatRepository
    sessionId: string
    storedRef: () => Promise<string | null>
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
            framework: 'gemini-cli',
            kind: 'sprites'
        })
        await db.insert(agents).values({
            id: agentId,
            userId,
            name: 'pgtest-agent',
            framework: 'gemini-cli',
            runtime: 'sprites',
            runtimeId,
            internalId: `internal-${agentId}`
        })
        await db.insert(chatSessions).values({
            id: sessionId,
            userId,
            agentId,
            frameworkSessionRef: STALE_REF
        })
    } catch (err) {
        // Preserve the setup failure while still making a best-effort attempt
        // to remove any partially inserted fixture and close the client.
        await cleanup().catch(() => undefined)
        throw err
    }

    return {
        db,
        repo: new ChatRepository(db),
        sessionId,
        storedRef: async () => {
            const rows = await db
                .select({ ref: chatSessions.frameworkSessionRef })
                .from(chatSessions)
                .where(eq(chatSessions.id, sessionId))
            return rows[0]?.ref ?? null
        },
        close: cleanup
    }
}

test(
    'the matching ref is cleared and the clear is reported',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            assert.equal(
                await h.repo.clearFrameworkSessionRefIfMatches(
                    h.sessionId,
                    STALE_REF
                ),
                true
            )
            assert.equal(await h.storedRef(), null)
        } finally {
            await h.close()
        }
    }
)

test(
    'a ref replaced since the turn read it is left alone',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.repo.updateFrameworkSessionRef(h.sessionId, 'sess-newer')

            assert.equal(
                await h.repo.clearFrameworkSessionRefIfMatches(
                    h.sessionId,
                    STALE_REF
                ),
                false
            )
            assert.equal(await h.storedRef(), 'sess-newer')
        } finally {
            await h.close()
        }
    }
)

// Two failing turns of the same chat can land together; exactly one may report
// that it did the clearing, or the adapter would tell two users a reset
// happened twice.
test('only one of two concurrent clears wins', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const results = await Promise.all([
            h.repo.clearFrameworkSessionRefIfMatches(h.sessionId, STALE_REF),
            h.repo.clearFrameworkSessionRefIfMatches(h.sessionId, STALE_REF)
        ])

        assert.deepEqual(results.filter(Boolean).length, 1)
        assert.equal(await h.storedRef(), null)
    } finally {
        await h.close()
    }
})

// An already-null ref must not read as "this call cleared it": the adapter only
// reaches here with a non-null attempted ref, so a null row means someone else
// got there first.
test(
    'a session that already has no ref reports no clear',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await h.repo.updateFrameworkSessionRef(h.sessionId, null)

            assert.equal(
                await h.repo.clearFrameworkSessionRefIfMatches(
                    h.sessionId,
                    STALE_REF
                ),
                false
            )
        } finally {
            await h.close()
        }
    }
)
