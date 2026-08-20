import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadGatewayException,
    BadRequestException,
    ForbiddenException,
    ServiceUnavailableException,
    UnauthorizedException
} from '@nestjs/common'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'
import { buildTelemetryCaptureOptions } from '../src/sentry-grouping'

// #786. Four different places in ChatService write `chat.stream.error`, and
// each used to assemble its own attributes — so a failed turn reported a
// different thing depending on which one caught it, and Sentry, grouping on
// the ChatService frame all four rebuild their Error at, could not tell a dead
// daemon from an exhausted account.
//
// These drive the real dispatch, stream and resume paths over fake
// infrastructure and then feed what each one emitted through the SAME builder
// production hands Sentry (captureTelemetryError does nothing else with it).
// That is the whole composition minus TelemetryService, which cannot appear
// here: it imports ../src/sentry, whose Sentry.init runs on import.

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    runtimeId: 'runtime-1',
    model: null
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

const BOUND_MS = 4_000

// The attribute names this fix makes every path agree on. A path that stops
// carrying one of them is the regression.
const SCHEMA_KEYS = [
    'sessionId',
    'agentId',
    'framework',
    'assistantMessageId',
    'runtimeKind',
    'turnPhase'
]

const BALANCE_MESSAGE =
    'Failed to authenticate. API Error: 403 Insufficient account balance'

interface StreamErrorRecord {
    err: Error
    attrs: Record<string, unknown>
}

const waitFor = async (
    predicate: () => boolean,
    ms = BOUND_MS
): Promise<void> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(predicate(), `condition was not met within ${ms}ms`)
}

const waitBounded = async (promise: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `adapter did not finish within ${BOUND_MS}ms`
                            )
                        ),
                    BOUND_MS
                )
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const sentryOptionsFor = (
    record: StreamErrorRecord
): ReturnType<typeof buildTelemetryCaptureOptions> =>
    buildTelemetryCaptureOptions('chat.stream.error', record.attrs)

test('a dispatch rejection names its unknown runtime instead of inventing one', async () => {
    const harness = makeHarness()
    await harness.dispatchRejectingWith(
        new ServiceUnavailableException({
            code: 'service_restarting',
            message: 'api instance is draining after an invalid api key alert'
        })
    )

    const [record] = harness.streamErrors
    assert.equal(harness.streamErrors.length, 1)
    assert.equal(record.attrs.turnPhase, 'dispatch')
    // The framework IS known here — the turn was dispatched with it — and the
    // runtime is not, because resolveAgentContext is one of the things that
    // can throw into this catch. Absent would be ambiguous; a real runtime
    // would be a fabrication on a dashboard operators route by.
    assert.equal(record.attrs.framework, 'claude-code')
    assert.equal(record.attrs.runtimeKind, 'unknown')
    // Typed HttpException bodies keep the code web/CLI already key off.
    assert.equal(record.attrs.errorCode, 'service_restarting')
    assert.ok(!('cause' in record.attrs))
    // No durable ChatError was written, so there is no retryable flag to read
    // and none is guessed.
    assert.ok(!('retryable' in record.attrs))
    // Fields this path never carried stay absent, so the Axiom shape is
    // unchanged for everything that already queried it.
    assert.ok(!('userId' in record.attrs))
    assert.ok(!('durationMs' in record.attrs))

    assert.equal(
        sentryOptionsFor(record).tags['nca.chat_runtime_kind'],
        'unknown'
    )
})

test('untyped HTTP dispatch errors classify only the status wording that identifies a cause', async () => {
    const cases: readonly [Error, string | null][] = [
        [new UnauthorizedException(), 'auth_invalid'],
        [new BadRequestException(), 'invalid_request'],
        [new ForbiddenException(), null],
        [new BadGatewayException(), null]
    ]
    for (const [err, expected] of cases) {
        const harness = makeHarness()
        await harness.dispatchRejectingWith(err)

        const [record] = harness.streamErrors
        assert.ok(!('errorCode' in record.attrs))
        if (expected === null) assert.ok(!('cause' in record.attrs))
        else assert.equal(record.attrs.cause, expected)
    }
})

test('a live stream failure carries the durable code, its retryable flag and the cause', async () => {
    const harness = makeHarness({
        script: [errorEvent('claude_result_error', BALANCE_MESSAGE)]
    })
    await harness.send()

    const [record] = harness.streamErrors
    assert.equal(harness.streamErrors.length, 1)
    assert.equal(record.attrs.turnPhase, 'stream')
    assert.equal(record.attrs.errorCode, 'claude_result_error')
    assert.equal(record.attrs.retryable, true)
    assert.equal(record.attrs.cause, 'balance_exhausted')
    assert.equal(record.attrs.runtimeKind, 'sprites')
    assert.equal(record.attrs.framework, 'claude-code')
    assert.equal(record.attrs.userId, 'user-1')

    assert.deepEqual(sentryOptionsFor(record).fingerprint, [
        'chat.stream.error.v1',
        'balance_exhausted'
    ])
})

test('a thrown adapter error is classified from the terminal that was written', async () => {
    const harness = makeHarness({
        throws: new Error('execSpriteStream handshake failed: HTTP 502')
    })
    await harness.send()

    const [record] = harness.streamErrors
    assert.equal(harness.streamErrors.length, 1)
    assert.equal(record.attrs.turnPhase, 'stream')
    // adapterErrorEvent's generic code is exactly why the message has to be
    // read: the code alone identifies nothing here.
    assert.equal(record.attrs.errorCode, 'adapter_error')
    assert.equal(record.attrs.retryable, true)
    assert.equal(record.attrs.cause, 'exec_handshake_failed')
    // The original error keeps its own stack for Sentry's stack view.
    assert.match(record.err.message, /handshake failed/)

    assert.deepEqual(sentryOptionsFor(record).fingerprint, [
        'chat.stream.error.v1',
        'exec_handshake_failed'
    ])
})

test('a resumed turn reports the phase it terminalized in', async () => {
    for (const via of ['resume', 'adoption'] as const) {
        const harness = makeHarness()
        await harness.resumeWith(
            [errorEvent('codex_exec_failed', 'connection replaced')],
            via
        )

        const [record] = harness.streamErrors
        assert.equal(harness.streamErrors.length, 1)
        assert.equal(record.attrs.turnPhase, via)
        assert.equal(record.attrs.resumed, true)
        assert.equal(record.attrs.errorCode, 'codex_exec_failed')
        assert.equal(record.attrs.cause, 'daemon_offline')
        assert.equal(record.attrs.runtimeKind, 'sprites')
        assert.ok(typeof record.attrs.durationMs === 'number')
        assert.equal(sentryOptionsFor(record).tags['nca.chat_turn_phase'], via)
    }
})

// The point of the fix, stated across the paths rather than inside one: a
// failed turn now reports the same things wherever it was caught.
test('every terminal path reports the same schema', async () => {
    const dispatch = makeHarness()
    await dispatch.dispatchRejectingWith(new Error(BALANCE_MESSAGE))
    const stream = makeHarness({
        script: [errorEvent('claude_result_error', BALANCE_MESSAGE)]
    })
    await stream.send()
    const thrown = makeHarness({ throws: new Error(BALANCE_MESSAGE) })
    await thrown.send()
    const resumed = makeHarness()
    await resumed.resumeWith(
        [errorEvent('claude_result_error', BALANCE_MESSAGE)],
        'resume'
    )

    const records = [dispatch, stream, thrown, resumed].map((h) => {
        assert.equal(h.streamErrors.length, 1)
        return h.streamErrors[0]
    })
    for (const record of records) {
        for (const key of SCHEMA_KEYS)
            assert.ok(key in record.attrs, `${key} is missing`)
        // One incident, four catch sites, one Sentry group.
        assert.equal(record.attrs.cause, 'balance_exhausted')
        assert.deepEqual(sentryOptionsFor(record).fingerprint, [
            'chat.stream.error.v1',
            'balance_exhausted'
        ])
    }
})

test('an unrecognised failure ships no cause and keeps default grouping', async () => {
    const harness = makeHarness({
        script: [errorEvent('claude_exec_failed', 'sprite exec exited 137')]
    })
    await harness.send()

    const [record] = harness.streamErrors
    assert.ok(!('cause' in record.attrs))
    // Still identified as far as the evidence goes — the durable code is what
    // an operator triages an unknown failure by.
    assert.equal(record.attrs.errorCode, 'claude_exec_failed')
    const options = sentryOptionsFor(record)
    assert.ok(!('fingerprint' in options))
    assert.equal(options.tags['nca.chat_framework'], 'claude-code')
})

// #661 and the cardinality budget, checked on what the service actually
// produces rather than on hand-written attrs.
test('nothing opaque from a real turn reaches a tag or the fingerprint', async () => {
    const harness = makeHarness({
        script: [
            errorEvent(
                'codex_exec_failed',
                'codex exited 1: unexpected status 403 Forbidden: {"code":"INSUFFICIENT_BALANCE"}, url: https://gw.netmind.xyz/responses?key=sk-LEAKED, request_id: req_01HZX9'
            )
        ]
    })
    const sent = await harness.send()

    const [record] = harness.streamErrors
    const indexed = JSON.stringify([
        sentryOptionsFor(record).tags,
        sentryOptionsFor(record).fingerprint
    ])
    for (const opaque of [
        'sk-LEAKED',
        'req_01HZX9',
        'gw.netmind.xyz',
        'session-1',
        'agent-1',
        'user-1',
        sent.assistantMessageId,
        'codex_exec_failed'
    ])
        assert.ok(
            !indexed.includes(opaque),
            `${opaque} must not reach a tag or the fingerprint`
        )
})

// Preservation. A cancel is its own outcome and has never belonged in the
// funnel that pages on bursts; one terminal is still one telemetry event.
test('a user cancel still writes no stream error, and a failure writes exactly one', async () => {
    const cancelled = makeHarness({
        script: [errorEvent('cancelled_by_user', 'cancelled by user', false)]
    })
    await cancelled.send()
    assert.equal(cancelled.streamErrors.length, 0)
    assert.equal(cancelled.named('chat.turn.terminal').length, 1)

    const failed = makeHarness({
        script: [errorEvent('claude_result_error', BALANCE_MESSAGE)]
    })
    await failed.send()
    assert.equal(failed.streamErrors.length, 1)
    assert.equal(failed.named('chat.turn.terminal').length, 1)
})

// A terminal deduped away is a terminal this invocation did not write (#544),
// and it must stay out of both funnels.
test('a terminal that did not persist still emits nothing', async () => {
    const harness = makeHarness({
        script: [errorEvent('claude_result_error', BALANCE_MESSAGE)],
        persisted: false
    })
    await harness.send()
    assert.equal(harness.streamErrors.length, 0)
    assert.equal(harness.named('chat.turn.terminal').length, 0)
})

const errorEvent = (
    code: string,
    message: string,
    retryable = true
): EmittedChatEvent =>
    ({ type: 'error', error: { code, message, retryable } }) as EmittedChatEvent

interface HarnessOptions {
    script?: EmittedChatEvent[]
    throws?: Error
    persisted?: boolean
}

interface Harness {
    service: ChatService
    streamErrors: StreamErrorRecord[]
    named: (name: string) => Array<Record<string, unknown>>
    send: () => Promise<{ assistantMessageId: string }>
    dispatchRejectingWith: (err: Error) => Promise<void>
    resumeWith: (
        events: EmittedChatEvent[],
        via: 'resume' | 'adoption'
    ) => Promise<void>
}

const makeHarness = (opts: HarnessOptions = {}): Harness => {
    const insertedMessages: Array<{ id: string; role: string }> = []
    let latestInflight: string | null = null
    const events: Array<{ name: string; props: Record<string, unknown> }> = []
    const streamErrors: StreamErrorRecord[] = []
    const persisted = opts.persisted !== false
    let adapterFinishedResolve!: () => void
    const adapterFinished = new Promise<void>((r) => {
        adapterFinishedResolve = r
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
        insertMessage: async (row: { id: string; role: string }) => {
            insertedMessages.push(row)
            if (row.role === 'assistant') latestInflight = row.id
            return row
        },
        listMessages: async () => insertedMessages,
        latestInflightMessageId: async () => latestInflight,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        upsertMessageSources: async (rows: unknown[]) => ({
            upserted: rows.length
        }),
        insertStreamEvent: async () => undefined,
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined,
        clearStaleInflightClaims: async () => 0,
        maxStreamEventSeq: async () => 0n,
        markCancelRequested: async () => undefined,
        findCancelRequestedMessageIds: async () => []
    }
    const record = async (
        _messageId: string,
        event: { type: string }
    ): Promise<{ persisted: boolean }> => {
        if (persisted && (event.type === 'done' || event.type === 'error'))
            latestInflight = null
        return { persisted }
    }
    const broadcaster = {
        beginStream: () => undefined,
        setStreamFence: () => undefined,
        beginResumeStream: async () => undefined,
        endStream: () => undefined,
        hasStream: () => true,
        emit: record,
        emitDetached: record
    }

    const adapter = {
        sendMessage: async function* (
            ctx: ApiChatAdapterContext
        ): AsyncIterable<EmittedChatEvent> {
            yield { type: 'token', text: 'hi' }
            if (opts.throws) throw opts.throws
            for (const event of opts.script ?? [])
                yield event as EmittedChatEvent
            if (!opts.script?.length)
                yield { type: 'done', finalMessageId: ctx.messageId }
        }
    }
    const adapters = { get: () => adapter }
    const files = { build: async () => ({ root: { id: 'workspace' } }) }

    // Mirrors TelemetryService.sanitize, which is what decides whether an
    // attribute ships at all — asserting on the raw object would call a field
    // present that production drops.
    const shipped = (
        attrs: Record<string, unknown>
    ): Record<string, unknown> => {
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(attrs))
            if (value !== undefined && value !== null) out[key] = value
        return out
    }

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        {} as never,
        files as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, props: Record<string, unknown>) =>
                events.push({ name, props: shipped(props) }),
            error: (
                name: string,
                err: Error,
                props: Record<string, unknown>
            ) => {
                events.push({ name, props: shipped(props) })
                if (name === 'chat.stream.error')
                    streamErrors.push({ err, attrs: shipped(props) })
            }
        } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never
    )

    const internals = service as unknown as {
        runAdapter: (...args: unknown[]) => Promise<void>
        startAssistantTurn: (...args: unknown[]) => Promise<string>
        runAdapterFromIterable: (
            events: AsyncIterable<EmittedChatEvent>,
            session: unknown,
            assistantMessageId: string,
            agentCtx: unknown,
            abortSignal: AbortSignal,
            opts: unknown
        ) => Promise<unknown>
    }
    const originalRun = internals.runAdapter.bind(service)
    internals.runAdapter = async (...args: unknown[]): Promise<void> => {
        try {
            await originalRun(...args)
        } finally {
            adapterFinishedResolve()
        }
    }

    return {
        service,
        streamErrors,
        named: (name) =>
            events.filter((e) => e.name === name).map((e) => e.props),
        send: async () => {
            const sent = await service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hello'
            )
            // Waits on the run itself rather than on the released claim: a
            // terminal that did not persist never releases one, and that is a
            // case under test here.
            await waitBounded(adapterFinished)
            return sent
        },
        // The unit here is startAssistantTurn's own `run.catch`, so the run is
        // replaced by the rejection it is there to handle — what threw inside
        // runAdapter is upstream's business, and the real cases (a deleted
        // agent, a draining instance) reach this catch identically.
        dispatchRejectingWith: async (err) => {
            internals.runAdapter = async () => {
                throw err
            }
            await internals.startAssistantTurn.call(
                service,
                adapter,
                sessionRow,
                {
                    id: 'msg-user-1',
                    sessionId: 'session-1',
                    role: 'user',
                    contentBlocksJson: [{ type: 'text', text: 'hello' }],
                    createdAt: new Date()
                },
                [],
                'claude-code',
                { model: null, modelConfig: null }
            )
            await waitFor(() => streamErrors.length > 0)
        },
        resumeWith: async (script, via) => {
            const controller = new AbortController()
            latestInflight = 'msg-resume-1'
            async function* iterable(): AsyncIterable<EmittedChatEvent> {
                for (const event of script) yield event
            }
            await internals.runAdapterFromIterable.call(
                service,
                iterable(),
                sessionRow,
                'msg-resume-1',
                {
                    framework: 'claude-code',
                    runtime: 'sprites',
                    runtimeId: 'runtime-1',
                    model: null,
                    modelProviderId: null,
                    modelProviderBuiltInId: null,
                    daemonId: null,
                    spriteName: 'sprite-1',
                    workspacePath: null
                },
                controller.signal,
                { startedAt: Date.now() - 30_000, via }
            )
        }
    }
}