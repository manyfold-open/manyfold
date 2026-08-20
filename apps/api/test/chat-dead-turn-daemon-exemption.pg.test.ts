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
    chatMessages,
    chatSessions,
    chatStreamEvents,
    createDb,
    runtimeHosts,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'

// Real-Postgres proof for the daemon-liveness exemption shared by the three
// dead-turn queries (listOrphanedAssistantMessages, latestDeadInflightMessage,
// deadInflightMessageById) after they were DRY'd onto one predicate helper
// (notResumableByLiveDaemon). The exemption is what keeps a merely-disconnected
// daemon turn — one the reverse-WS resume path will finish — from being
// terminalized. The in-memory chat tests stub the repo, so only live PG
// exercises the real SQL. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test -- --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChatRepository
    userId: string
    sessionId: string
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
    const sessionId = `cts_pgtest_${suffix}`

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'daemon'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'pgtest-agent',
        framework: 'claude-code',
        runtime: 'daemon',
        runtimeId,
        internalId: `internal-${agentId}`
    })
    await db.insert(chatSessions).values({ id: sessionId, userId, agentId })

    return {
        db,
        repo: new ChatRepository(db),
        userId,
        sessionId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const insertAssistant = async (
    h: Harness,
    id: string,
    daemon?: { hostId: string; execRef: string }
): Promise<void> => {
    await h.db.insert(chatMessages).values({
        id,
        sessionId: h.sessionId,
        role: 'assistant',
        contentBlocksJson: [],
        ...(daemon
            ? { daemonId: daemon.hostId, daemonExecRef: daemon.execRef }
            : {})
    })
}

// A daemon host row whose last_seen_at is `sinceMs` in the past.
const insertHost = async (
    h: Harness,
    id: string,
    sinceMs: number
): Promise<void> => {
    await h.db.insert(runtimeHosts).values({
        id,
        userId: h.userId,
        name: `host-${id}`,
        lastSeenAt: new Date(Date.now() - sinceMs)
    })
}

const MIN = 60 * 1000
const HOUR = 60 * MIN

test(
    'a daemon turn whose host is alive is EXEMPT from every dead-turn query',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertHost(h, 'host-live', 1 * MIN) // seen a minute ago
            await insertAssistant(h, 'm-live', {
                hostId: 'host-live',
                execRef: 'm-live'
            })
            // subscribe-time (session) and A2A (by-id) twins both exempt it
            assert.equal(
                await h.repo.latestDeadInflightMessage(h.sessionId),
                null
            )
            assert.equal(await h.repo.deadInflightMessageById('m-live'), null)
            // boot sweep (age gate opened) also exempts it
            const orphans = await h.repo.listOrphanedAssistantMessages({
                messageGraceMs: 0,
                now: new Date(Date.now() + 1000)
            })
            assert.ok(!orphans.some((o) => o.messageId === 'm-live'))
        } finally {
            await h.close()
        }
    }
)

test(
    'a daemon turn whose host went silent past grace IS dead',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertHost(h, 'host-silent', 25 * HOUR) // silent > 24h grace
            await insertAssistant(h, 'm-silent', {
                hostId: 'host-silent',
                execRef: 'm-silent'
            })
            const byId = await h.repo.deadInflightMessageById('m-silent')
            assert.equal(byId?.messageId, 'm-silent')
            const latest = await h.repo.latestDeadInflightMessage(h.sessionId)
            assert.equal(latest?.messageId, 'm-silent')
            const orphans = await h.repo.listOrphanedAssistantMessages({
                messageGraceMs: 0,
                now: new Date(Date.now() + 1000)
            })
            assert.ok(orphans.some((o) => o.messageId === 'm-silent'))
        } finally {
            await h.close()
        }
    }
)

test(
    'a non-daemon turn (no daemon_exec_ref) is always dead-eligible',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertAssistant(h, 'm-sprite') // no daemon ref
            assert.equal(
                (await h.repo.deadInflightMessageById('m-sprite'))?.messageId,
                'm-sprite'
            )
            assert.equal(
                (await h.repo.latestDeadInflightMessage(h.sessionId))
                    ?.messageId,
                'm-sprite'
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a terminalized turn is never reported dead (shared no-terminal half)',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            await insertAssistant(h, 'm-done')
            // Insert the terminal event directly (not via repo.insertStreamEvent,
            // whose turn_executions finalize side-effect is irrelevant here) so the
            // test isolates the shared no-terminal-event predicate.
            await h.db.insert(chatStreamEvents).values({
                sessionId: h.sessionId,
                messageId: 'm-done',
                seq: 1,
                eventType: 'done',
                payloadJson: {}
            })
            assert.equal(await h.repo.deadInflightMessageById('m-done'), null)
            assert.equal(
                await h.repo.latestDeadInflightMessage(h.sessionId),
                null
            )
            const orphans = await h.repo.listOrphanedAssistantMessages({
                messageGraceMs: 0,
                now: new Date(Date.now() + 1000)
            })
            assert.ok(!orphans.some((o) => o.messageId === 'm-done'))
        } finally {
            await h.close()
        }
    }
)

test(
    'a daemon turn with a live host but a custom short grace becomes dead',
    { skip: !RUN },
    async () => {
        // Proves the graceCutoff threads through the shared helper: a host seen 2min
        // ago is exempt at the 24h default but dead under a 1min grace.
        const h = await buildHarness()
        try {
            await insertHost(h, 'host-2m', 2 * MIN)
            await insertAssistant(h, 'm-2m', {
                hostId: 'host-2m',
                execRef: 'm-2m'
            })
            assert.equal(await h.repo.deadInflightMessageById('m-2m'), null)
            assert.equal(
                (
                    await h.repo.deadInflightMessageById('m-2m', {
                        daemonGraceMs: 1 * MIN
                    })
                )?.messageId,
                'm-2m'
            )
        } finally {
            await h.close()
        }
    }
)
