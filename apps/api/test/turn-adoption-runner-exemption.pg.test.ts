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
    createDb,
    runtimeHosts,
    turnExecutions,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'

// A sprite turn can be carried by the sprite's OWN runner over
// the daemon transport. Two independent recovery paths then exist for the same
// turn, and only one of them holds the turn lease:
//
//   - the reverse-WS resume (runner reconnects, reports its inflight stream) —
//     does NOT touch turn_executions;
//   - the adoption sweep (lease lapsed) — replays from the framework transcript.
//
// So a runner turn that outlives its 90s lease after an API restart would be
// adopted WHILE its own resume is streaming. The two writers land on different
// api instances, so ChatService's in-process runningAdapters guard cannot see
// it. The sweep query has to do the arbitration, which is what this pins.
//
// The staging drill could not catch this: its turn finished 28s after the
// restart, inside the lease.
//
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test -- --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChatRepository
    userId: string
    agentId: string
    sessionId: string
    // Fixture ids are suffixed per run: turn_executions rows outlive a failed
    // run, and a fixed id then collides on the pkey forever after.
    id: (name: string) => string
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
    await db.insert(chatSessions).values({ id: sessionId, userId, agentId })

    return {
        db,
        repo: new ChatRepository(db),
        userId,
        agentId,
        sessionId,
        id: (name: string) => `${name}_${suffix}`,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

// A sprite turn whose lease lapsed 60s ago — adoptable unless something exempts
// it. `carrier` mirrors what chat.service stamps for a runner turn.
const insertLapsedTurn = async (
    h: Harness,
    id: string,
    carrier?: { hostId: string; execRef: string | null }
): Promise<void> => {
    await h.db.insert(chatMessages).values({
        id,
        sessionId: h.sessionId,
        role: 'assistant',
        contentBlocksJson: [],
        ...(carrier
            ? { daemonId: carrier.hostId, daemonExecRef: carrier.execRef }
            : {})
    })
    await h.db.insert(turnExecutions).values({
        messageId: id,
        sessionId: h.sessionId,
        agentId: h.agentId,
        runtime: 'sprites',
        spriteName: `art-${id}`,
        ownerId: 'dead-instance',
        leaseExpiresAt: new Date(Date.now() - 60_000),
        state: 'running'
    })
}

// The runner's websocket truth is rpc_last_seen_at, not last_seen_at: a runner
// frozen by sprite suspension keeps its heartbeat row but stops answering pings.
const insertRunnerHost = async (
    h: Harness,
    id: string,
    rpcSeenMsAgo: number
): Promise<void> => {
    await h.db.insert(runtimeHosts).values({
        id,
        userId: h.userId,
        name: `sprite-runner:art-${id}`,
        lastSeenAt: new Date(),
        rpcLastSeenAt: new Date(Date.now() - rpcSeenMsAgo)
    })
}

const adoptableIds = async (h: Harness): Promise<string[]> =>
    (await h.repo.listAdoptableTurnExecutions(50)).map((r) => r.messageId)

test(
    'a lapsed sprite turn whose runner is still connected is NOT adoptable',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const host = h.id('dh_live')
            const turn = h.id('m_runner_live')
            await insertRunnerHost(h, host, 5_000)
            await insertLapsedTurn(h, turn, { hostId: host, execRef: turn })
            // The runner will resume this turn itself; adopting it in parallel
            // would replay the transcript on top of the live stream.
            assert.ok(!(await adoptableIds(h)).includes(turn))
            // Same row, liveness window collapsed to zero: it comes back. That
            // is what proves the exclusion above is the exemption doing its job
            // (the row is otherwise a perfectly adoptable lapsed turn) and that
            // the threshold is what decides.
            const withNoWindow = await h.repo.listAdoptableTurnExecutions(50, {
                daemonOnlineMs: 0
            })
            assert.ok(withNoWindow.some((r) => r.messageId === turn))
        } finally {
            await h.close()
        }
    }
)

test(
    'once the runner stops answering, the turn becomes adoptable again',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // Past the online threshold: no reverse-WS resume is coming, so the
            // transcript-recovery path is the only way this turn ever finishes.
            const host = h.id('dh_gone')
            const turn = h.id('m_runner_gone')
            await insertRunnerHost(h, host, 5 * 60_000)
            await insertLapsedTurn(h, turn, { hostId: host, execRef: turn })
            assert.ok((await adoptableIds(h)).includes(turn))
        } finally {
            await h.close()
        }
    }
)

test(
    'the exemption does not swallow a plain sprite turn',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            // No carrier at all — today's sprite-exec turn, the case adoption
            // was built for. It must stay adoptable.
            const plain = h.id('m_plain')
            await insertLapsedTurn(h, plain)
            // Stamped daemon_id but no exec ref: nothing to resume from, same
            // guard the dead-turn predicate uses.
            const host = h.id('dh_noref')
            const noRef = h.id('m_no_ref')
            await insertRunnerHost(h, host, 5_000)
            await insertLapsedTurn(h, noRef, { hostId: host, execRef: null })
            const ids = await adoptableIds(h)
            assert.ok(ids.includes(plain))
            assert.ok(ids.includes(noRef))
        } finally {
            await h.close()
        }
    }
)
