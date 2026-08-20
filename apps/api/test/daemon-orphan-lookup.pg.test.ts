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
    users,
    type Database
} from '@manyfold/db'
import { DaemonExecResumeService } from '../src/modules/daemon/daemon-exec-resume.service'
import type { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'

// A daemon's hello lists its entire exec buffer. Measured 2026-07-28: 20559
// entries on one staging daemon (exactly 1 was an unfinished turn), ~4800 in
// prod, climbing every day. Those refIds used to go into the orphan lookup as
// bind parameters, so every reconnect ran a multi-thousand-parameter query —
// and Postgres caps a statement at 65535 parameters, which that shape was
// heading for. The lookup now asks for the daemon's unfinished turns (bounded by
// real usage, and covered by the partial index on
// (daemon_id, daemon_exec_ref) WHERE daemon_exec_ref IS NOT NULL) and
// intersects locally.
//
// Real Postgres because the whole point is the SQL shape.
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test -- --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    service: DaemonExecResumeService
    sessionId: string
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
        // A hello arrives on a socket the registry has already registered, and
        // the unmatched branch now reconciles through the same live-state path
        // the scheduled recheck uses (#728), so it reads that registry.
        service: new DaemonExecResumeService(db, {
            isOnline: () => true,
            currentHelloEvidence: () => ({
                connectionToken: 'connection-1',
                helloOrder: 1
            }),
            isCurrentHelloEvidence: (
                _daemonId: string,
                evidence: {
                    connectionToken: string
                    helloOrder: number
                } | null
            ) =>
                evidence?.connectionToken === 'connection-1' &&
                evidence.helloOrder === 1,
            hasPendingRef: () => false
        } as unknown as DaemonRegistryService),
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

const insertMessage = async (
    h: Harness,
    id: string,
    daemonId: string | null,
    opts: { terminal?: boolean } = {}
): Promise<void> => {
    await h.db.insert(chatMessages).values({
        id,
        sessionId: h.sessionId,
        role: 'assistant',
        contentBlocksJson: [],
        ...(daemonId ? { daemonId, daemonExecRef: id } : {})
    })
    if (opts.terminal)
        await h.db.insert(chatStreamEvents).values({
            sessionId: h.sessionId,
            messageId: id,
            seq: 1,
            eventType: 'done',
            payloadJson: { type: 'done' }
        })
}

// Driven through the public entry (handleInflightStreams) with a capturing
// handler, so what is asserted is what a reconnect actually DOES: which turns
// get resumed, and — since 2026-07-29 — which get converged as unresumable
// because the daemon's authoritative stream list does not contain them.
const runHello = async (
    h: Harness,
    daemonId: string,
    refIds: string[]
): Promise<{ resumed: string[]; failed: string[] }> => {
    const resumed: string[] = []
    const failed: string[] = []
    h.service.registerHandler({
        resumeAssistantTurn: async ({ message }) => {
            resumed.push(message.id)
            return 'handled'
        },
        isRunningLocally: () => false,
        completeOfflineCancel: async () => {},
        failUnresumable: async ({ message }) => {
            failed.push(message.id)
        }
    })
    await h.service.handleInflightStreams(
        daemonId,
        refIds.map((refId) => ({
            refId,
            method: 'exec.start' as const,
            lastSeq: 0,
            status: 'running' as const
        })),
        { connectionToken: 'connection-1', helloOrder: 1 }
    )
    return { resumed, failed }
}

const backdate = async (h: Harness, messageId: string): Promise<void> => {
    await h.db
        .update(chatMessages)
        .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
        .where(eq(chatMessages.id, messageId))
}

test(
    'only the unfinished turn is matched, out of a huge advertised buffer',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh')
            const open = h.id('m_open')
            const finished = h.id('m_finished')
            await insertMessage(h, open, daemonId)
            await insertMessage(h, finished, daemonId, { terminal: true })

            // What a real daemon sends: its whole buffer. Well past the point
            // where these were bind parameters — 30k of them would have been a
            // 30k-parameter statement, on every reconnect.
            const advertised = [
                ...Array.from({ length: 30_000 }, (_, i) => `stale-${i}`),
                finished,
                open
            ]
            const { resumed, failed } = await runHello(h, daemonId, advertised)

            assert.deepEqual(
                resumed,
                [open],
                'the terminalized turn and 30k dead refs are all skipped'
            )
            assert.deepEqual(failed, [], 'an advertised turn is never failed')
        } finally {
            await h.close()
        }
    }
)

test(
    'an unadvertised turn is not resumed — and converges only past the age guard',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh2')
            const open = h.id('m_open2')
            await insertMessage(h, open, daemonId)
            // Fresh turn: could be a dispatch whose stream the daemon has not
            // created yet (stamp → push → stream is a real window). Neither
            // resumed nor killed.
            let out = await runHello(h, daemonId, ['something-else'])
            assert.deepEqual(out.resumed, [])
            assert.deepEqual(out.failed, [])
            // Past the guard the hello is proof: the daemon has NO stream for
            // this turn, so no resume will ever come, and adoption defers to an
            // online daemon forever — converging here is the only exit. Hit on
            // staging 2026-07-29: a turn.start push rejected by `connection
            // replaced` before the daemon received it hung exactly this way.
            await backdate(h, open)
            out = await runHello(h, daemonId, ['something-else'])
            assert.deepEqual(out.failed, [open])
            assert.deepEqual(out.resumed, [])
            // An EMPTY buffer (fresh reinstall) is the same proof.
            out = await runHello(h, daemonId, [])
            assert.deepEqual(out.failed, [open])
        } finally {
            await h.close()
        }
    }
)

test(
    "another daemon's unfinished turn is never touched",
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const mine = h.id('dh_mine')
            const other = h.id('dh_other')
            const myTurn = h.id('m_mine')
            const otherTurn = h.id('m_other')
            await insertMessage(h, myTurn, mine)
            await insertMessage(h, otherTurn, other)
            await backdate(h, otherTurn)
            const { resumed, failed } = await runHello(h, mine, [
                myTurn,
                otherTurn
            ])
            assert.deepEqual(resumed, [myTurn])
            assert.deepEqual(
                failed,
                [],
                "the other daemon's old turn is not this hello's to converge"
            )
        } finally {
            await h.close()
        }
    }
)
