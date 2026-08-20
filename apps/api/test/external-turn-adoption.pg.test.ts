import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    chatMessages,
    chatSessions,
    chatStreamEvents,
    createDb,
    turnExecutions,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'

// #670. The adoption sweep early-outed on `runtime = 'sprites'`, so an external
// turn could hold a lease, be handed off on shutdown, and still never be
// claimed by anyone. Widening that predicate is the change with the largest
// blast radius in this issue — every sprites turn in the fleet runs through the
// same query — so it is pinned against real Postgres, together with the CAS
// that stops two instances delivering the same recovered answer.
//
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test -- --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    repo: ChatRepository
    sessionId: string
    agentId: string
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
        framework: 'dify',
        kind: 'external'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'pgtest-agent',
        framework: 'dify',
        runtime: 'external',
        runtimeId,
        internalId: `internal-${agentId}`
    })
    await db.insert(chatSessions).values({ id: sessionId, userId, agentId })

    return {
        db,
        repo: new ChatRepository(db),
        sessionId,
        agentId,
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

const insertTurn = async (
    h: Harness,
    id: string,
    over: {
        runtime: 'sprites' | 'external' | 'daemon' | 'k8s'
        state?: 'running' | 'handoff' | 'adopting'
        leaseMsFromNow?: number
        ownerId?: string
        generation?: number
        upstreamTaskId?: string | null
        upstreamMessageId?: string | null
    }
): Promise<void> => {
    await h.db.insert(chatMessages).values({
        id,
        sessionId: h.sessionId,
        role: 'assistant',
        contentBlocksJson: []
    })
    await h.db.insert(turnExecutions).values({
        messageId: id,
        sessionId: h.sessionId,
        agentId: h.agentId,
        runtime: over.runtime,
        ownerId: over.ownerId ?? 'dead-instance',
        generation: over.generation ?? 1,
        leaseExpiresAt: new Date(Date.now() + (over.leaseMsFromNow ?? -60_000)),
        state: over.state ?? 'running',
        upstreamTaskId: over.upstreamTaskId ?? null,
        upstreamMessageId: over.upstreamMessageId ?? null
    })
}

const adoptableIds = async (h: Harness): Promise<string[]> =>
    (await h.repo.listAdoptableTurnExecutions(50)).map((r) => r.messageId)

test('the sweep claims lapsed external turns and still claims sprites identically', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const sprite = h.id('sprite-turn')
        const external = h.id('external-turn')
        const daemon = h.id('daemon-turn')
        const live = h.id('live-external-turn')
        await insertTurn(h, sprite, { runtime: 'sprites' })
        await insertTurn(h, external, { runtime: 'external' })
        // The daemon resumes over its own reverse-WS path and does not hold
        // this lease; widening the predicate must not pull it in.
        await insertTurn(h, daemon, { runtime: 'daemon' })
        // An external turn whose owner is alive and renewing.
        await insertTurn(h, live, {
            runtime: 'external',
            leaseMsFromNow: 60_000
        })

        const ids = await adoptableIds(h)

        assert.ok(ids.includes(sprite), 'sprites behaviour is untouched')
        assert.ok(ids.includes(external))
        assert.ok(!ids.includes(daemon))
        assert.ok(!ids.includes(live), 'a live lease is not adoptable')
    } finally {
        await h.close()
    }
})

test('an external turn that already terminalized is never adoptable', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const finished = h.id('finished-external')
        // Sibling with the same shape and no terminal. Without it this test
        // would pass on any code that simply never lists external turns.
        const unfinished = h.id('unfinished-external')
        await insertTurn(h, finished, { runtime: 'external' })
        await insertTurn(h, unfinished, { runtime: 'external' })
        await h.db.insert(chatStreamEvents).values({
            sessionId: h.sessionId,
            messageId: finished,
            seq: 1,
            eventType: 'done',
            payloadJson: { type: 'done' }
        })

        assert.deepEqual(await adoptableIds(h), [unfinished])
    } finally {
        await h.close()
    }
})

// The deploy path: the drain times out on a multi-minute chat-flow, and the
// handoff is what gets a peer onto the turn within one sweep. It must cover
// external rows — handoffOwnedTurns is deliberately not runtime-filtered.
test('shutdown handoff covers external turns owned by this instance', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const mine = h.id('mine-external')
        const mineWithoutPendingRef = h.id('mine-external-plain')
        const newerSameOwner = h.id('newer-same-owner')
        const theirs = h.id('theirs-external')
        await insertTurn(h, mine, {
            runtime: 'external',
            ownerId: 'me',
            leaseMsFromNow: 60_000
        })
        await insertTurn(h, mineWithoutPendingRef, {
            runtime: 'external',
            ownerId: 'me',
            leaseMsFromNow: 60_000
        })
        await insertTurn(h, theirs, {
            runtime: 'external',
            ownerId: 'peer',
            leaseMsFromNow: 60_000
        })
        await insertTurn(h, newerSameOwner, {
            runtime: 'external',
            ownerId: 'me',
            generation: 2,
            leaseMsFromNow: 60_000
        })

        const handed = await h.repo.handoffOwnedTurns(
            [
                { messageId: mine, ownerId: 'me', generation: 1 },
                {
                    messageId: mineWithoutPendingRef,
                    ownerId: 'me',
                    generation: 1
                },
                {
                    messageId: newerSameOwner,
                    ownerId: 'me',
                    generation: 1
                }
            ],
            [{ messageId: mine, taskId: 'task-1' }]
        )

        assert.deepEqual(handed.sort(), [mine, mineWithoutPendingRef].sort())
        const row = await h.repo.getTurnExecution(mine)
        assert.equal(row?.state, 'handoff')
        assert.equal(row?.upstreamTaskId, 'task-1')
        assert.equal(
            (await h.repo.getTurnExecution(mineWithoutPendingRef))?.state,
            'handoff'
        )
        assert.equal(
            (await h.repo.getTurnExecution(newerSameOwner))?.state,
            'running',
            'a stale shutdown with the same owner id cannot hand off a newer generation'
        )
        // The grace keeps it un-adoptable until the dying relay is really gone,
        // so both instances can never emit the same (messageId, seq).
        assert.deepEqual(await adoptableIds(h), [])

        // ...and once it lapses, a peer must actually be able to pick it up.
        // This is the half that closes the deploy loop: a handoff nobody can
        // claim is the pre-#670 behaviour with extra steps.
        await h.db
            .update(turnExecutions)
            .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
            .where(
                inArray(turnExecutions.messageId, [mine, mineWithoutPendingRef])
            )
        assert.deepEqual(
            (await adoptableIds(h)).sort(),
            [mine, mineWithoutPendingRef].sort()
        )
    } finally {
        await h.close()
    }
})

// Two instances sweep the same lapsed turn at the same time. Exactly one may
// win, or the user sees the recovered answer twice.
test('only one instance can claim an external turn', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const contended = h.id('contended-external')
        await insertTurn(h, contended, {
            runtime: 'external',
            upstreamTaskId: 'task-1',
            upstreamMessageId: 'dify-msg-1'
        })

        const [first, second] = await Promise.all([
            h.repo.claimTurnForAdoption(contended, 'instance-a', 90),
            h.repo.claimTurnForAdoption(contended, 'instance-b', 90)
        ])

        const winners = [first, second].filter((r) => r !== null)
        assert.equal(winners.length, 1, 'exactly one CAS wins')
        assert.equal(winners[0]?.adoptCount, 1)
        assert.equal(winners[0]?.state, 'adopting')
        // The claim is the ONLY thing handed to the adoption handler, so the
        // refs have to ride on it — a winner that has to re-read the row would
        // be one more chance to lose the race.
        assert.equal(winners[0]?.runtime, 'external')
        assert.equal(winners[0]?.upstreamTaskId, 'task-1')
        assert.equal(winners[0]?.upstreamMessageId, 'dify-msg-1')
        assert.equal(
            await h.repo.claimTurnForAdoption(contended, 'instance-c', 90),
            null,
            'the fresh lease locks out a third claimant'
        )
    } finally {
        await h.close()
    }
})

test('upstream refs merge across writes instead of clobbering each other', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const turn = h.id('ref-merge')
        await insertTurn(h, turn, { runtime: 'external' })
        const execution = await h.repo.getTurnExecution(turn)
        assert.ok(execution)
        const fence = {
            messageId: turn,
            ownerId: execution.ownerId,
            generation: execution.generation
        }

        assert.deepEqual(
            await h.repo.setTurnUpstreamRef(
                turn,
                {
                    taskId: 'task-1',
                    upstreamMessageId: null
                },
                fence
            ),
            { written: true, fenceLost: false }
        )
        assert.deepEqual(
            await h.repo.setTurnUpstreamRef(
                turn,
                {
                    taskId: null,
                    upstreamMessageId: 'dify-msg-1'
                },
                fence
            ),
            { written: true, fenceLost: false }
        )
        // A no-op write must not touch either half — and has nothing to lose,
        // so it is durable by definition.
        assert.deepEqual(await h.repo.setTurnUpstreamRef(turn, {}, fence), {
            written: true,
            fenceLost: false
        })

        const row = await h.repo.getTurnExecution(turn)
        assert.equal(row?.upstreamTaskId, 'task-1')
        assert.equal(row?.upstreamMessageId, 'dify-msg-1')
    } finally {
        await h.close()
    }
})

// The write the relay awaits has to be able to say "nothing took this". An
// UPDATE matching no row still succeeds, and counting that as persisted is how
// a turn ends up with a recovery handle that exists only in this process's
// memory — the exact fiction #670's degradation path refuses to tell.
test('an upstream ref write reports failure when no execution row exists', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const missing = h.id('ref-missing')
        assert.deepEqual(
            await h.repo.setTurnUpstreamRef(
                missing,
                {
                    taskId: 'task-1',
                    upstreamMessageId: 'dify-msg-1'
                },
                { messageId: missing, ownerId: 'missing', generation: 1 }
            ),
            { written: false, fenceLost: true }
        )
    } finally {
        await h.close()
    }
})
