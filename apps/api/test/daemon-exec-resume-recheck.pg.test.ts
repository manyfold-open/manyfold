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
    turnExecutions,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { DaemonExecResumeService } from '../src/modules/daemon/daemon-exec-resume.service'
import type { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'

// The cold-runner reconnect race (#512): a turn.start push rejected by
// `connection replaced` leaves an open turn stamped on a daemon whose hello
// does not list it. Under the 60s age gate the hello could not converge it,
// and nothing re-examined the ref until the NEXT hello — on staging that was
// the awake lease's 30m TTL away, so the turn hung ~31 minutes. These tests
// pin the recheck that now closes that gap: scheduled at hello time, it
// converges the turn shortly after the age gate passes UNLESS live state
// proves the dispatch actually reached the current socket.
//
// Real Postgres because findOpenTurns is real SQL.
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test -- --test-force-exit
const RUN = process.env.RUN_PG_E2E === '1'

class FastRecheckService extends DaemonExecResumeService {
    recheckDelayMs = 5
    protected recheckDelay(): number {
        return this.recheckDelayMs
    }
}

interface RegistryStub {
    online: boolean
    connectionToken: string
    helloOrder: number
    pendingRefs: Set<string>
}

interface Harness {
    db: Database
    repo: ChatRepository
    service: FastRecheckService
    registry: RegistryStub
    sessionId: string
    id: (name: string) => string
    timers: () => Map<string, unknown>
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

    const registry: RegistryStub = {
        online: true,
        connectionToken: 'connection-1',
        helloOrder: 1,
        pendingRefs: new Set()
    }
    const service = new FastRecheckService(db, {
        isOnline: () => registry.online,
        currentHelloEvidence: () => ({
            connectionToken: registry.connectionToken,
            helloOrder: registry.helloOrder
        }),
        isCurrentHelloEvidence: (
            _daemonId: string,
            evidence: { connectionToken: string; helloOrder: number } | null
        ) =>
            evidence?.connectionToken === registry.connectionToken &&
            evidence.helloOrder === registry.helloOrder,
        hasPendingRef: (_daemonId: string, refId: string) =>
            registry.pendingRefs.has(refId)
    } as unknown as DaemonRegistryService)

    return {
        db,
        repo: new ChatRepository(db),
        service,
        registry,
        sessionId,
        id: (name: string) => `${name}_${suffix}`,
        timers: () =>
            (service as unknown as { recheckTimers: Map<string, unknown> })
                .recheckTimers,
        close: async (): Promise<void> => {
            service.onModuleDestroy()
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
    daemonId: string,
    opts: { ageMs?: number } = {}
) => {
    await h.db.insert(chatMessages).values({
        id,
        sessionId: h.sessionId,
        role: 'assistant',
        contentBlocksJson: [],
        daemonId,
        daemonExecRef: id,
        ...(opts.ageMs !== undefined
            ? { createdAt: new Date(Date.now() - opts.ageMs) }
            : {})
    })
}

const insertExec = async (
    h: Harness,
    messageId: string,
    opts: {
        state: 'running' | 'handoff' | 'adopting' | 'done' | 'failed'
        leaseMs: number
        runtime?: 'sprites' | 'daemon'
    }
) => {
    await h.db.insert(turnExecutions).values({
        messageId,
        sessionId: h.sessionId,
        agentId: h.id('agt'),
        runtime: opts.runtime ?? 'sprites',
        ownerId: 'other-instance',
        leaseExpiresAt: new Date(Date.now() + opts.leaseMs),
        state: opts.state
    })
}

const insertRunnerFrame = async (h: Harness, messageId: string) => {
    await h.db.insert(chatStreamEvents).values({
        sessionId: h.sessionId,
        messageId,
        seq: 1,
        eventType: 'token',
        payloadJson: { type: 'token', text: 'partial' },
        runnerSeq: 5
    })
}

const terminalize = async (h: Harness, messageId: string): Promise<void> => {
    await h.db.insert(chatStreamEvents).values({
        sessionId: h.sessionId,
        messageId,
        seq: 1,
        eventType: 'done',
        payloadJson: { type: 'done' }
    })
}

interface Captured {
    resumed: string[]
    failed: string[]
    runningLocally: Set<string>
    ownedElsewhere: Set<string>
    waitForFailed: (count?: number) => Promise<void>
    waitForResumed: (count?: number) => Promise<void>
}

const captureHandler = (
    h: Harness,
    opts: {
        onResumeStart?: (messageId: string) => void
        onResume?: (messageId: string) => Promise<void>
        claimOwnerId?: string
    } = {}
): Captured => {
    const failedWaiters: Array<{
        count: number
        resolve: () => void
    }> = []
    const resumedWaiters: Array<{
        count: number
        resolve: () => void
    }> = []
    const resolveWaiters = (
        waiters: Array<{ count: number; resolve: () => void }>,
        count: number
    ): void => {
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
            if (count < waiters[index].count) continue
            waiters[index].resolve()
            waiters.splice(index, 1)
        }
    }
    const waitForCount = (
        values: string[],
        waiters: Array<{ count: number; resolve: () => void }>,
        count: number
    ): Promise<void> => {
        if (values.length >= count) return Promise.resolve()
        return new Promise((resolve) => waiters.push({ count, resolve }))
    }
    const captured: Captured = {
        resumed: [],
        failed: [],
        runningLocally: new Set(),
        ownedElsewhere: new Set(),
        waitForFailed: (count = 1) =>
            waitForCount(captured.failed, failedWaiters, count),
        waitForResumed: (count = 1) =>
            waitForCount(captured.resumed, resumedWaiters, count)
    }
    h.service.registerHandler({
        resumeAssistantTurn: async ({ message, daemonId, refId }) => {
            // What ChatService does when another execution in this process
            // already holds the turn: decline instead of double-consuming the
            // stream (the #624 fence owns the slot for up to 15s).
            if (captured.runningLocally.has(message.id))
                return 'skipped_running_locally'
            // And what claimTurnForResume answers when the durable claim is
            // held by a live carrier on another replica.
            if (captured.ownedElsewhere.has(message.id))
                return 'skipped_owned_elsewhere'
            if (opts.claimOwnerId) {
                const ownership = await h.repo.claimTurnForResume({
                    messageId: message.id,
                    sessionId: message.sessionId,
                    daemonId,
                    daemonExecRef: refId,
                    ownerId: opts.claimOwnerId,
                    leaseSeconds: 90
                })
                if (ownership.outcome === 'busy')
                    return 'skipped_owned_elsewhere'
                if (ownership.outcome !== 'claimed') return 'handled'
            }
            opts.onResumeStart?.(message.id)
            captured.resumed.push(message.id)
            resolveWaiters(resumedWaiters, captured.resumed.length)
            if (opts.onResume) await opts.onResume(message.id)
            return 'handled'
        },
        isRunningLocally: (messageId) => captured.runningLocally.has(messageId),
        completeOfflineCancel: async () => {},
        failUnresumable: async ({ message }) => {
            captured.failed.push(message.id)
            resolveWaiters(failedWaiters, captured.failed.length)
        }
    })
    return captured
}

const hello = (
    h: Harness,
    daemonId: string,
    refIds: string[]
): Promise<void> => {
    const evidence = {
        connectionToken: h.registry.connectionToken,
        helloOrder: ++h.registry.helloOrder
    }
    return h.service.handleInflightStreams(
        daemonId,
        refIds.map((refId) => ({
            refId,
            method: 'turn.start' as const,
            lastSeq: 0,
            status: 'running' as const
        })),
        evidence
    )
}

test(
    'a young unmatched ref converges via the scheduled recheck, not the next hello',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_race')
            const turn = h.id('m_race')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            await hello(h, daemonId, ['unrelated-buffer-entry'])
            assert.deepEqual(
                captured.failed,
                [],
                'inside the age gate the hello alone must not converge'
            )
            assert.equal(h.timers().size, 1, 'a recheck is scheduled')

            await captured.waitForFailed()
            assert.deepEqual(
                captured.failed,
                [turn],
                'the recheck converges the turn without another reconnect'
            )
            assert.deepEqual(captured.resumed, [])
            assert.equal(h.timers().size, 0)
        } finally {
            await h.close()
        }
    }
)

test(
    'a second hello inside the gate does not stack rechecks',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_dedupe')
            const turn = h.id('m_dedupe')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            // Long enough that no timer can fire between the two hellos —
            // what is under test is the scheduling, not the convergence.
            h.service.recheckDelayMs = 60_000
            await hello(h, daemonId, [])
            await hello(h, daemonId, [])
            assert.equal(h.timers().size, 1)
            assert.deepEqual(captured.failed, [])
        } finally {
            await h.close()
        }
    }
)

test(
    'a matched ref whose resume is skipped locally still gets a recheck',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_skipped')
            const turn = h.id('m_skipped')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            // #648: the hello lands while the #624 fence still holds the
            // turn's runningAdapters entry, so the matched resume declines.
            // The fence can then decline its probe and suspend WITHOUT
            // settling the turn, and the matched branch used to leave nothing
            // scheduled behind it — the turn hung until the next reconnect.
            // The firing itself is pinned against mock timers in
            // daemon-resume-skipped-recheck.test.ts; here the delay only has
            // to be long enough that no timer fires mid-assertion.
            h.service.recheckDelayMs = 60_000
            captured.runningLocally.add(turn)
            await hello(h, daemonId, [turn])

            assert.deepEqual(captured.resumed, [], 'the resume declined')
            assert.equal(h.timers().size, 1, 'a recheck covers the ref')

            // The fence's probe proved nothing, so it surfaced the transport
            // error and suspended — releasing the turn without settling it.
            captured.runningLocally.delete(turn)
            await h.service.recheckUnmatchedTurn(daemonId, turn)

            assert.deepEqual(
                captured.failed,
                [turn],
                'and the recheck converges it without another reconnect'
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a skipped resume still executing locally at recheck time defers, not converges',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_carrier')
            const turn = h.id('m_carrier')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            // The other end of the same fence: its probe FOUND the stream and
            // is replaying it as the carrier, so the local execution outlives
            // the hello. This turn was dispatched before #570 stamped daemon
            // rows, which leaves in-process liveness the only thing between the
            // recheck and a terminal written over a live stream.
            h.service.recheckDelayMs = 60_000
            captured.runningLocally.add(turn)
            await h.service.recheckUnmatchedTurn(daemonId, turn)

            assert.deepEqual(captured.failed, [], 'the carrier still owns it')
            assert.equal(h.timers().size, 1, 'and the ref stays covered')
        } finally {
            await h.close()
        }
    }
)

// #728: past the age gate the hello converged the turn inline, on the durable
// verdict alone. Against real Postgres that verdict is the point: this turn was
// dispatched before #570 stamped daemon rows, so the SELECT genuinely returns
// zero rows and `converge` is the honest durable answer — which is exactly why
// in-process liveness has to outrank it. The develop @ 223c5f54 witness came
// back `failed=['msg-review']` for this shape with isRunningLocally=true.
test(
    'an aged unmatched hello with no turn_executions row is still vetoed by the local carrier',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_live')
            const turn = h.id('m_live')
            await insertMessage(h, turn, daemonId, { ageMs: 2 * 60_000 })
            const captured = captureHandler(h)

            const execRows = await h.db
                .select()
                .from(turnExecutions)
                .where(eq(turnExecutions.messageId, turn))
            assert.equal(
                execRows.length,
                0,
                'this turn predates the stamp, so there is no durable lease to veto with'
            )

            h.service.recheckDelayMs = 60_000
            captured.runningLocally.add(turn)
            await hello(h, daemonId, ['some-other-buffer-entry'])

            assert.deepEqual(
                captured.failed,
                [],
                'the hello must not write server_restart over a stream this process is consuming'
            )
            assert.equal(
                h.timers().size,
                1,
                'and the ref stays under exactly one bounded recheck'
            )

            // Still live at recheck time: it keeps deferring, one timer.
            await h.service.recheckUnmatchedTurn(daemonId, turn)
            assert.deepEqual(captured.failed, [])
            assert.equal(h.timers().size, 1)

            // The local execution ends without settling the turn — only now is
            // the durable `converge` the whole truth.
            captured.runningLocally.delete(turn)
            await h.service.recheckUnmatchedTurn(daemonId, turn)

            assert.deepEqual(
                captured.failed,
                [turn],
                'the next recheck converges it once the carrier is gone'
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a pending rpc keyed by the exec ref is a dispatch receipt: recheck leaves the turn alone',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_pending')
            const turn = h.id('m_pending')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            // The dispatch landed on the current socket just after the hello
            // was enumerated: streamRpcLocal registered pending[refId] before
            // sending the frame, so the receipt is visible by recheck time.
            h.registry.pendingRefs.add(turn)
            await h.service.recheckUnmatchedTurn(daemonId, turn)

            assert.deepEqual(captured.failed, [])
            assert.deepEqual(captured.resumed, [])
        } finally {
            await h.close()
        }
    }
)

test(
    'recheck defers when the daemon connection is gone or moved',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_moved')
            const turn = h.id('m_moved')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            // Offline → adoption no longer defers to the daemon; moved to
            // another instance → that instance's hello re-arbitrates. Either
            // way this instance must not converge on stale evidence.
            h.registry.online = false
            await h.service.recheckUnmatchedTurn(daemonId, turn)

            assert.deepEqual(captured.failed, [])
        } finally {
            await h.close()
        }
    }
)

test(
    'recheck is a no-op once the turn has terminalized',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_done')
            const turn = h.id('m_done')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            await terminalize(h, turn)
            await h.service.recheckUnmatchedTurn(daemonId, turn)

            assert.deepEqual(captured.failed, [])
        } finally {
            await h.close()
        }
    }
)

test(
    'a matched hello clears the scheduled recheck and resumes exactly once',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_match')
            const turn = h.id('m_match')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            await hello(h, daemonId, [])
            assert.equal(h.timers().size, 1)

            await hello(h, daemonId, [turn])
            assert.deepEqual(captured.resumed, [turn])
            assert.equal(
                h.timers().size,
                0,
                'the matched hello superseded the recheck'
            )
            assert.deepEqual(captured.failed, [])
        } finally {
            await h.close()
        }
    }
)

// #518: a rolling deploy's hello (fresh socket, empty stream list because the
// runner buffer aged past the CLI's 5min hello grace) converged a turn whose
// owner instance held a LIVE turn_executions lease and was still inserting
// events — the turn had actually completed on the runner. These tests pin the
// durable-record veto: negative evidence from one socket must not outrank the
// cross-instance arbiter the adoption system already trusts.

test(
    'a live lease vetoes hello convergence and schedules a recheck instead',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_lease')
            const turn = h.id('m_lease')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, { state: 'running', leaseMs: 60_000 })
            const captured = captureHandler(h)

            h.service.recheckDelayMs = 60_000
            await hello(h, daemonId, [])

            assert.deepEqual(
                captured.failed,
                [],
                'a turn with a live lease is still owned; the hello must not kill it'
            )
            assert.equal(h.timers().size, 1, 'a recheck is scheduled')
        } finally {
            await h.close()
        }
    }
)

test('a live lease vetoes the recheck path too', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const daemonId = h.id('dh_lease2')
        const turn = h.id('m_lease2')
        await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
        await insertExec(h, turn, { state: 'running', leaseMs: 60_000 })
        const captured = captureHandler(h)

        h.service.recheckDelayMs = 60_000
        await h.service.recheckUnmatchedTurn(daemonId, turn)

        assert.deepEqual(captured.failed, [])
        assert.equal(h.timers().size, 1)
    } finally {
        await h.close()
    }
})

test(
    'handoff with a lapsed lease defers to adoption instead of terminalizing',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_handoff')
            const turn = h.id('m_handoff')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, { state: 'handoff', leaseMs: -10_000 })
            const captured = captureHandler(h)

            h.service.recheckDelayMs = 60_000
            await hello(h, daemonId, [])

            assert.deepEqual(
                captured.failed,
                [],
                'a handed-off turn belongs to the adoption sweep'
            )
            assert.equal(h.timers().size, 1)
        } finally {
            await h.close()
        }
    }
)

test(
    'delivered runner frames defer convergence: the dispatch provably reached the daemon',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_frames')
            const turn = h.id('m_frames')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, { state: 'running', leaseMs: -10_000 })
            await insertRunnerFrame(h, turn)
            const captured = captureHandler(h)

            h.service.recheckDelayMs = 60_000
            await hello(h, daemonId, [])

            assert.deepEqual(
                captured.failed,
                [],
                'a turn that streamed runner frames has recoverable content'
            )
            assert.equal(h.timers().size, 1)
        } finally {
            await h.close()
        }
    }
)

test(
    'the #512 shape still converges: lapsed lease, nothing ever streamed',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_512')
            const turn = h.id('m_512')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, { state: 'running', leaseMs: -10_000 })
            const captured = captureHandler(h)

            await hello(h, daemonId, [])

            assert.deepEqual(
                captured.failed,
                [turn],
                'a dead-owner turn that never streamed converges as before'
            )
        } finally {
            await h.close()
        }
    }
)

// #570 gives a daemon-carried turn a durable row so a matched resume can fence
// the carrier it displaces. The row's lease is the only part of it this verdict
// may read: a daemon row is never adoptable, so the deferrals a lapsed sprite
// lease earns would strand it behind a sweep that is not looking.
test(
    'a live daemon lease vetoes convergence the same way a sprite lease does',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_dlive')
            const turn = h.id('m_dlive')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, {
                state: 'running',
                leaseMs: 60_000,
                runtime: 'daemon'
            })
            const captured = captureHandler(h)

            h.service.recheckDelayMs = 60_000
            await hello(h, daemonId, [])

            assert.deepEqual(
                captured.failed,
                [],
                'another replica renewed this lease seconds ago; it owns the turn'
            )
            assert.equal(h.timers().size, 1, 'a recheck is scheduled')
        } finally {
            await h.close()
        }
    }
)

test(
    'a lapsed daemon lease converges even with runner frames delivered',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_dlapsed')
            const turn = h.id('m_dlapsed')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, {
                state: 'running',
                leaseMs: -10_000,
                runtime: 'daemon'
            })
            await insertRunnerFrame(h, turn)
            const captured = captureHandler(h)

            await hello(h, daemonId, [])

            assert.deepEqual(
                captured.failed,
                [turn],
                'no sweep will ever adopt this row, so the frames buy it nothing'
            )
        } finally {
            await h.close()
        }
    }
)

// #570 SIGINT overlap, staging 2026-08-14: the dying replica handed generation
// 1 off with a drain grace and the daemon's socket reconnected to a peer inside
// it, so the peer's matched hello could not claim. The ref was then handed to
// the unmatched recheck, whose verdict for a daemon row is the lease alone —
// as soon as the grace lapsed it claimed generation 2 and wrote `server_restart`
// over a stream the old machine was still serving. This runs the coordinator
// through ChatRepository's real busy claim and generation bump, not a modeled
// handler outcome, because that durable transition is the staging shape.
test(
    'a matched resume blocked by a live handoff lease keeps the ref, not a terminal',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_overlap')
            const turn = h.id('m_overlap')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, {
                state: 'handoff',
                leaseMs: 15_000,
                runtime: 'daemon'
            })
            await h.db
                .update(chatSessions)
                .set({ inflightMessageId: turn })
                .where(eq(chatSessions.id, h.sessionId))
            const captured = captureHandler(h, {
                claimOwnerId: 'resume-instance'
            })

            h.service.recheckDelayMs = 20
            await hello(h, daemonId, [turn])

            assert.deepEqual(
                captured.resumed,
                [],
                'the claim correctly lost to the live drain grace'
            )
            assert.equal(h.timers().size, 1, 'and the ref stays covered')
            const [busyRow] = await h.db
                .select({
                    generation: turnExecutions.generation,
                    ownerId: turnExecutions.ownerId
                })
                .from(turnExecutions)
                .where(eq(turnExecutions.messageId, turn))
            assert.deepEqual(busyRow, {
                generation: 1,
                ownerId: 'other-instance'
            })

            // The old machine exits and its grace lapses: the claim would win
            // now — and a lapsed daemon lease is exactly the shape the
            // unmatched verdict converges on.
            await h.db
                .update(turnExecutions)
                .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
                .where(eq(turnExecutions.messageId, turn))

            await Promise.race([
                captured.waitForResumed(),
                captured.waitForFailed()
            ])
            assert.deepEqual(
                captured.failed,
                [],
                'server_restart must not land on a ref the hello matched'
            )
            assert.deepEqual(
                captured.resumed,
                [turn],
                'the retry replays it once the grace lapses'
            )
            const [claimedRow] = await h.db
                .select({
                    generation: turnExecutions.generation,
                    ownerId: turnExecutions.ownerId,
                    state: turnExecutions.state
                })
                .from(turnExecutions)
                .where(eq(turnExecutions.messageId, turn))
            assert.deepEqual(claimedRow, {
                generation: 2,
                ownerId: 'resume-instance',
                state: 'running'
            })
        } finally {
            await h.close()
        }
    }
)

test(
    'a hello that stops listing a blocked ref converges it instead of replaying it',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_omit')
            const turn = h.id('m_omit')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, {
                state: 'handoff',
                leaseMs: 15_000,
                runtime: 'daemon'
            })
            const captured = captureHandler(h)
            captured.ownedElsewhere.add(turn)

            h.service.recheckDelayMs = 60_000
            await hello(h, daemonId, [turn])
            assert.equal(h.timers().size, 1)

            // The daemon reconnects and its authoritative buffer no longer
            // lists the ref. The claim would succeed now; the stale match must
            // not be replayed anyway.
            await h.db
                .update(turnExecutions)
                .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
                .where(eq(turnExecutions.messageId, turn))
            captured.ownedElsewhere.delete(turn)
            await hello(h, daemonId, [])

            assert.deepEqual(
                captured.resumed,
                [],
                'a ref the newest hello omits cannot be resumed from the older one'
            )
            assert.deepEqual(captured.failed, [turn])
        } finally {
            await h.close()
        }
    }
)

test(
    'the give-up backstop converges a stale deferral no matter the exec state',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_giveup')
            const turn = h.id('m_giveup')
            await insertMessage(h, turn, daemonId, { ageMs: 50 * 60_000 })
            await insertExec(h, turn, {
                state: 'handoff',
                leaseMs: -40 * 60_000
            })
            await insertRunnerFrame(h, turn)
            const captured = captureHandler(h)

            await hello(h, daemonId, [])

            assert.deepEqual(
                captured.failed,
                [turn],
                'past the backstop nothing else is coming; converge'
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a terminal-state exec row does not veto convergence',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_term')
            const turn = h.id('m_term')
            await insertMessage(h, turn, daemonId, { ageMs: 7 * 60_000 })
            await insertExec(h, turn, { state: 'failed', leaseMs: 60_000 })
            const captured = captureHandler(h)

            await hello(h, daemonId, [])

            assert.deepEqual(captured.failed, [turn])
        } finally {
            await h.close()
        }
    }
)

// #570: one hello can match SEVERAL open turns, and each resume promise lives
// until its remote stream terminalizes or suspends again — minutes, not
// milliseconds. Awaiting them in sequence head-of-line-blocked every later ref
// behind the earlier ones: on staging 2026-08-05 the second of two matched
// turns waited 87s behind the first, the socket pong-timed out during the
// wait, and the attach then failed into a terminal `codex_exec_failed` over a
// turn that had streamed to exact runner cursor 56. These pin the concurrent
// launch and the per-message single-flight that makes it safe.

test(
    'a hello matching two refs starts both resumes without waiting for the first to settle',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_hol')
            const turnA = h.id('m_hol_a')
            const turnB = h.id('m_hol_b')
            await insertMessage(h, turnA, daemonId)
            await insertMessage(h, turnB, daemonId)

            let releaseFirst: () => void = () => {}
            const firstGate = new Promise<void>((resolve) => {
                releaseFirst = resolve
            })
            let secondStarted: () => void = () => {}
            const atSecond = new Promise<void>((resolve) => {
                secondStarted = resolve
            })
            const captured = captureHandler(h, {
                // Only the first-listed turn blocks — the exact staging shape,
                // where a long-lived peer resume held the loop.
                onResume: (messageId) => {
                    if (messageId === turnB) secondStarted()
                    return messageId === turnA ? firstGate : Promise.resolve()
                }
            })

            const helloDone = hello(h, daemonId, [turnA, turnB])
            await atSecond
            assert.deepEqual(
                [...captured.resumed].sort(),
                [turnA, turnB].sort(),
                'the second resume must attach while the first is still pending'
            )

            releaseFirst()
            await helloDone
            assert.deepEqual(captured.failed, [])
        } finally {
            await h.close()
        }
    }
)

test(
    'a repeated hello does not double-consume a resume already in flight',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_dup')
            const turn = h.id('m_dup')
            await insertMessage(h, turn, daemonId)

            let release: () => void = () => {}
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            let resumeStarted: () => void = () => {}
            const atResume = new Promise<void>((resolve) => {
                resumeStarted = resolve
            })
            const captured = captureHandler(h, {
                onResumeStart: resumeStarted,
                onResume: () => gate
            })

            // A flaky daemon re-hellos while the first resume is mid-stream;
            // a second consumer of the same stream would duplicate events and
            // can race two terminals onto one turn.
            const firstHello = hello(h, daemonId, [turn])
            await atResume
            const secondHello = hello(h, daemonId, [turn])
            await secondHello
            assert.deepEqual(captured.resumed, [turn])

            release()
            await firstHello
            assert.deepEqual(captured.resumed, [turn])
            assert.deepEqual(captured.failed, [])
        } finally {
            await h.close()
        }
    }
)

test(
    'a duplicate ref inside one hello resumes exactly once',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_dupref')
            const turn = h.id('m_dupref')
            await insertMessage(h, turn, daemonId)
            const captured = captureHandler(h)

            await hello(h, daemonId, [turn, turn])

            assert.deepEqual(captured.resumed, [turn])
        } finally {
            await h.close()
        }
    }
)

test(
    'a suspended turn is still findable: the next hello resumes it',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_susp')
            const turn = h.id('m_susp')
            await insertMessage(h, turn, daemonId)
            // The attach-time offline path now writes `suspended` instead of a
            // terminal (#570); this pins the property that fix depends on —
            // only `done`/`error` exclude a turn from open-turn lookup, so a
            // suspended turn survives to the next hello.
            await h.db.insert(chatStreamEvents).values({
                sessionId: h.sessionId,
                messageId: turn,
                seq: 1,
                eventType: 'suspended',
                payloadJson: { type: 'suspended', reason: 'pong timeout' }
            })
            const captured = captureHandler(h)

            await hello(h, daemonId, [turn])

            assert.deepEqual(captured.resumed, [turn])
            assert.deepEqual(captured.failed, [])
        } finally {
            await h.close()
        }
    }
)

test(
    'a recheck firing mid-resume does not converge the turn under it',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const daemonId = h.id('dh_midres')
            const turn = h.id('m_midres')
            await insertMessage(h, turn, daemonId)

            let releaseResume: () => void = () => {}
            const gate = new Promise<void>((resolve) => {
                releaseResume = resolve
            })
            let resumeStarted: () => void = () => {}
            const atResume = new Promise<void>((resolve) => {
                resumeStarted = resolve
            })
            const captured = captureHandler(h, {
                onResumeStart: resumeStarted,
                onResume: () => gate
            })

            // The resume rpc runs under a fresh refId, so the dispatch-receipt
            // check cannot see it; the in-flight guard has to.
            const helloDone = hello(h, daemonId, [turn])
            await atResume
            await h.service.recheckUnmatchedTurn(daemonId, turn)
            assert.deepEqual(captured.failed, [])

            releaseResume()
            await helloDone
            assert.deepEqual(captured.resumed, [turn])
        } finally {
            await h.close()
        }
    }
)
