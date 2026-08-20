import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatService } from '../src/modules/chat/chat.service'
import type {
    EmittedChatEvent,
    RawMessageSourcePayload
} from '../src/modules/chat/chat-adapter'
import { buildChatMessageSourceRow } from '../src/modules/chat/raw-message-source'

// #544: a resumed turn terminalizes through runAdapterFromIterable, which used
// to return only { suspended } — so the turn wrote a durable done/error row and
// then reported `chat.turn.resume outcome=converged` with no
// `chat.turn.terminal` at all. A staging window with 2 durable failures showed
// 79 terminal records, every one of them `done`. These tests pin the funnel to
// the durable truth: one terminal telemetry event per persisted terminal row,
// carrying the real outcome.

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

const agentRow = {
    framework: 'codex',
    runtime: 'sprites',
    runtimeId: 'rt-1',
    model: 'gpt-5-codex',
    modelProviderId: 'provider-1',
    modelProviderBuiltInId: null,
    modelProviderSource: 'managed',
    managedBrand: 'openai',
    inferenceProtocol: 'openai_responses',
    daemonId: 'dh-1',
    spriteName: null,
    workspacePath: null
}

// The turn started well before the resume: durationMs must be measured from
// here, not from the resume handler's own clock.
const TURN_AGE_MS = 60_000

const messageRow = {
    id: 'msg-1',
    sessionId: 'session-1',
    daemonId: 'dh-1',
    daemonExecRef: 'ref-1',
    cancelRequestedAt: null,
    abortDispatchedAt: null,
    createdAt: new Date(Date.now() - TURN_AGE_MS)
}

interface EmittedRecord {
    messageId: string
    type: string
    payload: Record<string, unknown>
    terminalContent?: {
        contentBlocksJson: unknown[]
        contentCheckpointEventId: bigint | null
    }
}

interface TelemetryRecord {
    name: string
    props: Record<string, unknown>
}

interface Harness {
    service: ChatService
    telemetry: TelemetryRecord[]
    durable: EmittedRecord[]
    endedStreams: string[]
    released: string[]
    handedOff: number[]
    appEvents: string[]
    setPersisted: (persisted: boolean) => void
    controllerFor: (messageId: string) => AbortController | undefined
    named: (name: string) => TelemetryRecord[]
}

const makeHarness = (
    resumeMessage:
        | ((ctx: unknown) => AsyncIterable<EmittedChatEvent>)
        | null = null,
    managedProbe = false,
    opts: {
        agent?: typeof agentRow
        streamEvents?: Array<{
            eventType: string
            payloadJson: unknown
            sourceEventKey: string | null
            sourceEventOrdinal: number | null
        }>
    } = {}
): Harness => {
    const telemetry: TelemetryRecord[] = []
    const durable: EmittedRecord[] = []
    const endedStreams: string[] = []
    const released: string[] = []
    const handedOff: number[] = []
    const appEvents: string[] = []
    const persistedState = { value: true }

    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: () => ({
                        limit: async () => [opts.agent ?? agentRow]
                    })
                })
            })
        }),
        update: () => ({
            set: () => ({
                where: async () => undefined
            })
        })
    }
    const repo = {
        writeAssistantContent: async () => ({
            written: true,
            fenceLost: false
        }),
        getSessionById: async () => sessionRow,
        getMessageById: async () => messageRow,
        listContentStreamEvents: async () => [],
        getTurnExecution: async () => ({
            messageId: 'msg-1',
            sessionId: 'session-1',
            agentId: 'agent-1',
            runtime: 'sprites' as const,
            ownerId: 'owner-0',
            generation: 1,
            leaseExpiresAt: new Date(0),
            state: 'handoff' as const
        }),
        claimTurnForResume: async () => ({
            outcome: 'claimed' as const,
            row: {
                messageId: 'msg-1',
                sessionId: 'session-1',
                agentId: 'agent-1',
                runtime: (opts.agent?.runtime ?? 'sprites') as
                    | 'sprites'
                    | 'daemon',
                ownerId: 'owner-1',
                generation: 2,
                leaseExpiresAt: new Date(Date.now() + 90_000),
                state: 'running' as const
            }
        }),
        claimTurnForReconciliation: async () => ({
            messageId: 'msg-1',
            sessionId: 'session-1',
            agentId: 'agent-1',
            runtime: 'sprites' as const,
            ownerId: 'owner-1',
            generation: 2,
            leaseExpiresAt: new Date(Date.now() + 90_000),
            state: 'adopting' as const
        }),
        renewTurnLease: async () => true,
        handoffOwnedTurn: async (
            _messageId: string,
            _ownerId: string,
            generation: number
        ) => {
            handedOff.push(generation)
            return true
        },
        maxStreamEventSeq: async () => 0,
        boundedResumeStatusOrdinal: async () => 0,
        touchSession: async () => {},
        upsertMessageSources: async () => ({
            upserted: 1,
            fenceLost: false
        }),
        listStreamEventsSince: async () => opts.streamEvents ?? [],
        releaseInflightTurn: async (_sessionId: string, messageId: string) => {
            released.push(messageId)
        }
    }
    const record = async (
        messageId: string,
        event: { type: string; payload: Record<string, unknown> },
        terminalContent?: {
            contentBlocksJson: unknown[]
            contentCheckpointEventId: bigint | null
        }
    ): Promise<{ persisted: boolean; fenceLost: boolean }> => {
        durable.push({
            messageId,
            type: event.type,
            payload: event.payload,
            ...(terminalContent ? { terminalContent } : {})
        })
        return { persisted: persistedState.value, fenceLost: false }
    }
    const broadcaster = {
        hasStream: () => false,
        beginStream: () => {},
        setStreamFence: () => undefined,
        beginResumeStream: async () => {},
        emit: record,
        emitDetached: record,
        endStream: (messageId: string) => {
            endedStreams.push(messageId)
        }
    }
    const adapters = {
        get: () => (resumeMessage ? { resumeMessage } : {})
    }

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        { record: async () => {} } as never,
        {} as never,
        {} as never,
        {
            event: (name: string, props: Record<string, unknown>) =>
                telemetry.push({ name, props }),
            error: (
                name: string,
                _err: Error,
                props: Record<string, unknown>
            ) => telemetry.push({ name, props })
        } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { emit: (name: string) => appEvents.push(name) } as never,
        { ownerId: 'owner-1', enabled: true } as never,
        undefined,
        undefined,
        managedProbe
            ? ({
                  ownedProbeAdmission: async () => ({
                      scope: 'antigravity',
                      brand: 'antigravity',
                      decision: 'probe',
                      state: 'half_open',
                      retryAt: null,
                      turnId: 'msg-1'
                  }),
                  recordSuccess: async () =>
                      telemetry.push({
                          name: 'breaker.settle',
                          props: { outcome: 'success' }
                      }),
                  recordPoolExhaustion: async () =>
                      telemetry.push({
                          name: 'breaker.settle',
                          props: { outcome: 'pool_exhaustion' }
                      }),
                  recordInconclusive: async (
                      _admission: unknown,
                      reason: string
                  ) =>
                      telemetry.push({
                          name: 'breaker.settle',
                          props: { outcome: 'inconclusive', reason }
                      })
              } as never)
            : undefined
    )

    return {
        service,
        telemetry,
        durable,
        endedStreams,
        released,
        handedOff,
        appEvents,
        setPersisted: (persisted) => {
            persistedState.value = persisted
        },
        controllerFor: (messageId) =>
            (
                service as unknown as {
                    runningAdapters: Map<string, AbortController>
                }
            ).runningAdapters.get(messageId),
        named: (name) => telemetry.filter((e) => e.name === name)
    }
}

const resume = (
    harness: Harness
): ReturnType<ChatService['resumeAssistantTurn']> =>
    harness.service.resumeAssistantTurn({
        message: messageRow as never,
        daemonId: 'dh-1',
        refId: 'ref-1'
    })

const streamOf = (...events: EmittedChatEvent[]) =>
    async function* (): AsyncIterable<EmittedChatEvent> {
        for (const event of events) yield event
    }

const token = (text: string): EmittedChatEvent =>
    ({ type: 'token', text }) as EmittedChatEvent

const errorEvent = (
    code: string,
    retryable = true,
    managedChannelFailure = false
): EmittedChatEvent =>
    ({
        type: 'error',
        ...(managedChannelFailure
            ? { managedChannelFailure: 'account_pool_empty' }
            : {}),
        error: { code, message: `${code} happened`, retryable }
    }) as EmittedChatEvent

test('resume that converges to done emits exactly one done terminal', async () => {
    const harness = makeHarness(
        streamOf(
            token('hello'),
            {
                type: 'usage',
                usage: { inputTokens: 5, outputTokens: 7 }
            } as EmittedChatEvent,
            { type: 'done', finalMessageId: 'msg-1' } as EmittedChatEvent
        )
    )
    await resume(harness)

    const terminals = harness.named('chat.turn.terminal')
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].props.outcome, 'done')
    assert.equal(terminals[0].props.assistantMessageId, 'msg-1')
    assert.equal(terminals[0].props.resumed, true)
    assert.equal(terminals[0].props.via, 'resume')
    assert.equal(terminals[0].props.errorCode, undefined)

    // Duration is anchored on the durable message row, so it covers the whole
    // turn the user waited through — suspension gap included.
    assert.ok((terminals[0].props.durationMs as number) >= TURN_AGE_MS)

    // A resumed turn never observed setup/dispatch/first-token; those fields
    // stay absent rather than being invented.
    for (const absent of [
        'setupMs',
        'dispatchMs',
        'execToFirstStdoutMs',
        'firstTokenMs'
    ])
        assert.ok(!(absent in terminals[0].props), `${absent} must be absent`)

    const completes = harness.named('chat.stream.complete')
    assert.equal(completes.length, 1)
    assert.equal(completes[0].props.tokensIn, 5)
    assert.equal(completes[0].props.tokensOut, 7)

    const resumes = harness.named('chat.turn.resume')
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].props.outcome, 'done')

    assert.ok(harness.appEvents.includes('chat.turn.finalized'))
    assert.equal(harness.durable.at(-1)?.type, 'done')
})

test('resume that ends in an error reports error, never converged', async () => {
    const harness = makeHarness(
        streamOf(token('partial'), errorEvent('codex_exec_failed'))
    )
    await resume(harness)

    const terminals = harness.named('chat.turn.terminal')
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].props.outcome, 'error')
    assert.equal(terminals[0].props.errorCode, 'codex_exec_failed')

    assert.equal(harness.named('chat.stream.error').length, 1)
    assert.equal(harness.named('chat.stream.complete').length, 0)

    const resumes = harness.named('chat.turn.resume')
    assert.equal(resumes[0].props.outcome, 'error')
    assert.equal(resumes[0].props.errorCode, 'codex_exec_failed')

    // The exact staging symptom: a durably-failed turn reported as converged.
    assert.equal(JSON.stringify(harness.telemetry).includes('converged'), false)
    assert.equal(harness.durable.at(-1)?.type, 'error')
})

test('resume cancelled by the user stays out of the error funnel', async () => {
    const harness = makeHarness(
        streamOf(token('partial'), errorEvent('cancelled_by_user', false))
    )
    await resume(harness)

    const terminals = harness.named('chat.turn.terminal')
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].props.outcome, 'cancelled')
    assert.equal(terminals[0].props.errorCode, 'cancelled_by_user')

    assert.equal(harness.named('chat.stream.error').length, 0)
    assert.equal(
        harness.named('chat.turn.resume')[0].props.outcome,
        'cancelled'
    )
})

test('a turn that suspends again emits no terminal, and the next resume emits exactly one', async () => {
    const harness = makeHarness(
        streamOf(token('partial'), {
            type: 'suspended',
            daemonId: 'dh-1',
            daemonExecRef: 'ref-1',
            reason: 'connection closed'
        } as EmittedChatEvent)
    )
    await resume(harness)

    assert.equal(harness.named('chat.turn.terminal').length, 0)
    assert.equal(harness.named('chat.stream.complete').length, 0)
    assert.equal(
        harness.named('chat.turn.resume')[0].props.outcome,
        'suspended_again'
    )
    assert.ok(harness.endedStreams.includes('msg-1'))
    assert.deepEqual(harness.handedOff, [2])
    assert.equal(harness.appEvents.length, 0)

    const second = makeHarness(
        streamOf({
            type: 'done',
            finalMessageId: 'msg-1'
        } as EmittedChatEvent)
    )
    await resume(second)
    assert.equal(second.named('chat.turn.terminal').length, 1)
    assert.equal(second.named('chat.turn.terminal')[0].props.outcome, 'done')
})

test('a resumed terminal settles a probe only after its durable terminal', async () => {
    const harness = makeHarness(
        streamOf({
            type: 'done',
            finalMessageId: 'msg-1'
        } as EmittedChatEvent),
        true
    )
    await resume(harness)

    assert.equal(harness.named('breaker.settle').length, 1)
    assert.equal(harness.named('breaker.settle')[0].props.outcome, 'success')
    assert.equal(harness.durable.at(-1)?.type, 'done')
})

test('a resumed adapter-owned exhaustion reopens its probe without persisting the marker', async () => {
    const harness = makeHarness(
        streamOf(errorEvent('codex_exec_failed', false, true)),
        true
    )
    await resume(harness)

    assert.deepEqual(harness.named('breaker.settle'), [
        { name: 'breaker.settle', props: { outcome: 'pool_exhaustion' } }
    ])
    assert.equal(harness.durable.at(-1)?.type, 'error')
    assert.equal(
        'managedChannelFailure' in (harness.durable.at(-1)?.payload ?? {}),
        false
    )
})

test('a resume whose stream throws terminalizes nothing and claims no terminal', async () => {
    const harness = makeHarness(async function* () {
        yield token('partial')
        throw new Error('daemon vanished')
    })
    await resume(harness)

    // Nothing was terminalized, so claiming a terminal would break the 1:1
    // parity with chat_stream_events. The eventual converging writer emits it.
    assert.equal(harness.named('chat.turn.terminal').length, 0)
    assert.equal(harness.named('chat.stream.complete').length, 0)
    assert.deepEqual(harness.released, [])
    assert.deepEqual(harness.handedOff, [2])

    const resumes = harness.named('chat.turn.resume')
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].props.outcome, 'failed')
})

test('a stream that stops silently while aborted terminalizes as cancelled, not done', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const harness = makeHarness(async function* () {
        yield token('partial')
        await gate
    })
    const running = resume(harness)
    // Wait for the first token to be consumed so the adapter is tracked.
    await new Promise((resolve) => setTimeout(resolve, 10))
    harness.controllerFor('msg-1')?.abort()
    const releaseGate = release as (() => void) | null
    releaseGate?.()
    await running

    assert.equal(harness.durable.at(-1)?.type, 'error')
    assert.equal(
        (harness.durable.at(-1)?.payload as { error: { code: string } }).error
            .code,
        'cancelled_by_user'
    )
    const terminals = harness.named('chat.turn.terminal')
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].props.outcome, 'cancelled')
})

test('a terminal deduped away durably emits no terminal telemetry', async () => {
    const harness = makeHarness(
        streamOf({ type: 'done', finalMessageId: 'msg-1' } as EmittedChatEvent)
    )
    harness.setPersisted(false)
    await resume(harness)

    // An adopted replay can re-derive a terminal the dead relay already wrote;
    // insertStreamEvent drops it on the dedup key. Reporting it would count the
    // same turn twice.
    assert.equal(harness.named('chat.turn.terminal').length, 0)
    assert.equal(harness.named('chat.stream.complete').length, 0)
})

test('openclaw full replay rebuilds content without rewriting a durable source event', async () => {
    const source: RawMessageSourcePayload = {
        sourceRef: 'openclaw-session-1',
        sourceSeq: 1,
        externalId: 'ref-1-stdout',
        parentExternalId: null,
        rawFormat: 'jsonl',
        rawText: '{"type":"text","text":"hello"}\n',
        parserName: 'openclaw-cli-json',
        parserVersion: '1'
    }
    const sourceEventKey = buildChatMessageSourceRow({
        sourceKind: 'live_stream',
        sessionId: 'session-1',
        messageId: 'msg-1',
        framework: 'openclaw',
        runtime: 'daemon',
        source
    }).sourceEventKey
    const harness = makeHarness(
        streamOf({ type: 'raw_source', source }, token('hello'), {
            type: 'done',
            finalMessageId: 'msg-1'
        } as EmittedChatEvent),
        false,
        {
            agent: {
                ...agentRow,
                framework: 'openclaw',
                runtime: 'daemon'
            },
            streamEvents: [
                {
                    eventType: 'token',
                    payloadJson: { type: 'token', text: 'hello' },
                    sourceEventKey,
                    sourceEventOrdinal: 0
                }
            ]
        }
    )

    await resume(harness)

    assert.equal(
        harness.durable.filter((event) => event.type === 'token').length,
        0
    )
    assert.deepEqual(harness.durable.at(-1)?.terminalContent, {
        contentBlocksJson: [{ type: 'text', text: 'hello' }],
        contentCheckpointEventId: null
    })
    assert.equal(harness.durable.at(-1)?.type, 'done')
})

test('openclaw full replay fails closed when a durable ordinal changes', async () => {
    const source: RawMessageSourcePayload = {
        sourceRef: 'openclaw-session-1',
        sourceSeq: 1,
        rawFormat: 'jsonl',
        rawText: '{"type":"text","text":"changed"}\n',
        parserName: 'openclaw-cli-json',
        parserVersion: '1'
    }
    const sourceEventKey = buildChatMessageSourceRow({
        sourceKind: 'live_stream',
        sessionId: 'session-1',
        messageId: 'msg-1',
        framework: 'openclaw',
        runtime: 'daemon',
        source
    }).sourceEventKey
    const harness = makeHarness(
        streamOf({ type: 'raw_source', source }, token('changed')),
        false,
        {
            agent: {
                ...agentRow,
                framework: 'openclaw',
                runtime: 'daemon'
            },
            streamEvents: [
                {
                    eventType: 'token',
                    payloadJson: { type: 'token', text: 'original' },
                    sourceEventKey,
                    sourceEventOrdinal: 0
                }
            ]
        }
    )

    await resume(harness)

    assert.equal(harness.durable.length, 1)
    assert.equal(harness.durable[0].type, 'turn_status')
    assert.deepEqual(harness.released, [])
    assert.deepEqual(harness.handedOff, [2])
    assert.equal(harness.named('chat.turn.resume')[0].props.outcome, 'failed')
})

test('an unsupported-resume terminal is reported like any other', async () => {
    const harness = makeHarness(null, false, {
        agent: { ...agentRow, runtime: 'daemon' }
    })
    await resume(harness)

    const terminals = harness.named('chat.turn.terminal')
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].props.outcome, 'error')
    assert.equal(terminals[0].props.errorCode, 'resume_unsupported')
    assert.equal(terminals[0].props.via, 'resume_unsupported')
    assert.equal(harness.durable.at(-1)?.type, 'error')
})

test('an offline cancel reports cancelled, and a give-up reports server_restart', async () => {
    const cancelled = makeHarness(null)
    await cancelled.service.completeOfflineCancel({
        message: messageRow as never,
        daemonId: 'dh-1',
        refId: 'ref-1'
    })
    const cancelTerminals = cancelled.named('chat.turn.terminal')
    assert.equal(cancelTerminals.length, 1)
    assert.equal(cancelTerminals[0].props.outcome, 'cancelled')
    assert.equal(cancelTerminals[0].props.via, 'offline_cancel')
    assert.equal(cancelled.named('chat.stream.error').length, 0)

    const restarted = makeHarness(null)
    await restarted.service.terminalizeAdoptedTurn({
        messageId: 'msg-1',
        sessionId: 'session-1'
    } as never)
    const restartTerminals = restarted.named('chat.turn.terminal')
    assert.equal(restartTerminals.length, 1)
    assert.equal(restartTerminals[0].props.outcome, 'error')
    assert.equal(restartTerminals[0].props.errorCode, 'server_restart')
    assert.equal(restartTerminals[0].props.via, 'restart_terminal')
    // Reconciliation writes stay out of chat.stream.error: a deploy wave of
    // them would trip the burst monitor.
    assert.equal(restarted.named('chat.stream.error').length, 0)
})
