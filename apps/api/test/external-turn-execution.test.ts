import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { TurnExecutionRow } from '@manyfold/db'
import type {
    ApiChatAdapterContext,
    ApiChatConvergeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'
import type { TurnExecutionFence } from '../src/modules/chat/turn-fence'
import {
    TURN_LEASE_RENEW_MS,
    TURN_LEASE_SECONDS
} from '../src/modules/chat/turn-adoption.service'

// #670. Before this, `runAdapter` wrote turn_executions only for
// `runtime === 'sprites'`, so a dify/langflow/a2a turn had no execution row, no
// lease, and nothing for the shutdown handoff or the adoption sweep to find —
// every daily API deploy killed every in-flight external turn while the
// upstream finished (and billed for) the answer.
//
// These drive the real runAdapter / adoptTurnExecution over fake
// infrastructure: the properties under test are which rows get stamped, which
// turns the adoption dispatch hands to the convergence path, and — just as
// load-bearing — which turns it refuses to pretend it can recover.

const OWNER_ID = 'instance-under-test'

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: 'conv-1',
    createdAt: new Date(),
    updatedAt: new Date()
}

const messageRow = {
    id: 'assistant-1',
    sessionId: 'session-1',
    role: 'assistant' as const,
    createdAt: new Date(Date.now() - 60_000),
    daemonId: null,
    daemonExecRef: null,
    contentBlocksJson: [],
    capabilityEventsJson: null,
    cancelRequestedAt: null,
    abortDispatchedAt: null
}

const executionRow = (
    over: Partial<TurnExecutionRow> = {}
): TurnExecutionRow => ({
    messageId: 'assistant-1',
    sessionId: 'session-1',
    agentId: 'agent-1',
    runtime: 'external',
    spriteName: null,
    execSessionId: null,
    upstreamTaskId: 'task-1',
    upstreamMessageId: 'dify-msg-1',
    ownerId: OWNER_ID,
    generation: 1,
    leaseExpiresAt: new Date(0),
    state: 'adopting',
    adoptCount: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over
})

interface UpsertCall {
    messageId: string
    runtime: string
    ownerId: string
    leaseSeconds: number
}

interface UpstreamRef {
    taskId: string | null
    upstreamMessageId: string | null
}

interface TelemetryCall {
    name: string
    attrs: Record<string, unknown>
    error: string | null
}

interface Harness {
    service: ChatService
    upserts: UpsertCall[]
    upstreamRefs: Array<{
        messageId: string
        taskId?: string | null
        upstreamMessageId?: string | null
    }>
    // What a PEER would read: only the halves a write actually committed, merged
    // column-wise the way the real UPDATE merges them.
    durableRef: UpstreamRef
    releaseRefWrites: () => void
    telemetry: TelemetryCall[]
    renewals: string[]
    handoffs: string[]
    singleHandoffs: TurnExecutionFence[]
    emitted: Array<{ type: string; payload: unknown; refAtEmit: UpstreamRef }>
    convergeCalls: ApiChatConvergeContext[]
    adapterStarted: Promise<void>
    refWriteStarted: Promise<void>
    terminalEmitted: Promise<void>
    settle: () => Promise<void>
    releaseCalls: string[]
    adapterStarts: () => number
    inflight: () => string | null
}

type AdapterScript = 'ref-then-done' | 'park' | 'suspend'
type RefWriteMode = 'commit' | 'defer' | 'reject-once' | 'no-row'
type StampWriteMode = 'commit' | 'null' | 'throw'

const REF_WRITE_ERROR = 'turn_executions write failed'

const makeHarness = (opts: {
    runtime: 'external' | 'sprites'
    framework: string
    script?: AdapterScript
    refWrite?: RefWriteMode
    stampWrite?: StampWriteMode
    renewResult?: boolean
    streamFenceThrows?: boolean
    converge?: (
        ctx: ApiChatConvergeContext
    ) => AsyncIterable<EmittedChatEvent> | null
}): Harness => {
    const agentRow = {
        id: 'agent-1',
        userId: 'user-1',
        framework: opts.framework,
        runtime: opts.runtime,
        runtimeId: 'runtime-1',
        model: null
    }
    const upserts: UpsertCall[] = []
    const upstreamRefs: Harness['upstreamRefs'] = []
    const durableRef: UpstreamRef = { taskId: null, upstreamMessageId: null }
    const telemetry: TelemetryCall[] = []
    const refWrite = opts.refWrite ?? 'commit'
    const heldRefWrites: Array<() => void> = []
    let deferRefWrites = refWrite === 'defer'
    const renewals: string[] = []
    const handoffs: string[] = []
    const singleHandoffs: TurnExecutionFence[] = []
    const emitted: Harness['emitted'] = []
    const convergeCalls: ApiChatConvergeContext[] = []
    const insertedMessages: Array<{ id: string; role: string }> = []
    const releaseCalls: string[] = []
    let adapterStarts = 0
    let latestInflight: string | null = null
    let adapterStartedResolve!: () => void
    const adapterStarted = new Promise<void>((r) => {
        adapterStartedResolve = r
    })
    let refWriteStartedResolve!: () => void
    const refWriteStarted = new Promise<void>((resolve) => {
        refWriteStartedResolve = resolve
    })
    let terminalEmittedResolve!: () => void
    const terminalEmitted = new Promise<void>((resolve) => {
        terminalEmittedResolve = resolve
    })

    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: () => ({ limit: async () => [agentRow] })
                }),
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) })
    }
    const repo = {
        listOrphanedAssistantMessages: async () => [],
        getSession: async () => sessionRow,
        getSessionById: async () => sessionRow,
        getMessageById: async () => messageRow,
        listStreamEventsSince: async () => [],
        insertMessage: async (row: { id: string; role: string }) => {
            insertedMessages.push(row)
            if (row.role === 'assistant') latestInflight = row.id
            return row
        },
        listMessages: async () => insertedMessages,
        latestInflightMessageId: async () => latestInflight,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async (_sessionId: string, messageId: string) => {
            releaseCalls.push(messageId)
            latestInflight = null
            return true
        },
        upsertMessageSources: async (rows: unknown[]) => ({
            upserted: rows.length,
            fenceLost: false
        }),
        writeAssistantContent: async () => ({
            written: true,
            fenceLost: false
        }),
        insertStreamEvent: async () => undefined,
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined,
        clearStaleInflightClaims: async () => 0,
        maxStreamEventSeq: async () => 0n,
        markCancelRequested: async () => undefined,
        findCancelRequestedMessageIds: async () => [],
        daemonSeenWithin: async () => false,
        upsertTurnExecution: async (row: UpsertCall) => {
            upserts.push(row)
            if (opts.stampWrite === 'throw')
                throw new Error('execution stamp unavailable')
            if (opts.stampWrite === 'null') return null
            return {
                messageId: row.messageId,
                ownerId: row.ownerId,
                generation: 1
            }
        },
        setTurnUpstreamRef: async (
            messageId: string,
            ref: { taskId?: string | null; upstreamMessageId?: string | null }
        ) => {
            upstreamRefs.push({ messageId, ...ref })
            refWriteStartedResolve()
            if (deferRefWrites)
                await new Promise<void>((resolve) =>
                    heldRefWrites.push(resolve)
                )
            if (refWrite === 'reject-once' && upstreamRefs.length === 1)
                throw new Error(REF_WRITE_ERROR)
            // The real UPDATE reports whether a row took the write; nothing is
            // durable when none did.
            if (refWrite === 'no-row')
                return { written: false, fenceLost: false }
            if (ref.taskId) durableRef.taskId = ref.taskId
            if (ref.upstreamMessageId)
                durableRef.upstreamMessageId = ref.upstreamMessageId
            return { written: true, fenceLost: false }
        },
        renewTurnLease: async (messageId: string) => {
            renewals.push(messageId)
            return opts.renewResult ?? true
        },
        // Models the real UPDATE: it can only hand off rows that EXIST and are
        // owned here. A fake that returned the live message id regardless would
        // pass on code that never stamped an external row at all — which is
        // precisely the bug.
        handoffOwnedTurns: async (
            fences: TurnExecutionFence[],
            refs: Array<{
                messageId: string
                taskId?: string | null
                upstreamMessageId?: string | null
            }> = []
        ) => {
            handoffs.push(...fences.map((fence) => fence.ownerId))
            const rows = upserts.filter(
                (row) =>
                    fences.some(
                        (fence) =>
                            fence.messageId === row.messageId &&
                            fence.ownerId === row.ownerId &&
                            fence.generation === 1
                    ) && row.messageId === latestInflight
            )
            for (const ref of refs) {
                if (!rows.some((row) => row.messageId === ref.messageId))
                    continue
                if (ref.taskId) durableRef.taskId = ref.taskId
                if (ref.upstreamMessageId)
                    durableRef.upstreamMessageId = ref.upstreamMessageId
            }
            return rows.map((row) => row.messageId)
        },
        handoffOwnedTurn: async (
            messageId: string,
            ownerId: string,
            generation: number
        ) => {
            singleHandoffs.push({ messageId, ownerId, generation })
            return true
        }
    }
    const record = async (
        _messageId: string,
        event: { type: string; payload: unknown }
    ): Promise<{ persisted: boolean; fenceLost?: boolean }> => {
        // Snapshotted per event: "was the ref durable BEFORE the turn produced
        // anything a peer could race?" is the whole property under test, and it
        // is only answerable at the instant of the emission.
        emitted.push({ ...event, refAtEmit: { ...durableRef } })
        if (event.type === 'done' || event.type === 'error') {
            if (opts.stampWrite === 'null')
                return { persisted: false, fenceLost: true }
            latestInflight = null
            terminalEmittedResolve()
        }
        return { persisted: true }
    }
    const broadcaster = {
        beginStream: () => undefined,
        setStreamFence: () => {
            if (opts.streamFenceThrows) throw new Error('stream setup failed')
        },
        beginResumeStream: async () => undefined,
        endStream: () => undefined,
        hasStream: () => true,
        emit: record,
        emitDetached: record
    }
    const adapter = {
        framework: opts.framework,
        sendMessage: async function* (
            ctx: ApiChatAdapterContext
        ): AsyncIterable<EmittedChatEvent> {
            adapterStarts += 1
            adapterStartedResolve()
            // Awaited exactly as the real external adapter awaits it — the sink
            // is a durability barrier, so a stream that ran on would be testing
            // a contract nothing implements. That the SHIPPED adapter honours it
            // is pinned separately, against a real upstream, in
            // external-upstream-ref.test.ts.
            await ctx.onUpstreamRef?.({
                taskId: 'task-1',
                upstreamMessageId: null
            })
            await ctx.onUpstreamRef?.({
                taskId: null,
                upstreamMessageId: 'dify-msg-1'
            })
            yield { type: 'token', text: 'partial' }
            if (opts.script === 'suspend') {
                yield {
                    type: 'suspended',
                    daemonId: 'daemon-1',
                    daemonExecRef: ctx.messageId,
                    reason: 'connection closed'
                }
                return
            }
            if (opts.script === 'park') {
                const signal = ctx.abortSignal
                await new Promise<void>((resolve) => {
                    if (!signal) return
                    if (signal.aborted) resolve()
                    else
                        signal.addEventListener('abort', () => resolve(), {
                            once: true
                        })
                })
                return
            }
            yield { type: 'done', finalMessageId: ctx.messageId }
        },
        convergeTurn: (ctx: ApiChatConvergeContext) => {
            convergeCalls.push(ctx)
            return opts.converge ? opts.converge(ctx) : null
        }
    }
    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => adapter } as never,
        {} as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) => {
                telemetry.push({ name, attrs, error: null })
            },
            error: (
                name: string,
                err: Error,
                attrs: Record<string, unknown>
            ) => {
                telemetry.push({ name, attrs, error: err.message })
            }
        } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        {
            ownerId: OWNER_ID,
            enabled: true,
            kick: () => {},
            stopClaiming: async () => undefined
        } as never
    )
    return {
        service,
        upserts,
        upstreamRefs,
        durableRef,
        releaseRefWrites: () => {
            deferRefWrites = false
            for (const release of heldRefWrites.splice(0)) release()
        },
        telemetry,
        renewals,
        handoffs,
        singleHandoffs,
        emitted,
        convergeCalls,
        adapterStarted,
        refWriteStarted,
        terminalEmitted,
        releaseCalls,
        adapterStarts: () => adapterStarts,
        inflight: () => latestInflight,
        // Several hops of promise plumbing sit between a repo write and the
        // broadcast it unblocks, so one turn of the loop is not enough to claim
        // an event did NOT happen.
        settle: async () => {
            for (let i = 0; i < 5; i++)
                await new Promise((resolve) => setImmediate(resolve))
        }
    }
}

test('an external turn stamps an execution row with the external runtime', async () => {
    const h = makeHarness({ runtime: 'external', framework: 'dify' })
    const sent = await h.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    await h.adapterStarted
    await h.settle()

    assert.deepEqual(h.upserts, [
        {
            messageId: sent.assistantMessageId,
            sessionId: 'session-1',
            agentId: 'agent-1',
            runtime: 'external',
            spriteName: null,
            ownerId: OWNER_ID,
            leaseSeconds: TURN_LEASE_SECONDS
        }
    ])
})

test('a failed initial execution stamp never dispatches or releases another owner', async () => {
    for (const stampWrite of ['null', 'throw'] as const) {
        const h = makeHarness({
            runtime: 'external',
            framework: 'dify',
            stampWrite
        })
        const sent = await h.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await h.settle()

        assert.equal(h.adapterStarts(), 0)
        assert.deepEqual(
            h.emitted.map((event) => event.type),
            ['error']
        )
        assert.deepEqual(h.releaseCalls, [])
        assert.equal(
            h.inflight(),
            stampWrite === 'null' ? sent.assistantMessageId : null
        )
    }
})

test('a post-stamp setup failure hands off without releasing the session claim', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        streamFenceThrows: true
    })
    const sent = await h.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    await h.settle()

    assert.equal(h.adapterStarts(), 0)
    assert.deepEqual(h.releaseCalls, [])
    assert.equal(h.inflight(), sent.assistantMessageId)
    assert.deepEqual(h.singleHandoffs, [
        {
            messageId: sent.assistantMessageId,
            ownerId: OWNER_ID,
            generation: 1
        }
    ])
})

// The refs are the whole recovery surface, and they are written mid-stream on
// purpose: this instance may not live long enough to see a terminal.
test('upstream refs are persisted as each half arrives, without clobbering', async () => {
    const h = makeHarness({ runtime: 'external', framework: 'dify' })
    const sent = await h.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    await h.adapterStarted
    await h.settle()

    assert.deepEqual(h.upstreamRefs, [
        {
            messageId: sent.assistantMessageId,
            taskId: 'task-1',
            upstreamMessageId: null
        },
        {
            messageId: sent.assistantMessageId,
            taskId: null,
            upstreamMessageId: 'dify-msg-1'
        }
    ])
})

// ...and "persisted" has to mean the row took it, not "the call was made". The
// sink used to be fire-and-forget, so the write raced everything downstream of
// it: the next token, the terminal, the shutdown handoff, a peer's adoption.
// Every one of those is the moment the ref exists to survive, and a peer that
// wins the race reads a null ref and can only write `server_restart` — the exact
// outcome #670 set out to remove.
test('a pending upstream ref write holds the turn until the ref is durable', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        script: 'park',
        refWrite: 'defer'
    })
    await h.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await h.refWriteStarted
    await h.settle()

    assert.equal(
        h.upstreamRefs.length,
        1,
        'the second announcement waits behind the first write; a sink never sees two in flight'
    )
    assert.deepEqual(
        h.emitted.map((e) => e.type),
        [],
        'no provider event may overtake a ref write that has not landed'
    )

    h.releaseRefWrites()
    await h.settle()

    assert.deepEqual(h.durableRef, {
        taskId: 'task-1',
        upstreamMessageId: 'dify-msg-1'
    })
    assert.deepEqual(
        h.emitted.map((e) => e.type),
        ['token'],
        'and the turn resumes the moment it is durable'
    )
    assert.deepEqual(h.emitted[0].refAtEmit, {
        taskId: 'task-1',
        upstreamMessageId: 'dify-msg-1'
    })
})

// Shutdown is independent of provider-stream backpressure. If it lands while
// the first write is still pending, the handoff transaction must carry the
// observed ref itself instead of exposing a ref-less row to a peer.
test('shutdown handoff atomically carries a ref whose first write is pending', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'a2a',
        script: 'park',
        refWrite: 'defer'
    })
    await h.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await h.refWriteStarted

    const result = await h.service.prepareForShutdown(0)
    assert.equal(result.handedOffTurns, 1)
    assert.deepEqual(h.durableRef, {
        taskId: 'task-1',
        upstreamMessageId: null
    })

    const peer = makeHarness({
        runtime: 'external',
        framework: 'a2a',
        converge: async function* () {
            yield {
                type: 'replace',
                text: 'the recovered answer',
                reason: 'upstream_converged'
            }
            yield { type: 'done', finalMessageId: 'assistant-1' }
        }
    })
    await peer.service.adoptTurnExecution(
        executionRow({
            upstreamTaskId: h.durableRef.taskId,
            upstreamMessageId: h.durableRef.upstreamMessageId
        })
    )

    assert.equal(peer.convergeCalls.length, 1)
    assert.deepEqual(
        {
            upstreamTaskId: peer.convergeCalls[0].upstreamTaskId,
            upstreamMessageId: peer.convergeCalls[0].upstreamMessageId
        },
        { upstreamTaskId: 'task-1', upstreamMessageId: null }
    )
    assert.deepEqual(
        peer.emitted.map((e) => e.type),
        ['turn_status', 'replace', 'done'],
        'the answer is recovered instead of thrown away'
    )
    h.releaseRefWrites()
})

test('a rejected upstream ref write is reported and its retained half repairs on retry', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        refWrite: 'reject-once'
    })
    const sent = await h.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    await h.terminalEmitted

    const types = h.emitted.map((e) => e.type)
    assert.ok(types.includes('token'), 'the answer still streams')
    assert.ok(types.includes('done'), 'and still terminalizes')
    assert.ok(
        !types.includes('error'),
        'a failed ref write must not fail a healthy turn'
    )

    const lost = h.telemetry.filter(
        (t) => t.name === 'chat.turn.upstream_ref_lost'
    )
    assert.equal(lost.length, 1)
    assert.equal(lost[0].error, REF_WRITE_ERROR)
    assert.equal(lost[0].attrs.reason, 'write_failed')
    assert.deepEqual(Object.keys(lost[0].attrs).sort(), [
        'agentId',
        'framework',
        'messageId',
        'reason',
        'sessionId'
    ])

    assert.deepEqual(h.upstreamRefs[1], {
        messageId: sent.assistantMessageId,
        taskId: 'task-1',
        upstreamMessageId: 'dify-msg-1'
    })
    assert.deepEqual(h.durableRef, {
        taskId: 'task-1',
        upstreamMessageId: 'dify-msg-1'
    })
})

// The quieter failure: the UPDATE succeeds but the execution row is absent.
// Counting that as persisted fabricates a recovery handle that does not exist.
test('an upstream ref write that matched no row is reported too', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        refWrite: 'no-row'
    })
    const sent = await h.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    await h.terminalEmitted

    const lost = h.telemetry.filter(
        (t) => t.name === 'chat.turn.upstream_ref_lost'
    )
    assert.deepEqual(
        lost.map((t) => t.attrs.reason),
        ['execution_row_missing', 'execution_row_missing']
    )
    assert.equal(
        lost[0].error,
        null,
        'nothing threw, so nothing is reported as an exception'
    )
    assert.deepEqual(h.upstreamRefs[1], {
        messageId: sent.assistantMessageId,
        taskId: 'task-1',
        upstreamMessageId: 'dify-msg-1'
    })
    assert.equal(
        h.emitted.at(-1)?.type,
        'done',
        'a normally completed relay stays done; server_restart only belongs to later adoption of an interrupted turn'
    )
})

test('an external turn renews its lease while it is streaming', async (t) => {
    // setInterval only: the budget watchdog and the source-flush window are
    // setTimeout, and mocking those would change what the turn does.
    t.mock.timers.enable({ apis: ['setInterval'] })
    try {
        const h = makeHarness({
            runtime: 'external',
            framework: 'dify',
            script: 'park'
        })
        const sent = await h.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await h.adapterStarted
        await h.settle()
        assert.deepEqual(h.renewals, [], 'nothing renewed before the interval')

        t.mock.timers.tick(TURN_LEASE_RENEW_MS)
        await h.settle()
        t.mock.timers.tick(TURN_LEASE_RENEW_MS)
        await h.settle()

        assert.deepEqual(h.renewals, [
            sent.assistantMessageId,
            sent.assistantMessageId
        ])
    } finally {
        mock.timers.reset()
    }
})

test('a rejected lease renewal stops without a false terminal or claim release', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    try {
        const h = makeHarness({
            runtime: 'external',
            framework: 'dify',
            script: 'park',
            renewResult: false
        })
        const sent = await h.service.sendMessage(
            'user-1',
            'agent-1',
            'session-1',
            'hello'
        )
        await h.adapterStarted
        await h.settle()

        t.mock.timers.tick(TURN_LEASE_RENEW_MS)
        await h.settle()

        assert.deepEqual(h.renewals, [sent.assistantMessageId])
        assert.deepEqual(
            h.emitted.map((event) => event.type),
            ['token']
        )
        assert.deepEqual(h.releaseCalls, [])
        assert.equal(h.inflight(), sent.assistantMessageId)
        assert.equal(h.service.activeTurnCount(), 0)
    } finally {
        mock.timers.reset()
    }
})

test('a suspended dispatch hands its drained generation to the next relay', async () => {
    const h = makeHarness({
        runtime: 'sprites',
        framework: 'claude-code',
        script: 'suspend'
    })
    const sent = await h.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'hello'
    )
    await h.adapterStarted
    await h.settle()

    assert.deepEqual(h.singleHandoffs, [
        {
            messageId: sent.assistantMessageId,
            ownerId: OWNER_ID,
            generation: 1
        }
    ])
    assert.deepEqual(h.releaseCalls, [])
    assert.equal(h.inflight(), sent.assistantMessageId)
    assert.equal(
        h.emitted.some((event) => ['done', 'error'].includes(event.type)),
        false
    )
})

// A deploy is the population this exists for: the drain times out on a
// multi-minute Dify chat-flow, and the handoff is what makes a peer pick it up
// within one sweep instead of the turn dying with the process.
test('a live external turn is handed off on shutdown', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        script: 'park'
    })
    await h.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await h.adapterStarted
    await h.settle()

    const result = await h.service.prepareForShutdown(10)

    assert.equal(result.activeTurnsAtStart, 1)
    assert.equal(result.drainOutcome, 'timeout')
    assert.deepEqual(h.handoffs, [OWNER_ID])
    assert.equal(result.handoffOutcome, 'handed_off')
    assert.equal(result.handedOffTurns, 1)
})

test('a claimed external turn is driven to done by the convergence path', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        converge: async function* () {
            yield {
                type: 'replace',
                text: 'the recovered answer',
                reason: 'upstream_converged'
            }
            yield { type: 'done', finalMessageId: 'assistant-1' }
        }
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.equal(h.convergeCalls.length, 1)
    assert.deepEqual(
        {
            messageId: h.convergeCalls[0].messageId,
            frameworkSessionRef: h.convergeCalls[0].frameworkSessionRef,
            upstreamTaskId: h.convergeCalls[0].upstreamTaskId,
            upstreamMessageId: h.convergeCalls[0].upstreamMessageId
        },
        {
            messageId: 'assistant-1',
            frameworkSessionRef: 'conv-1',
            upstreamTaskId: 'task-1',
            upstreamMessageId: 'dify-msg-1'
        }
    )
    // The leading informational row is #674 announcing the recovery; the two
    // rows after it are this test's subject.
    assert.deepEqual(
        h.emitted.map((e) => e.type),
        ['turn_status', 'replace', 'done'],
        'delivered under the original assistant message id'
    )
    assert.equal(
        (h.emitted[1].payload as { text: string }).text,
        'the recovered answer'
    )
})

// The honest-degrade half: a turn the adapter refuses to converge must CLOSE
// with the pre-existing retryable terminal, not hang waiting for a recovery
// that can never arrive.
test('an unconvergeable external turn keeps the retryable server_restart terminal', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'langflow',
        converge: () => null
    })

    await h.service.adoptTurnExecution(
        executionRow({ upstreamTaskId: null, upstreamMessageId: null })
    )

    assert.equal(h.convergeCalls.length, 1)
    assert.deepEqual(
        h.emitted.map((e) => e.type),
        ['error']
    )
    assert.deepEqual(h.emitted[0].payload, {
        type: 'error',
        error: {
            code: 'server_restart',
            message: 'stream interrupted by server restart',
            retryable: true
        }
    })
})

// Blast radius. A sprites row must take the transcript-recovery branch it
// always took; routing it through the upstream poll would replay a turn that
// has no upstream to poll.
test('a sprites turn never reaches the external convergence path', async () => {
    const h = makeHarness({
        runtime: 'sprites',
        framework: 'claude-code',
        converge: async function* () {
            yield { type: 'done', finalMessageId: 'assistant-1' }
        }
    })

    await h.service.adoptTurnExecution(
        executionRow({ runtime: 'sprites', spriteName: 'sprite-1' })
    )

    assert.deepEqual(h.convergeCalls, [])
    // execDrivers is absent in this harness, so the sprites branch falls
    // through to its own restart terminal — which is the point: a DIFFERENT
    // code path handled it.
    assert.deepEqual(
        h.emitted.map((e) => e.type),
        ['error']
    )
})

// A sprites turn must not be stamped as external either — the sweep dispatches
// on this column.
test('a sprites turn still stamps runtime=sprites', async () => {
    const h = makeHarness({ runtime: 'sprites', framework: 'claude-code' })
    await h.service.sendMessage('user-1', 'agent-1', 'session-1', 'hello')
    await h.adapterStarted
    await h.settle()

    assert.equal(h.upserts.length, 1)
    assert.equal(h.upserts[0].runtime, 'sprites')
})
