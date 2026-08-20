import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { eq, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    agentUsageEvents,
    chatMessages,
    chatMessageSources,
    chatSessions,
    chatStreamEvents,
    createDb,
    turnExecutions,
    users,
    type Database
} from '@manyfold/db'
import {
    ChatRepository,
    type ResumeTurnClaim
} from '../src/modules/chat/chat.repository'
import { buildChatMessageSourceRow } from '../src/modules/chat/raw-message-source'
import {
    TurnFenceLostError,
    type TurnExecutionFence
} from '../src/modules/chat/turn-fence'
import { UsageRepository } from '../src/modules/usage/usage.repository'

const RUN = process.env.RUN_PG_E2E === '1'
const ONE_OWNER = 'replica-a'
const WRITE_KINDS = [
    'event',
    'terminal',
    'content',
    'source',
    'framework_ref',
    'exec_ref',
    'upstream_ref',
    'usage'
] as const

type WriteKind = (typeof WRITE_KINDS)[number]

interface Harness {
    db: Database
    repo: ChatRepository
    userId: string
    runtimeId: string
    sessionId: string
    agentId: string
    messageId: string
    close: () => Promise<void>
}

interface Connection {
    db: Database
    repo: ChatRepository
    pid: number
    close: () => Promise<void>
}

const dbUrl = (): string => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    return url
}

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

const buildHarness = async (): Promise<Harness> => {
    const db = createDb(dbUrl())
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_fence_${suffix}`
    const runtimeId = `art_fence_${suffix}`
    const agentId = `agt_fence_${suffix}`
    const sessionId = `cts_fence_${suffix}`
    const messageId = `msg_fence_${suffix}`

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@fencetest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `fence-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'daemon'
    })
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'fence-agent',
        framework: 'claude-code',
        runtime: 'daemon',
        runtimeId,
        internalId: `internal-${agentId}`
    })
    await db.insert(chatSessions).values({
        id: sessionId,
        userId,
        agentId,
        frameworkSessionRef: `framework-${suffix}`,
        inflightMessageId: messageId
    })
    await db.insert(chatMessages).values({
        id: messageId,
        sessionId,
        role: 'assistant',
        contentBlocksJson: [],
        daemonId: `daemon-${suffix}`,
        daemonExecRef: messageId
    })

    return {
        db,
        repo: new ChatRepository(db),
        userId,
        runtimeId,
        sessionId,
        agentId,
        messageId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            await closeDb(db)
        }
    }
}

const connect = async (name: string): Promise<Connection> => {
    const db = createDb(dbUrl(), { max: 1, applicationName: name })
    const rows = (await db.execute(
        sql`select pg_backend_pid() as pid`
    )) as unknown as Array<{ pid: number }>
    return {
        db,
        repo: new ChatRepository(db),
        pid: Number(rows[0]!.pid),
        close: () => closeDb(db)
    }
}

const stamp = async (
    h: Harness,
    ownerId = ONE_OWNER
): Promise<TurnExecutionFence> => {
    const fence = await h.repo.upsertTurnExecution({
        messageId: h.messageId,
        sessionId: h.sessionId,
        agentId: h.agentId,
        runtime: 'daemon',
        spriteName: null,
        ownerId,
        leaseSeconds: 90
    })
    assert.ok(fence)
    return fence
}

const expire = async (h: Harness): Promise<void> => {
    await h.db
        .update(turnExecutions)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(turnExecutions.messageId, h.messageId))
}

const claimInput = (h: Harness, ownerId: string) => ({
    messageId: h.messageId,
    sessionId: h.sessionId,
    daemonId: null as string | null,
    daemonExecRef: h.messageId,
    ownerId,
    leaseSeconds: 90
})

const liveClaimInput = async (h: Harness, ownerId: string) => {
    const [message] = await h.db
        .select({ daemonId: chatMessages.daemonId })
        .from(chatMessages)
        .where(eq(chatMessages.id, h.messageId))
    assert.ok(message?.daemonId)
    return { ...claimInput(h, ownerId), daemonId: message.daemonId }
}

const sourceRow = (h: Harness, line: string, sourceSeq = 1) =>
    buildChatMessageSourceRow({
        sourceKind: 'live_stream',
        sessionId: h.sessionId,
        messageId: h.messageId,
        framework: 'claude-code',
        runtime: 'daemon',
        source: {
            sourceSeq,
            rawFormat: 'jsonl',
            rawJson: { line },
            parserName: 'fence-test',
            parserVersion: '1'
        },
        runnerSeq: sourceSeq
    })

const writeWithFence = (
    repo: ChatRepository,
    h: Harness,
    kind: WriteKind,
    fence: TurnExecutionFence
): Promise<unknown> => {
    if (kind === 'event')
        return repo.insertStreamEvent(
            {
                sessionId: h.sessionId,
                messageId: h.messageId,
                seq: 1,
                eventType: 'token',
                payloadJson: { type: 'token', text: 'old event' }
            },
            undefined,
            fence
        )
    if (kind === 'terminal')
        return repo.insertStreamEvent(
            {
                sessionId: h.sessionId,
                messageId: h.messageId,
                seq: 1,
                eventType: 'done',
                payloadJson: { type: 'done' }
            },
            {
                contentBlocksJson: [{ type: 'text', text: 'old terminal' }],
                contentCheckpointEventId: null
            },
            fence
        )
    if (kind === 'content')
        return repo.writeAssistantContent(
            h.messageId,
            [{ type: 'text', text: 'old checkpoint' }],
            null,
            fence
        )
    if (kind === 'framework_ref')
        return repo
            .updateFrameworkSessionRef(h.sessionId, 'old-framework-ref', fence)
            .then(
                () => ({ fenceLost: false }),
                (err: unknown) => {
                    if (err instanceof TurnFenceLostError)
                        return { fenceLost: true }
                    throw err
                }
            )
    if (kind === 'exec_ref')
        return repo
            .setTurnExecSession(h.messageId, 'old-sprite', 'old-exec', fence)
            .then((written) => ({ fenceLost: !written }))
    if (kind === 'upstream_ref')
        return repo.setTurnUpstreamRef(
            h.messageId,
            { taskId: 'old-task' },
            fence
        )
    if (kind === 'usage')
        return new UsageRepository((repo as unknown as { db: Database }).db)
            .insert(
                {
                    id: `usage-${h.messageId}`,
                    userId: h.userId,
                    agentId: h.agentId,
                    runtimeId: h.runtimeId,
                    sessionId: h.sessionId,
                    messageId: h.messageId,
                    framework: 'claude-code',
                    runtimeKind: 'daemon',
                    inputTokens: 1,
                    outputTokens: 2,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    costUsd: null,
                    costSource: 'upstream',
                    isFallbackModel: false,
                    firstTokenMs: null,
                    totalMs: null,
                    modelProviderId: null,
                    createdAt: new Date()
                },
                fence
            )
            .then((written) => ({ fenceLost: !written }))
    return repo.upsertMessageSources([sourceRow(h, 'old source')], fence)
}

const heldTransaction = async <T>(
    connection: Connection,
    operation: (repo: ChatRepository) => Promise<T>
): Promise<{
    ready: Promise<T>
    release: () => void
    done: Promise<T>
}> => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
        release = resolve
    })
    let resolveReady!: (value: T) => void
    let rejectReady!: (reason: unknown) => void
    const ready = new Promise<T>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
    })
    const done = connection.db
        .transaction(async (tx) => {
            const result = await operation(
                new ChatRepository(tx as unknown as Database)
            )
            resolveReady(result)
            await released
            return result
        })
        .catch((err) => {
            rejectReady(err)
            throw err
        })
    return { ready, release, done }
}

const waitUntilLocked = async (
    observer: Database,
    connection: Connection
): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        const rows = (await observer.execute(sql`
            select wait_event_type
            from pg_stat_activity
            where pid = ${connection.pid}
        `)) as unknown as Array<{ wait_event_type: string | null }>
        if (rows[0]?.wait_event_type === 'Lock') return
        await sleep(10)
    }
    throw new Error(`backend ${connection.pid} did not reach a lock wait`)
}

const readEffects = async (h: Harness) => {
    const events = await h.db
        .select({ type: chatStreamEvents.eventType })
        .from(chatStreamEvents)
        .where(eq(chatStreamEvents.messageId, h.messageId))
    const sources = await h.db
        .select({ seq: chatMessageSources.sourceSeq })
        .from(chatMessageSources)
        .where(eq(chatMessageSources.messageId, h.messageId))
    const [message] = await h.db
        .select({ content: chatMessages.contentBlocksJson })
        .from(chatMessages)
        .where(eq(chatMessages.id, h.messageId))
    const [session] = await h.db
        .select({
            inflight: chatSessions.inflightMessageId,
            frameworkSessionRef: chatSessions.frameworkSessionRef
        })
        .from(chatSessions)
        .where(eq(chatSessions.id, h.sessionId))
    const [execution] = await h.db
        .select()
        .from(turnExecutions)
        .where(eq(turnExecutions.messageId, h.messageId))
    const usage = await h.db
        .select({ inputTokens: agentUsageEvents.inputTokens })
        .from(agentUsageEvents)
        .where(eq(agentUsageEvents.messageId, h.messageId))
    return { events, sources, message, session, execution, usage }
}

test(
    'takeover-first rejects every stale durable write after a real lock wait',
    { skip: !RUN },
    async () => {
        for (const kind of WRITE_KINDS) {
            const h = await buildHarness()
            const claimant = await connect(`fence-claim-${kind}`)
            const writer = await connect(`fence-stale-${kind}`)
            let releaseHeld: (() => void) | null = null
            let heldDone: Promise<unknown> | null = null
            try {
                const stale = await stamp(h)
                await expire(h)
                const input = await liveClaimInput(h, ONE_OWNER)
                const held = await heldTransaction(claimant, (repo) =>
                    repo.claimTurnForResume(input)
                )
                releaseHeld = held.release
                heldDone = held.done
                const claim = await held.ready
                assert.equal(claim.outcome, 'claimed')

                let settled = false
                const staleWrite = writeWithFence(
                    writer.repo,
                    h,
                    kind,
                    stale
                ).then((result) => {
                    settled = true
                    return result
                })
                await waitUntilLocked(h.db, writer)
                assert.equal(settled, false)

                held.release()
                await held.done
                const result = await staleWrite
                assert.equal(
                    (result as { fenceLost: boolean }).fenceLost,
                    true,
                    `${kind} must re-evaluate generation after the lock wait`
                )

                const effects = await readEffects(h)
                assert.deepEqual(effects.events, [])
                assert.deepEqual(effects.sources, [])
                assert.deepEqual(effects.message?.content, [])
                assert.equal(effects.session?.inflight, h.messageId)
                assert.notEqual(
                    effects.session?.frameworkSessionRef,
                    'old-framework-ref'
                )
                assert.equal(effects.execution?.execSessionId, null)
                assert.equal(effects.execution?.upstreamTaskId, null)
                assert.deepEqual(effects.usage, [])
                assert.equal(effects.execution?.state, 'running')
                assert.equal(
                    effects.execution?.generation,
                    claim.outcome === 'claimed'
                        ? claim.row.generation
                        : undefined
                )
            } finally {
                releaseHeld?.()
                await heldDone?.catch(() => undefined)
                await writer.close()
                await claimant.close()
                await h.close()
            }
        }
    }
)

test(
    'stale-write-first commits before takeover for every durable write',
    { skip: !RUN },
    async () => {
        for (const kind of WRITE_KINDS) {
            const h = await buildHarness()
            const writer = await connect(`fence-first-${kind}`)
            const claimant = await connect(`fence-follow-${kind}`)
            let releaseHeld: (() => void) | null = null
            let heldDone: Promise<unknown> | null = null
            try {
                const stale = await stamp(h)
                await expire(h)
                const held = await heldTransaction(writer, (repo) =>
                    writeWithFence(repo, h, kind, stale)
                )
                releaseHeld = held.release
                heldDone = held.done
                const writeResult = await held.ready
                assert.equal(
                    (writeResult as { fenceLost: boolean }).fenceLost,
                    false
                )

                const input = await liveClaimInput(h, 'replica-b')
                let settled = false
                const claim = claimant.repo
                    .claimTurnForResume(input)
                    .then((result) => {
                        settled = true
                        return result
                    })
                await waitUntilLocked(h.db, claimant)
                assert.equal(settled, false)

                held.release()
                await held.done
                const claimed = await claim
                assert.equal(
                    claimed.outcome,
                    kind === 'terminal' ? 'terminal' : 'claimed'
                )

                const effects = await readEffects(h)
                if (kind === 'event')
                    assert.deepEqual(effects.events, [{ type: 'token' }])
                if (kind === 'terminal') {
                    assert.deepEqual(effects.events, [{ type: 'done' }])
                    assert.deepEqual(effects.message?.content, [
                        { type: 'text', text: 'old terminal' }
                    ])
                    assert.equal(effects.session?.inflight, null)
                    assert.equal(effects.execution?.state, 'done')
                }
                if (kind === 'content')
                    assert.deepEqual(effects.message?.content, [
                        { type: 'text', text: 'old checkpoint' }
                    ])
                if (kind === 'source')
                    assert.deepEqual(effects.sources, [{ seq: 1 }])
                if (kind === 'framework_ref')
                    assert.equal(
                        effects.session?.frameworkSessionRef,
                        'old-framework-ref'
                    )
                if (kind === 'exec_ref')
                    assert.equal(effects.execution?.execSessionId, 'old-exec')
                if (kind === 'upstream_ref')
                    assert.equal(effects.execution?.upstreamTaskId, 'old-task')
                if (kind === 'usage')
                    assert.deepEqual(effects.usage, [{ inputTokens: 1 }])
            } finally {
                releaseHeld?.()
                await heldDone?.catch(() => undefined)
                await claimant.close()
                await writer.close()
                await h.close()
            }
        }
    }
)

test('idle recovery and a new dispatch serialize on the session row', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    const recovery = await connect('fence-idle-recovery')
    const dispatch = await connect('fence-idle-dispatch')
    let releaseHeld: (() => void) | null = null
    let heldDone: Promise<unknown> | null = null
    try {
        await h.repo.releaseInflightTurn(h.sessionId, h.messageId)
        assert.equal(
            await dispatch.repo.claimInflightTurn(h.sessionId, 'live-claim'),
            true
        )
        assert.deepEqual(
            await recovery.repo.upsertMessageSourcesForIdleSession(
                h.sessionId,
                [],
                'must-not-land'
            ),
            { upserted: 0, conflicted: true }
        )
        assert.notEqual(
            (await h.repo.getSessionById(h.sessionId))?.frameworkSessionRef,
            'must-not-land'
        )
        assert.deepEqual(
            await recovery.repo.replaceSessionMessages(h.sessionId, []),
            { replaced: 0, conflicted: true, upsertedSources: 0 }
        )
        await dispatch.repo.releaseInflightTurn(h.sessionId, 'live-claim')

        const held = await heldTransaction(recovery, (repo) =>
            repo.upsertMessageSourcesForIdleSession(
                h.sessionId,
                [sourceRow(h, 'recovery-first')],
                'framework-recovered'
            )
        )
        releaseHeld = held.release
        heldDone = held.done
        assert.deepEqual(await held.ready, {
            upserted: 1,
            conflicted: false
        })
        let settled = false
        const claim = dispatch.repo
            .claimInflightTurn(h.sessionId, 'live-after-recovery')
            .then((result) => {
                settled = true
                return result
            })
        await waitUntilLocked(h.db, dispatch)
        assert.equal(settled, false)
        held.release()
        await held.done
        assert.equal(await claim, true)
        assert.equal(
            (await h.repo.getSessionById(h.sessionId))?.frameworkSessionRef,
            'framework-recovered'
        )
        releaseHeld = null
        heldDone = null
        await dispatch.repo.releaseInflightTurn(
            h.sessionId,
            'live-after-recovery'
        )

        const rebuild = await heldTransaction(recovery, (repo) =>
            repo.replaceSessionMessages(h.sessionId, [])
        )
        releaseHeld = rebuild.release
        heldDone = rebuild.done
        assert.deepEqual(await rebuild.ready, {
            replaced: 0,
            conflicted: false,
            upsertedSources: 0
        })
        settled = false
        const claimAfterRebuild = dispatch.repo
            .claimInflightTurn(h.sessionId, 'live-after-rebuild')
            .then((result) => {
                settled = true
                return result
            })
        await waitUntilLocked(h.db, dispatch)
        assert.equal(settled, false)
        rebuild.release()
        await rebuild.done
        assert.equal(await claimAfterRebuild, true)
    } finally {
        releaseHeld?.()
        await heldDone?.catch(() => undefined)
        await dispatch.close()
        await recovery.close()
        await h.close()
    }
})

test('resume claim is a single-winner CAS and validates the exact hello', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const first = await stamp(h)
        const inputA = await liveClaimInput(h, 'replica-a')
        const inputB = await liveClaimInput(h, 'replica-b')
        assert.deepEqual(await h.repo.claimTurnForResume(inputB), {
            outcome: 'busy'
        })

        await expire(h)
        const raced = await Promise.all([
            h.repo.claimTurnForResume(inputA),
            h.repo.claimTurnForResume(inputB)
        ])
        const winners = raced.filter(
            (
                claim
            ): claim is Extract<ResumeTurnClaim, { outcome: 'claimed' }> =>
                claim.outcome === 'claimed'
        )
        assert.equal(winners.length, 1)
        assert.equal(
            raced.filter((claim) => claim.outcome === 'busy').length,
            1
        )
        assert.equal(winners[0]!.row.generation, first.generation + 1)
        assert.deepEqual(
            await h.repo.claimTurnForResume(
                await liveClaimInput(h, winners[0]!.row.ownerId)
            ),
            { outcome: 'busy' },
            'repeat hello cannot steal a live resume'
        )
        assert.deepEqual(
            await h.repo.claimTurnForResume({
                ...(await liveClaimInput(h, 'replica-c')),
                daemonExecRef: 'outdated-ref'
            }),
            { outcome: 'mismatch' }
        )
    } finally {
        await h.close()
    }
})

test('matched hello preempts only a fence-aware adoption', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        await stamp(h)
        await h.db
            .update(turnExecutions)
            .set({
                state: 'adopting',
                leaseExpiresAt: new Date(Date.now() + 60_000)
            })
            .where(eq(turnExecutions.messageId, h.messageId))
        assert.deepEqual(
            await h.repo.claimTurnForResume(
                await liveClaimInput(h, 'replica-b')
            ),
            { outcome: 'busy' },
            'generation 1 may be a rolling-deploy adopter that cannot fence'
        )

        await h.db
            .update(turnExecutions)
            .set({ generation: 2 })
            .where(eq(turnExecutions.messageId, h.messageId))
        const claim = await h.repo.claimTurnForResume(
            await liveClaimInput(h, 'replica-b')
        )
        assert.equal(claim.outcome, 'claimed')
        if (claim.outcome === 'claimed') assert.equal(claim.row.generation, 3)
    } finally {
        await h.close()
    }
})

test('a missing-row hello cannot preempt a rolling-deploy legacy carrier', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const claimed = await h.repo.claimTurnForResume(
            await liveClaimInput(h, 'replica-b')
        )
        assert.deepEqual(claimed, { outcome: 'busy' })
        const stamped = await stamp(h, ONE_OWNER)
        assert.equal(stamped.generation, 1)
    } finally {
        await h.close()
    }
})

test('a repeated initial stamp cannot reuse a generation even for the same owner', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const first = await stamp(h, ONE_OWNER)
        assert.equal(first.generation, 1)
        assert.equal(
            await h.repo.upsertTurnExecution({
                messageId: h.messageId,
                sessionId: h.sessionId,
                agentId: h.agentId,
                runtime: 'daemon',
                ownerId: ONE_OWNER,
                leaseSeconds: 90
            }),
            null
        )
        assert.equal(
            (await h.repo.getTurnExecution(h.messageId))?.generation,
            first.generation
        )
    } finally {
        await h.close()
    }
})

test('recovery handles and usage reject a stale generation', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        const stale = await stamp(h)
        await expire(h)
        const claim = await h.repo.claimTurnForResume(
            await liveClaimInput(h, ONE_OWNER)
        )
        assert.equal(claim.outcome, 'claimed')
        if (claim.outcome !== 'claimed') return
        const fresh: TurnExecutionFence = {
            messageId: h.messageId,
            ownerId: claim.row.ownerId,
            generation: claim.row.generation
        }
        const wrongMessageFence = {
            ...fresh,
            messageId: 'msg_not_the_write_target'
        }

        assert.deepEqual(
            await h.repo.insertStreamEvent(
                {
                    sessionId: h.sessionId,
                    messageId: h.messageId,
                    seq: 1,
                    eventType: 'done',
                    payloadJson: { type: 'done' }
                },
                { replayFromStream: true },
                wrongMessageFence
            ),
            { id: null, fenceLost: true }
        )
        assert.deepEqual(
            await h.repo.writeAssistantContent(
                h.messageId,
                [{ type: 'text', text: 'must not land' }],
                null,
                wrongMessageFence
            ),
            { written: false, fenceLost: true }
        )
        assert.deepEqual(
            await h.repo.upsertMessageSources(
                [sourceRow(h, 'must not land')],
                wrongMessageFence
            ),
            { upserted: 0, fenceLost: true }
        )
        assert.equal(
            await h.repo.setTurnExecSession(
                h.messageId,
                'wrong-sprite',
                'wrong-exec',
                wrongMessageFence
            ),
            false
        )
        assert.deepEqual(
            await h.repo.setTurnUpstreamRef(
                h.messageId,
                { taskId: 'wrong-task' },
                wrongMessageFence
            ),
            { written: false, fenceLost: true }
        )
        assert.equal(
            await h.repo.releaseInflightTurn(
                h.sessionId,
                h.messageId,
                wrongMessageFence
            ),
            false
        )

        assert.equal(
            await h.repo.setTurnExecSession(
                h.messageId,
                'stale-sprite',
                'stale-exec',
                stale
            ),
            false
        )
        assert.deepEqual(
            await h.repo.setTurnUpstreamRef(
                h.messageId,
                { taskId: 'stale-task' },
                stale
            ),
            { written: false, fenceLost: true }
        )
        await assert.rejects(
            h.repo.updateFrameworkSessionRef(
                h.sessionId,
                'stale-framework',
                stale
            ),
            TurnFenceLostError
        )
        await assert.rejects(
            h.repo.clearFrameworkSessionRefIfMatches(
                h.sessionId,
                (await h.repo.getSessionById(h.sessionId))
                    ?.frameworkSessionRef ?? '',
                stale
            ),
            TurnFenceLostError
        )
        assert.equal(
            await h.repo.releaseInflightTurn(h.sessionId, h.messageId, stale),
            false
        )
        assert.equal(
            (await h.repo.getSessionById(h.sessionId))?.inflightMessageId,
            h.messageId
        )

        const usage = new UsageRepository(h.db)
        const usageRow = {
            id: `usage-${h.messageId}`,
            userId: h.userId,
            agentId: h.agentId,
            runtimeId: h.runtimeId,
            sessionId: h.sessionId,
            messageId: h.messageId,
            framework: 'claude-code' as const,
            runtimeKind: 'daemon' as const,
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: null,
            costSource: 'upstream' as const,
            isFallbackModel: false,
            firstTokenMs: null,
            totalMs: null,
            modelProviderId: null,
            createdAt: new Date()
        }
        assert.equal(await usage.insert(usageRow, wrongMessageFence), false)
        assert.equal(await usage.insert(usageRow, stale), false)
        assert.equal(await usage.insert(usageRow, fresh), true)

        assert.equal(
            await h.repo.setTurnExecSession(
                h.messageId,
                'fresh-sprite',
                'fresh-exec',
                fresh
            ),
            true
        )
        assert.deepEqual(
            await h.repo.setTurnUpstreamRef(
                h.messageId,
                { taskId: 'fresh-task' },
                fresh
            ),
            { written: true, fenceLost: false }
        )
        await h.repo.updateFrameworkSessionRef(
            h.sessionId,
            'fresh-framework',
            fresh
        )
        assert.equal(
            await h.repo.handoffOwnedTurn(
                h.messageId,
                fresh.ownerId,
                fresh.generation
            ),
            true
        )
        assert.equal(
            await h.repo.setTurnExecSession(
                h.messageId,
                'draining-sprite',
                'draining-exec',
                fresh
            ),
            true
        )
        assert.deepEqual(
            await h.repo.setTurnUpstreamRef(
                h.messageId,
                { upstreamMessageId: 'draining-upstream-message' },
                fresh
            ),
            { written: true, fenceLost: false }
        )
        const [execution] = await h.db
            .select()
            .from(turnExecutions)
            .where(eq(turnExecutions.messageId, h.messageId))
        assert.equal(execution?.execSessionId, 'draining-exec')
        assert.equal(execution?.upstreamTaskId, 'fresh-task')
        assert.equal(execution?.upstreamMessageId, 'draining-upstream-message')
        assert.equal(
            (await h.repo.getSessionById(h.sessionId))?.frameworkSessionRef,
            'fresh-framework'
        )
        const storedUsage = await h.db
            .select({ inputTokens: agentUsageEvents.inputTokens })
            .from(agentUsageEvents)
            .where(eq(agentUsageEvents.messageId, h.messageId))
        assert.deepEqual(storedUsage, [{ inputTokens: 1 }])
    } finally {
        await h.close()
    }
})

test('adoption claim cannot pull a daemon execution', async (t) => {
    if (!RUN) return t.skip('set RUN_PG_E2E=1')
    const h = await buildHarness()
    try {
        await stamp(h)
        await expire(h)
        assert.equal(
            await h.repo.claimTurnForAdoption(h.messageId, 'replica-b', 90),
            null
        )
    } finally {
        await h.close()
    }
})
