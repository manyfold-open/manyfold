import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatService } from '../src/modules/chat/chat.service'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import type { TurnExecutionFence } from '../src/modules/chat/turn-fence'

// #570, in the shape it was reported: a daemon-carried turn whose session has a
// framework_session_ref and whose message has a daemon_exec_ref, with
// exec_session_id null. Nothing for a sprite re-attach to hold, so a transcript
// adoption is the only recovery the sweep can offer — and it is strictly weaker
// than the daemon's own still-buffered stream, which only the replica holding
// that daemon's one reverse-WS connection can replay.
//
// Two writers on one assistant message id is the bug. Waiting out the adopter's
// 90s lease is not the fix: it throws the recoverable buffer away, and the
// adopter that cannot re-derive the answer closes the turn with server_restart
// first. So the matched hello preempts, and everything below is about the ORDER
// in which it does it: claim before abort, or the loser spends a window dying
// and still allowed to write; wait for release before attaching, or the
// preemption has created the second writer it exists to prevent.
//
// The broadcaster double here rejects any write whose fence is behind the
// latest claim, which is what Postgres does in turn-fence-generation.pg.test.ts.
// Without that the displaced adopter reaches the abort fall-through with
// fenceLost still false and libels the handover as cancelled_by_user.

const SESSION = 'session-fenced'
const TURN = 'msg-fenced'
const OWNER = 'replica-a'
const BASE_GENERATION = 7

const sessionRow = {
    id: SESSION,
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: 'fw-session-1',
    createdAt: new Date(),
    updatedAt: new Date()
}

const messageRow = {
    id: TURN,
    sessionId: SESSION,
    role: 'assistant',
    daemonId: 'dh-1',
    daemonExecRef: 'ref-1',
    cancelRequestedAt: null,
    abortDispatchedAt: null,
    createdAt: new Date(Date.now() - 60_000)
}

const agentRow = {
    framework: 'claude-code',
    runtime: 'daemon',
    runtimeId: 'rt-1',
    model: 'sonnet',
    modelProviderId: null,
    modelProviderBuiltInId: null,
    modelProviderSource: null,
    managedBrand: null,
    inferenceProtocol: null,
    daemonId: 'dh-1',
    spriteName: null,
    hostId: null,
    workspacePath: null
}

const execRow = {
    messageId: TURN,
    sessionId: SESSION,
    agentId: 'agent-1',
    runtime: 'sprites' as const,
    spriteName: null,
    execSessionId: null,
    upstreamTaskId: null,
    upstreamMessageId: null,
    ownerId: OWNER,
    generation: BASE_GENERATION,
    leaseExpiresAt: new Date(Date.now() + 90_000),
    state: 'adopting' as const,
    adoptCount: 1,
    createdAt: new Date(),
    updatedAt: new Date()
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
        resolve = r
    })
    return { promise, resolve }
}

interface Written {
    type: string
    generation: number | null
}

interface Harness {
    service: ChatService
    written: Written[]
    claims: Array<{ messageId: string; ownerId: string }>
    order: string[]
    adoptionEntered: Promise<void>
    releaseAdoption: () => void
    adoptionAborted: () => boolean
    activeTurns: () => number
    handedOff: number[]
    releasedInflight: string[]
    hasStream: () => boolean
}

const makeHarness = (
    opts: { claimReturns?: 'null'; resumeThrows?: boolean } = {}
): Harness => {
    const written: Written[] = []
    const claims: Array<{ messageId: string; ownerId: string }> = []
    const order: string[] = []
    const entered = deferred()
    const adoptionStream = deferred()
    let abortSeen = false
    const handedOff: number[] = []
    const releasedInflight: string[] = []
    // The row's generation column, owned by the DB double and bumped by the
    // claim exactly as claimTurnForResume bumps it.
    let generation = BASE_GENERATION

    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: () => ({ limit: async () => [agentRow] })
                })
            })
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) })
    }

    const repo = {
        getSessionById: async () => sessionRow,
        getMessageById: async () => messageRow,
        getTurnExecution: async () => execRow,
        listStreamEventsSince: async () => [],
        listMessageSourceRows: async () => [],
        listForeignSourceUuids: async () => [],
        latestUserMessageBefore: async () => null,
        maxStreamEventSeq: async () => 0,
        exactResumeSeqForMessage: async () => 0,
        safeResumeSeqForMessage: async () => 0,
        boundedResumeStatusOrdinal: async () => 0,
        writeAssistantContent: async () => ({
            written: true,
            fenceLost: false
        }),
        upsertMessageSources: async (rows: unknown[]) => ({
            upserted: rows.length,
            fenceLost: false
        }),
        renewTurnLease: async () => true,
        handoffOwnedTurn: async (
            _messageId: string,
            _ownerId: string,
            claimedGeneration: number
        ) => {
            handedOff.push(claimedGeneration)
            return true
        },
        releaseInflightTurn: async (_sessionId: string, messageId: string) => {
            releasedInflight.push(messageId)
            return true
        },
        turnFenceHolds: async (fence: TurnExecutionFence) =>
            fence.generation === generation,
        claimTurnForResume: async (input: {
            messageId: string
            ownerId: string
        }) => {
            order.push('claim')
            claims.push({
                messageId: input.messageId,
                ownerId: input.ownerId
            })
            if (opts.claimReturns === 'null')
                return { outcome: 'busy' as const }
            generation += 1
            return {
                outcome: 'claimed' as const,
                row: {
                    ...execRow,
                    ownerId: input.ownerId,
                    generation,
                    state: 'running'
                }
            }
        }
    }

    // Mirrors ChatSseBroadcaster: one stream per message id, carrying the fence
    // it was opened under, latching fenceLost once a write is refused.
    const streams = new Map<
        string,
        { fence: TurnExecutionFence | null; fenceLost: boolean }
    >()
    const write = async (
        messageId: string,
        event: { type: string }
    ): Promise<{ persisted: boolean; fenceLost: boolean }> => {
        const stream = streams.get(messageId)
        if (!stream) return { persisted: false, fenceLost: false }
        if (stream.fenceLost) return { persisted: false, fenceLost: true }
        if (stream.fence && stream.fence.generation !== generation) {
            stream.fenceLost = true
            return { persisted: false, fenceLost: true }
        }
        written.push({
            type: event.type,
            generation: stream.fence?.generation ?? null
        })
        return { persisted: true, fenceLost: false }
    }

    const broadcaster = {
        hasStream: (messageId: string) => streams.has(messageId),
        beginStream: (
            _sessionId: string,
            messageId: string,
            _seq?: number,
            fence: TurnExecutionFence | null = null
        ) => {
            streams.set(messageId, { fence, fenceLost: false })
        },
        beginResumeStream: async (
            _sessionId: string,
            messageId: string,
            fence: TurnExecutionFence | null = null
        ) => {
            streams.set(messageId, { fence, fenceLost: false })
        },
        setStreamFence: (messageId: string, fence: TurnExecutionFence) => {
            const stream = streams.get(messageId)
            if (stream) stream.fence = fence
        },
        endStream: (messageId: string, fence?: TurnExecutionFence) => {
            const stream = streams.get(messageId)
            if (
                fence &&
                (!stream ||
                    stream.fence?.ownerId !== fence.ownerId ||
                    stream.fence.generation !== fence.generation)
            )
                return
            streams.delete(messageId)
        },
        emit: write,
        emitDetached: write
    }

    const resumeMessage = async function* (): AsyncIterable<EmittedChatEvent> {
        order.push('resume-attached')
        if (opts.resumeThrows) throw new Error('attach failed')
        yield { type: 'done', finalMessageId: TURN }
    }

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => ({ resumeMessage }) } as never,
        { record: async () => undefined } as never,
        {} as never,
        {} as never,
        { event: () => undefined, error: () => undefined } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        // execDrivers: adoption only needs a recovery handle to reach the
        // transcript stream, and that stream is the one thing stubbed below.
        {
            recoveryFsForAgent: async () => ({ fs: {}, spritesClient: null })
        } as never,
        undefined,
        undefined,
        {
            enabled: true,
            ownerId: OWNER,
            registerHandler: () => undefined
        } as never
    )

    const internals = service as unknown as {
        adoptedLiveStream: (args: {
            abortSignal: AbortSignal
        }) => AsyncIterable<EmittedChatEvent>
    }
    // Replaces the transcript reader and nothing else. The slot, the origin, the
    // claim, the abort, the drain wait and every fenced write stay real.
    internals.adoptedLiveStream = async function* (args: {
        abortSignal: AbortSignal
    }): AsyncIterable<EmittedChatEvent> {
        order.push('adoption-entered')
        args.abortSignal.addEventListener(
            'abort',
            () => {
                abortSeen = true
                order.push('adoption-aborted')
                adoptionStream.resolve()
            },
            { once: true }
        )
        // A partial answer this adoption really did re-derive and durably
        // deliver. It belongs to the turn and must survive the handover — the
        // fence rejects the loser's later writes, not its earlier ones.
        yield { type: 'token', text: 'partial from the transcript' }
        entered.resolve()
        await adoptionStream.promise
        order.push('adoption-left')
    }

    return {
        service,
        written,
        claims,
        order,
        adoptionEntered: entered.promise,
        releaseAdoption: adoptionStream.resolve,
        adoptionAborted: () => abortSeen,
        activeTurns: () => service.activeTurnCount(),
        handedOff,
        releasedInflight,
        hasStream: () => streams.has(TURN)
    }
}

const resume = (service: ChatService) =>
    service.resumeAssistantTurn({
        message: messageRow as never,
        daemonId: 'dh-1',
        refId: 'ref-1'
    })

test('a matched hello preempts a transcript adoption of the same turn', async () => {
    const h = makeHarness()
    const adopting = h.service.adoptTurnExecution(execRow as never)
    await h.adoptionEntered
    assert.equal(h.activeTurns(), 1, 'the adoption holds the slot')

    const outcome = await resume(h.service)
    await adopting

    assert.equal(outcome, 'handled')
    assert.ok(h.adoptionAborted(), 'the adoption was told to stop')
    assert.deepEqual(h.order, [
        'adoption-entered',
        // The claim is what fences the loser, including a loser on another
        // replica that no abort of ours can reach, so it lands FIRST.
        'claim',
        'adoption-aborted',
        'adoption-left',
        // And the attach waits for the slot rather than assuming it: two
        // writers on one message id is the whole bug.
        'resume-attached'
    ])
    assert.deepEqual(h.claims, [{ messageId: TURN, ownerId: OWNER }])
    assert.equal(h.activeTurns(), 0)
})

// The abort above is a handover, not a user pressing stop and not a restart.
// Either terminal, written by a carrier that no longer owns the turn, is a lie
// the user reads while the real answer is still streaming.
test('the displaced adopter writes no terminal of its own', async () => {
    const h = makeHarness()
    const adopting = h.service.adoptTurnExecution(execRow as never)
    await h.adoptionEntered

    await resume(h.service)
    await adopting

    const terminals = h.written.filter(
        (w) => w.type === 'done' || w.type === 'error'
    )
    assert.deepEqual(
        terminals,
        [{ type: 'done', generation: BASE_GENERATION + 1 }],
        'exactly one terminal, written by the new owner'
    )
})

// Every durable row is stamped with the generation its writer held. The
// adoption's rows carry the generation its own claim produced — including the
// partial answer it really did deliver, which the handover keeps — and nothing
// from the adoption lands after the bump.
test('writes are stamped with the generation their writer held', async () => {
    const h = makeHarness()
    const adopting = h.service.adoptTurnExecution(execRow as never)
    await h.adoptionEntered
    assert.deepEqual(h.written, [
        { type: 'turn_status', generation: BASE_GENERATION },
        { type: 'token', generation: BASE_GENERATION }
    ])

    await resume(h.service)
    await adopting

    assert.deepEqual(h.written.slice(2), [
        { type: 'turn_status', generation: BASE_GENERATION + 1 },
        { type: 'done', generation: BASE_GENERATION + 1 }
    ])
})

// No row to claim, or a row that already terminalized: there is nothing to
// fence the adopter with, so aborting it would only leave a writer we cannot
// stop. The adoption keeps the turn.
test('a resume that cannot claim leaves the adoption alone', async () => {
    const h = makeHarness({ claimReturns: 'null' })
    const adopting = h.service.adoptTurnExecution(execRow as never)
    await h.adoptionEntered

    const outcome = await resume(h.service)

    assert.equal(outcome, 'skipped_running_locally')
    assert.equal(h.adoptionAborted(), false, 'the adoption was not disturbed')
    assert.equal(h.activeTurns(), 1)

    h.releaseAdoption()
    await adopting
})

test('a repeat hello taking the released slot hands the claimed generation back', async () => {
    const h = makeHarness()
    const adopting = h.service.adoptTurnExecution(execRow as never)
    await h.adoptionEntered
    const internals = h.service as unknown as {
        trackRunningAdapter: (
            messageId: string,
            controller: AbortController,
            origin: string
        ) => boolean
    }
    const track = internals.trackRunningAdapter.bind(h.service)
    let resumeRegistrations = 0
    internals.trackRunningAdapter = (
        messageId,
        controller,
        origin
    ): boolean => {
        resumeRegistrations += 1
        if (resumeRegistrations === 2) return false
        return track(messageId, controller, origin)
    }

    const outcome = await resume(h.service)
    await adopting

    assert.equal(outcome, 'skipped_running_locally')
    assert.deepEqual(h.handedOff, [BASE_GENERATION + 1])
    assert.equal(h.activeTurns(), 0)
})

// Only a transcript adoption is weaker than the daemon's own buffer. A dispatch
// is the live carrier and a second resume is this same path already in flight;
// preempting either would be one writer displacing an equal.
test('a resume does not preempt a dispatch or another resume', async () => {
    for (const origin of ['dispatch', 'resume'] as const) {
        const h = makeHarness()
        const internals = h.service as unknown as {
            trackRunningAdapter: (
                messageId: string,
                controller: AbortController,
                origin: string
            ) => boolean
            untrackRunningAdapter: (
                messageId: string,
                controller: AbortController
            ) => void
        }
        const holder = new AbortController()
        assert.equal(internals.trackRunningAdapter(TURN, holder, origin), true)

        const outcome = await resume(h.service)

        assert.equal(outcome, 'skipped_running_locally')
        assert.equal(holder.signal.aborted, false, `${origin} kept the turn`)
        assert.deepEqual(h.claims, [], 'and no claim was even attempted')

        internals.untrackRunningAdapter(TURN, holder)
    }
})

test('a failed attach hands off its generation without releasing the session claim', async () => {
    const h = makeHarness({ resumeThrows: true })

    const outcome = await resume(h.service)

    assert.equal(outcome, 'skipped_owned_elsewhere')
    assert.deepEqual(h.handedOff, [BASE_GENERATION + 1])
    assert.deepEqual(h.releasedInflight, [])
    assert.equal(h.hasStream(), false)
    assert.equal(h.activeTurns(), 0)
    assert.deepEqual(h.written, [
        { type: 'turn_status', generation: BASE_GENERATION + 1 }
    ])
})
