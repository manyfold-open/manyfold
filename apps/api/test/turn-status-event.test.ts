import type { ChatStreamEvent } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TurnExecutionRow } from '@manyfold/db'
import { ChatService } from '../src/modules/chat/chat.service'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import {
    ChatSseBroadcaster,
    type PersistedStreamEventType
} from '../src/modules/chat/sse-broadcaster'
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'

// #674. Recovery was invisible: a turn orphaned by a deploy went silent for as
// long as the rebuild took, and the client could not tell that from a hang.
// These pin the three recovery entry points that now announce themselves, the
// dedup identity that bounds how many times they may do so, and — the half that
// actually protects the product — that the announcement is NOT a terminal.

const SESSION_REF = 'conv-1'

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: SESSION_REF,
    createdAt: new Date(),
    updatedAt: new Date()
}

const messageRow = {
    id: 'assistant-1',
    sessionId: 'session-1',
    role: 'assistant' as const,
    daemonId: 'dh-1',
    daemonExecRef: 'ref-1',
    contentBlocksJson: [],
    capabilityEventsJson: null,
    cancelRequestedAt: null,
    abortDispatchedAt: null,
    createdAt: new Date(Date.now() - 60_000)
}

const userMessageRow = {
    id: 'user-1-msg',
    sessionId: 'session-1',
    role: 'user' as const,
    daemonId: null,
    daemonExecRef: null,
    contentBlocksJson: [{ type: 'text', text: 'run the probe' }],
    capabilityEventsJson: null,
    cancelRequestedAt: null,
    abortDispatchedAt: null,
    createdAt: new Date(Date.now() - 61_000)
}

// A claude-code transcript that recovers on the FIRST poll, so the adoption
// tests exercise the real recovery instead of its give-up path (and finish in
// milliseconds rather than sitting out the re-poll ladder).
const TRANSCRIPT = [
    {
        uuid: 'u1',
        parentUuid: null,
        sessionId: SESSION_REF,
        type: 'user',
        timestamp: '2026-08-08T00:00:00.000Z',
        message: { role: 'user', content: 'run the probe' }
    },
    {
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: SESSION_REF,
        type: 'assistant',
        timestamp: '2026-08-08T00:00:01.000Z',
        message: {
            role: 'assistant',
            id: 'msg_1',
            model: 'claude-x',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: 'the recovered tail' }]
        }
    }
]
    .map((entry) => JSON.stringify(entry))
    .join('\n')

const executionRow = (over: Partial<TurnExecutionRow> = {}): TurnExecutionRow =>
    ({
        messageId: 'assistant-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        runtime: 'external',
        spriteName: null,
        execSessionId: null,
        upstreamTaskId: 'task-1',
        upstreamMessageId: 'dify-msg-1',
        ownerId: 'instance-under-test',
        generation: 2,
        leaseExpiresAt: new Date(0),
        state: 'adopting',
        adoptCount: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...over
    }) as TurnExecutionRow

interface EmittedRecord {
    type: string
    payload: Record<string, unknown>
    sourceEventKey: string | null
    sourceEventOrdinal: number | null
}

interface Harness {
    service: ChatService
    emitted: EmittedRecord[]
    telemetry: Array<{ name: string; attrs: Record<string, unknown> }>
    types: () => string[]
    statusRows: () => EmittedRecord[]
}

const makeHarness = (opts: {
    runtime: 'external' | 'sprites'
    framework: string
    resumeMessage?: (ctx: unknown) => AsyncIterable<EmittedChatEvent>
    converge?: () => AsyncIterable<EmittedChatEvent> | null
    transcript?: string
    emitThrowsOn?: string
    emitFenceLostOn?: string
    // The bounded durable transition ordinal. `null` makes the probe fail,
    // which is the other case the caller survives.
    resumeOrdinal?: number | null
}): Harness => {
    const emitted: EmittedRecord[] = []
    const telemetry: Array<{
        name: string
        attrs: Record<string, unknown>
    }> = []
    const agentRow = {
        id: 'agent-1',
        userId: 'user-1',
        framework: opts.framework,
        runtime: opts.runtime,
        runtimeId: 'runtime-1',
        model: 'claude-x',
        modelProviderId: null,
        modelProviderBuiltInId: null,
        daemonId: 'dh-1',
        spriteName: 'sprite-1',
        workspacePath: null
    }
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
        getSessionById: async () => sessionRow,
        getMessageById: async () => messageRow,
        getTurnExecution: async () =>
            executionRow({
                runtime: opts.runtime,
                state: 'running'
            }),
        maxStreamEventSeq: async () => 7,
        listStreamEventsSince: async () => [],
        listMessageSourceRows: async () => [],
        listForeignSourceUuids: async () => new Set<string>(),
        latestUserMessageBefore: async () => userMessageRow,
        touchSession: async () => undefined,
        upsertMessageSources: async (rows: unknown[]) => ({
            upserted: rows.length,
            fenceLost: false
        }),
        writeAssistantContent: async () => ({
            written: true,
            fenceLost: false
        }),
        releaseInflightTurn: async () => true,
        renewTurnLease: async () => true,
        handoffOwnedTurn: async () => true,
        claimTurnForResume: async () => ({
            outcome: 'claimed' as const,
            row: executionRow({
                runtime: opts.runtime,
                state: 'running'
            })
        }),
        daemonSeenWithin: async () => false,
        exactResumeSeqForMessage: async () => 0,
        safeResumeSeqForMessage: async () => 0,
        boundedResumeStatusOrdinal: async (
            _messageId: string,
            _sourceEventKey: string,
            maxOrdinal: number
        ) => {
            if (opts.resumeOrdinal === null)
                throw new Error('stream event probe unavailable')
            return Math.min(opts.resumeOrdinal ?? 0, maxOrdinal)
        }
    }
    const record = async (
        _messageId: string,
        event: EmittedRecord
    ): Promise<{ persisted: boolean; fenceLost: boolean }> => {
        if (opts.emitThrowsOn === event.type)
            throw new Error('stream write refused')
        if (opts.emitFenceLostOn === event.type)
            return { persisted: false, fenceLost: true }
        emitted.push({
            type: event.type,
            payload: event.payload,
            sourceEventKey: event.sourceEventKey ?? null,
            sourceEventOrdinal: event.sourceEventOrdinal ?? null
        })
        return { persisted: true, fenceLost: false }
    }
    const broadcaster = {
        hasStream: () => false,
        beginStream: () => undefined,
        setStreamFence: () => undefined,
        beginResumeStream: async () => undefined,
        endStream: () => undefined,
        emit: record,
        // The real broadcaster swallows a detached write's failure; a fake
        // that threw here would make the caller look responsible for it.
        emitDetached: async (messageId: string, event: EmittedRecord) => {
            await record(messageId, event).catch(() => undefined)
        }
    }
    const adapter = {
        framework: opts.framework,
        ...(opts.resumeMessage ? { resumeMessage: opts.resumeMessage } : {}),
        convergeTurn: () => (opts.converge ? opts.converge() : null)
    }
    const execDrivers = opts.transcript
        ? {
              recoveryFsForAgent: async () => ({
                  fs: {
                      locate: async () => '/w/.claude/projects/p/conv-1.jsonl',
                      readFile: async () => opts.transcript,
                      listFiles: async () => [],
                      readBinary: async () => null
                  },
                  spritesClient: null
              })
          }
        : undefined
    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => adapter } as never,
        { record: async () => undefined } as never,
        {} as never,
        { publishStatus: () => undefined } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) =>
                telemetry.push({ name, attrs }),
            error: () => {}
        } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        execDrivers as never,
        undefined,
        { emit: () => undefined } as never,
        {
            ownerId: 'instance-under-test',
            enabled: true,
            kick: () => {},
            stopClaiming: async () => undefined
        } as never
    )
    return {
        service,
        emitted,
        telemetry,
        types: () => emitted.map((e) => e.type),
        statusRows: () => emitted.filter((e) => e.type === 'turn_status')
    }
}

const streamOf = (...events: EmittedChatEvent[]) =>
    async function* (): AsyncIterable<EmittedChatEvent> {
        for (const event of events) yield event
    }

const serverRestartError = {
    type: 'error',
    error: {
        code: 'server_restart',
        message: 'stream interrupted by server restart',
        retryable: true
    }
} as EmittedChatEvent

// ---------------------------------------------------------------------------
// AC1: sprites adoption announces `recovering`
// ---------------------------------------------------------------------------

test('sprites adoption emits exactly one recovering row, keyed per attempt', async () => {
    const h = makeHarness({
        runtime: 'sprites',
        framework: 'claude-code',
        transcript: TRANSCRIPT
    })

    await h.service.adoptTurnExecution(
        executionRow({ runtime: 'sprites', spriteName: 'sprite-1' })
    )

    const status = h.statusRows()
    assert.equal(status.length, 1)
    assert.deepEqual(status[0].payload, {
        type: 'turn_status',
        phase: 'recovering'
    })
    // Per-phase key + adopt_count ordinal: concurrent adopters racing the same
    // claim collapse onto one row, and a `resuming` can never take the slot.
    assert.equal(status[0].sourceEventKey, '__turn_status_recovering__')
    assert.equal(status[0].sourceEventOrdinal, 1)

    // Announced before the rebuilt answer, and the turn still terminalizes the
    // way it always did: turn_status is additive, never a substitute.
    assert.equal(h.types()[0], 'turn_status')
    assert.equal(h.types().at(-1), 'done')
    assert.ok(
        h.emitted.some(
            (e) => e.type === 'token' && e.payload.text === 'the recovered tail'
        ),
        'the recovered content still reaches the client'
    )
})

test('a sprites turn with no transcript recovery announces nothing', async () => {
    // No execDrivers, so the adoptable branch is never taken. Announcing a
    // recovery this instance cannot perform would leave the user waiting on it.
    const h = makeHarness({ runtime: 'sprites', framework: 'claude-code' })

    await h.service.adoptTurnExecution(
        executionRow({ runtime: 'sprites', spriteName: 'sprite-1' })
    )

    assert.deepEqual(h.statusRows(), [])
    assert.deepEqual(h.types(), ['error'])
})

// ---------------------------------------------------------------------------
// AC2: external convergence announces `recovering` too
// ---------------------------------------------------------------------------

test('external convergence emits recovering under the same identity', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        converge: streamOf(
            {
                type: 'replace',
                text: 'the recovered answer',
                reason: 'upstream_converged'
            } as EmittedChatEvent,
            {
                type: 'done',
                finalMessageId: 'assistant-1'
            } as EmittedChatEvent
        )
    })

    await h.service.adoptTurnExecution(executionRow({ adoptCount: 3 }))

    assert.deepEqual(
        h.types(),
        ['turn_status', 'replace', 'done'],
        'announced before the converged answer, never after it'
    )
    const status = h.statusRows()
    assert.equal(status.length, 1)
    assert.equal(status[0].payload.phase, 'recovering')
    assert.equal(status[0].sourceEventKey, '__turn_status_recovering__')
    assert.equal(status[0].sourceEventOrdinal, 3)
})

// The case the feature exists for: a recovery that ultimately fails. The user
// used to get silence and then a retryable error; now the silence is explained.
test('a recovery that fails still announced itself first', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        converge: streamOf(serverRestartError)
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.deepEqual(h.types(), ['turn_status', 'error'])
    assert.equal(
        (h.emitted[1].payload as { error: { code: string } }).error.code,
        'server_restart'
    )
})

test('an unconvergeable external turn announces nothing it cannot do', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'langflow',
        converge: () => null
    })

    await h.service.adoptTurnExecution(
        executionRow({ upstreamTaskId: null, upstreamMessageId: null })
    )

    // No recovery is attempted, so claiming one would be a lie the user then
    // waits on. The pre-#670 retryable terminal is the whole output.
    assert.deepEqual(h.types(), ['error'])
})

// ---------------------------------------------------------------------------
// AC3: daemon resume announces `resuming`, once per re-dial
// ---------------------------------------------------------------------------

const resumeHarness = (resumeOrdinal?: number | null): Harness =>
    makeHarness({
        runtime: 'sprites',
        framework: 'codex',
        ...(resumeOrdinal === undefined ? {} : { resumeOrdinal }),
        resumeMessage: streamOf(
            { type: 'token', text: 'the rest of it' } as EmittedChatEvent,
            {
                type: 'done',
                finalMessageId: 'assistant-1'
            } as EmittedChatEvent
        )
    })

const resume = (h: Harness): Promise<unknown> =>
    h.service.resumeAssistantTurn({
        message: messageRow as never,
        daemonId: 'dh-1',
        refId: 'ref-1'
    })

test('daemon resume emits resuming before the resumed content', async () => {
    const h = resumeHarness()

    await resume(h)

    assert.deepEqual(h.types(), ['turn_status', 'token', 'done'])
    const status = h.statusRows()
    assert.equal(status.length, 1)
    assert.deepEqual(status[0].payload, {
        type: 'turn_status',
        phase: 'resuming'
    })
    assert.equal(status[0].sourceEventKey, '__turn_status_resuming__')
    // A turn with no durable suspension — an API-side restart that never got
    // to write one — has attempt index 0, the identity this always used.
    assert.equal(status[0].sourceEventOrdinal, 0)
})

// The gate #674 stayed open on. A durable suspension→resume transition advances
// the bounded ordinal without adding an unbounded identity. Pinning every
// resume to ordinal 0 meant the second re-dial's row hit the dedup index and the
// tab stayed on stale suspended presentation until the next real output.
test('each re-dial takes its durable transition ordinal', async () => {
    for (const [resumeOrdinal, expected] of [
        [1, 1],
        [2, 2],
        [4, 4]
    ] as const) {
        const h = resumeHarness(resumeOrdinal)

        await resume(h)

        const status = h.statusRows()
        assert.equal(status.length, 1)
        assert.equal(status[0].sourceEventKey, '__turn_status_resuming__')
        assert.equal(
            status[0].sourceEventOrdinal,
            expected,
            `transition ${resumeOrdinal} should resume under ordinal ${expected}`
        )
    }
})

test('a flapping daemon cannot grow the log without bound', async () => {
    // Past the cap the phase degrades to the old behaviour — the last
    // reachable ordinal, deduped — which loses a label, never content. #672
    // is the constraint this pays: informational rows must stay bounded.
    for (const resumeOrdinal of [5, 9, 400]) {
        const h = resumeHarness(resumeOrdinal)

        await resume(h)

        assert.equal(h.statusRows()[0].sourceEventOrdinal, 4)
    }
})

test('a failed attempt probe skips only the announcement', async () => {
    const h = resumeHarness(null)

    await resume(h)

    assert.equal(h.statusRows().length, 0)
    assert.deepEqual(h.types(), ['token', 'done'])
})

test('a resume the adapter cannot serve announces nothing', async () => {
    const h = makeHarness({ runtime: 'sprites', framework: 'codex' })

    await h.service.resumeAssistantTurn({
        message: messageRow as never,
        daemonId: 'dh-1',
        refId: 'ref-1'
    })

    // A sprite turn is handed back to transcript adoption, which can still
    // recover it; neither a recovery announcement nor a false terminal lands.
    assert.deepEqual(h.types(), [])
})

// ---------------------------------------------------------------------------
// Best-effort: the recovery is the valuable work, not the announcement
// ---------------------------------------------------------------------------

test('an announcement that fails to write does not break the recovery', async () => {
    const h = makeHarness({
        runtime: 'external',
        framework: 'dify',
        emitThrowsOn: 'turn_status',
        converge: streamOf({
            type: 'done',
            finalMessageId: 'assistant-1'
        } as EmittedChatEvent)
    })

    await h.service.adoptTurnExecution(executionRow())

    assert.deepEqual(h.statusRows(), [])
    assert.deepEqual(h.types(), ['done'], 'the converged answer still lands')
})

test('a fenced-out announcement stops before attaching the resume transport', async () => {
    let attached = 0
    const h = makeHarness({
        runtime: 'sprites',
        framework: 'codex',
        emitFenceLostOn: 'turn_status',
        resumeMessage: async function* () {
            attached += 1
            yield {
                type: 'done',
                finalMessageId: 'assistant-1'
            } as EmittedChatEvent
        }
    })

    const outcome = await resume(h)

    assert.equal(outcome, 'handled')
    assert.equal(attached, 0)
    assert.deepEqual(h.types(), [])
    assert.equal(
        h.telemetry.filter((event) => event.name === 'chat.turn.resume').at(-1)
            ?.attrs.outcome,
        'fenced_out'
    )
})

// ---------------------------------------------------------------------------
// AC4/AC5: not terminal, and bounded — proved against the REAL broadcaster and
// a repo fake that models the real dedup index and terminal chokepoint, because
// "is it terminal" is a property of those, not of a fake that agrees with me.
// ---------------------------------------------------------------------------

interface StreamRow {
    id: bigint
    sessionId: string
    messageId: string
    seq: number
    eventType: PersistedStreamEventType
    payloadJson: unknown
    sourceEventKey: string | null
    sourceEventOrdinal: number | null
}

const makeRealBroadcaster = (): {
    broadcaster: ChatSseBroadcaster
    rows: StreamRow[]
    inflight: { messageId: string | null }
    delivered: ChatStreamEvent[]
} => {
    const rows: StreamRow[] = []
    const inflight = { messageId: 'message-1' as string | null }
    const delivered: ChatStreamEvent[] = []
    const repo = {
        // Models insertStreamEvent: the (message, key, ordinal) unique index
        // no-ops a duplicate, and the terminal chokepoint — and ONLY the
        // terminal chokepoint — releases the session's inflight claim.
        insertStreamEvent: async (row: Omit<StreamRow, 'id'>) => {
            if (
                row.sourceEventKey !== null &&
                rows.some(
                    (r) =>
                        r.messageId === row.messageId &&
                        r.sourceEventKey === row.sourceEventKey &&
                        r.sourceEventOrdinal === row.sourceEventOrdinal
                )
            )
                return { id: null }
            const id = 100n + BigInt(rows.length)
            rows.push({ ...row, id })
            if (row.eventType === 'done' || row.eventType === 'error')
                inflight.messageId = null
            return { id }
        },
        maxStreamEventSeq: async (messageId: string) =>
            rows.reduce(
                (max, row) =>
                    row.messageId === messageId && row.seq > max
                        ? row.seq
                        : max,
                0
            ),
        latestInflightMessageId: async () => inflight.messageId,
        minStreamEventId: async () => null,
        maxSessionStreamEventId: async () => 0n,
        streamAttachAnchor: async () => ({
            inflightMessageId: inflight.messageId,
            maxEventId: rows.reduce(
                (max, row) => (row.id > max ? row.id : max),
                0n
            )
        }),
        streamReplayCursor: async (sessionId: string, messageId: string) => {
            const messageRows = rows.filter(
                (row) =>
                    row.sessionId === sessionId && row.messageId === messageId
            )
            if (messageRows.length > 0) {
                let messageMin = messageRows[0].id
                for (const row of messageRows)
                    if (row.id < messageMin) messageMin = row.id
                return messageMin - 1n
            }
            return rows.reduce(
                (max, row) =>
                    row.sessionId === sessionId && row.id > max ? row.id : max,
                0n
            )
        },
        listSessionStreamEventsSince: async (
            sessionId: string,
            afterId: bigint,
            limit: number
        ) =>
            rows
                .filter(
                    (row) => row.sessionId === sessionId && row.id > afterId
                )
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .slice(0, limit)
                .map((row) => ({ ...row, createdAt: new Date(0) }))
    }
    const bus = {
        onMessage: () => undefined,
        onListenEstablished: () => undefined,
        notify: () => undefined
    }
    const broadcaster = new ChatSseBroadcaster(
        repo as never,
        bus as unknown as ChatStreamBus
    )
    return { broadcaster, rows, inflight, delivered }
}

const emitStatus = (
    broadcaster: ChatSseBroadcaster,
    phase: 'recovering' | 'resuming',
    ordinal: number
): Promise<{ persisted: boolean }> =>
    broadcaster.emit('message-1', {
        type: 'turn_status',
        payload: { type: 'turn_status', phase },
        sourceEventKey: `__turn_status_${phase}__`,
        sourceEventOrdinal: ordinal
    })

test('turn_status is not terminal: the stream stays open and the claim is held', async (t) => {
    const h = makeRealBroadcaster()
    t.after(() => h.broadcaster.onModuleDestroy())
    h.broadcaster.beginStream('session-1', 'message-1')

    const status = await emitStatus(h.broadcaster, 'recovering', 1)
    assert.equal(status.persisted, true)

    // The real broadcaster deletes an ended stream and drops everything after
    // it, so a stream that still accepts content is the direct proof.
    assert.equal(h.broadcaster.hasStream('message-1'), true)
    const after = await h.broadcaster.emit('message-1', {
        type: 'replace',
        payload: { type: 'replace', text: 'recovered', reason: 'converged' }
    })
    assert.equal(after.persisted, true)
    // The per-session turn lock is released by the done/error chokepoint alone.
    assert.equal(h.inflight.messageId, 'message-1')

    await h.broadcaster.emit('message-1', {
        type: 'done',
        payload: { type: 'done', finalMessageId: 'message-1' }
    })
    assert.equal(h.broadcaster.hasStream('message-1'), false)
    assert.equal(h.inflight.messageId, null)
})

test('turn_status takes a seq after the resumed watermark, never rewinding it', async (t) => {
    const h = makeRealBroadcaster()
    t.after(() => h.broadcaster.onModuleDestroy())
    h.rows.push({
        id: 99n,
        sessionId: 'session-1',
        messageId: 'message-1',
        seq: 7,
        eventType: 'token',
        payloadJson: { text: 'before the crash' },
        sourceEventKey: null,
        sourceEventOrdinal: null
    })

    await h.broadcaster.beginResumeStream('session-1', 'message-1')
    await emitStatus(h.broadcaster, 'recovering', 1)

    const written = h.rows.find((row) => row.eventType === 'turn_status')
    assert.ok(written)
    assert.equal(written.seq, 8, 'continues the turn, does not collide with it')
    assert.equal(written.sourceEventKey, '__turn_status_recovering__')
})

test('retries stay visible per attempt and bounded by adopt_count', async (t) => {
    const h = makeRealBroadcaster()
    t.after(() => h.broadcaster.onModuleDestroy())
    h.broadcaster.beginStream('session-1', 'message-1')

    // Two adopters racing the SAME claim: one row. The loser's insert no-ops on
    // the dedup index, and `persisted` reports it honestly.
    const first = await emitStatus(h.broadcaster, 'recovering', 1)
    const racer = await emitStatus(h.broadcaster, 'recovering', 1)
    assert.equal(first.persisted, true)
    assert.equal(racer.persisted, false)

    // A genuine retry (adopt_count bumped by claimTurnForAdoption) is a new
    // row: a second "recovering" after silence is real signal, not noise.
    const retry = await emitStatus(h.broadcaster, 'recovering', 2)
    assert.equal(retry.persisted, true)

    // A resume on the same turn cannot be swallowed by, or swallow, either of
    // them — that is what the per-phase key buys.
    const resuming = await emitStatus(h.broadcaster, 'resuming', 0)
    assert.equal(resuming.persisted, true)
    // Two instances answering the SAME suspension derive the same attempt index
    // and collapse, exactly like the adopters above. #570 is untouched by this.
    const resumingAgain = await emitStatus(h.broadcaster, 'resuming', 0)
    assert.equal(resumingAgain.persisted, false)

    assert.deepEqual(
        h.rows
            .filter((row) => row.eventType === 'turn_status')
            .map((row) => [row.sourceEventKey, row.sourceEventOrdinal]),
        [
            ['__turn_status_recovering__', 1],
            ['__turn_status_recovering__', 2],
            ['__turn_status_resuming__', 0]
        ]
    )
})

// The staging sequence, replayed through the real dedup index: a daemon that
// drops twice must announce twice. Under the old pinned ordinal 0 the second
// announcement no-opped, so the tab sat on stale "waiting for this device"
// presentation until the resumed content arrived.
test('a second re-dial announces instead of colliding with the first', async (t) => {
    const h = makeRealBroadcaster()
    t.after(() => h.broadcaster.onModuleDestroy())
    h.broadcaster.beginStream('session-1', 'message-1')

    const suspend = () =>
        h.broadcaster.emit('message-1', {
            type: 'suspended',
            payload: { type: 'suspended', reason: 'daemon offline' }
        })

    await h.broadcaster.emit('message-1', {
        type: 'token',
        payload: { type: 'token', text: 'partial ' }
    })
    await suspend()
    const firstResume = await emitStatus(h.broadcaster, 'resuming', 1)
    await suspend()
    const secondResume = await emitStatus(h.broadcaster, 'resuming', 2)

    assert.equal(firstResume.persisted, true)
    assert.equal(secondResume.persisted, true)

    await h.broadcaster.emit('message-1', {
        type: 'done',
        payload: { type: 'done', finalMessageId: 'message-1' }
    })

    // With distinct identities no row is intentionally deduped in this ladder,
    // so seq is contiguous and increasing. A duplicate may consume an in-memory
    // seq and leave a harmless hole; SSE replay is ordered by durable row id.
    assert.deepEqual(
        h.rows.map((row) => [row.eventType, row.seq]),
        [
            ['token', 1],
            ['suspended', 2],
            ['turn_status', 3],
            ['suspended', 4],
            ['turn_status', 5],
            ['done', 6]
        ]
    )
    assert.equal(h.inflight.messageId, null, 'still terminalized exactly once')
})

test('turn_status reaches a subscriber as its own SSE event type', async (t) => {
    const h = makeRealBroadcaster()
    t.after(() => h.broadcaster.onModuleDestroy())
    await h.broadcaster.subscribe(
        'session-1',
        { send: (event) => h.delivered.push(event), close: () => undefined },
        null
    )
    h.broadcaster.beginStream('session-1', 'message-1')
    await emitStatus(h.broadcaster, 'recovering', 1)

    const deadline = Date.now() + 2_000
    while (h.delivered.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5))

    assert.equal(h.delivered.length, 1)
    const event = h.delivered[0]
    assert.equal(event.type, 'turn_status')
    assert.equal(event.messageId, 'message-1')
    // The pump materializes the payload onto the wire envelope, so the phase a
    // client reads is the phase the service wrote.
    assert.equal((event as unknown as { phase: string }).phase, 'recovering')
})
