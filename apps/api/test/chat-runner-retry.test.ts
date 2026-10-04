import { readyChatRunner, withRunnerCursors } from './chat-runner-fixture'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException } from '@nestjs/common'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { TurnDaemonError } from '../src/modules/chat/turn-daemon'
import { ChatService } from '../src/modules/chat/chat.service'
import {
    contextOf,
    fakeRuntimeContext,
    runtimeRow as fixtureRuntime,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// A turn whose runner did not come up asks again after each of the caller's
// runnerRetryDelaysMs (automations: a sandbox that missed a cold start), and
// only the runner resolution repeats: one user row, one assistant row, one
// terminal.

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

const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + BOUND_MS
    while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('condition not met in time')
}

const unavailable = (): TurnDaemonError =>
    new TurnDaemonError('sprites', 'runner_unavailable')

type Outcome = Error | 'ok'

interface Harness {
    service: ChatService
    resolves: () => number
    adapterCalls: () => number
    terminals: Array<{ type: string; code: string | null }>
    roles: () => string[]
    attempts: () => Array<[unknown, unknown]>
    resolveEvents: () => Array<Record<string, unknown>>
    warns: string[]
    start: (delays?: readonly number[]) => Promise<void>
    finished: Promise<void>
}

const makeHarness = (opts: {
    outcomes: Outcome[]
    closedElsewhere?: boolean
}): Harness => {
    const inserted: Array<{ id: string; role: string }> = []
    let latestInflight: string | null = null
    const events: Array<{ name: string; props: Record<string, unknown> }> = []
    const terminals: Array<{ type: string; code: string | null }> = []
    const warns: string[] = []
    let resolves = 0
    let adapterCalls = 0
    let finishedResolve!: () => void
    const finished = new Promise<void>((r) => {
        finishedResolve = r
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
            inserted.push(row)
            if (row.role === 'assistant') latestInflight = row.id
            return row
        },
        listMessages: async () => inserted,
        latestInflightMessageId: async () => latestInflight,
        claimInflightTurn: async () => ({
            ok: true,
            frameworkSessionRef: null,
            runtimeSyncCursor: null
        }),
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
        findCancelRequestedMessageIds: async () => [],
        findTerminalStreamEvent: async () =>
            opts.closedElsewhere
                ? { eventType: 'error' as const, payloadJson: {} }
                : null
    }
    const record = async (
        _messageId: string,
        event: { type: string; payload?: { error?: { code?: string } } }
    ): Promise<{ persisted: boolean }> => {
        if (event.type !== 'done' && event.type !== 'error')
            return { persisted: true }
        terminals.push({
            type: event.type,
            code: event.payload?.error?.code ?? null
        })
        if (opts.closedElsewhere) return { persisted: false }
        latestInflight = null
        return { persisted: true }
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
            adapterCalls += 1
            yield { type: 'token', text: 'hi' }
            yield { type: 'done', finalMessageId: ctx.messageId }
        }
    }
    const runner = readyChatRunner({
        resolveTurnDaemon: async () => {
            const outcome =
                opts.outcomes[Math.min(resolves, opts.outcomes.length - 1)]
            resolves += 1
            if (outcome !== 'ok') throw outcome
            return { hostId: 'rth-1', roots: [] }
        }
    })

    const service = new ChatService(db as never,
        withRunnerCursors(repo as never),
        broadcaster as never,
        { get: () => adapter } as never,
        {} as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, props: Record<string, unknown>) =>
                events.push({ name, props }),
            error: () => {}
        } as never,
        { registerHandler: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        runner,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        fakeRuntimeContext(
            contextOf({
                agent: agentRow as never,
                runtime: fixtureRuntime({
                    id: 'rt-1',
                    userId: 'user-1',
                    hostId: 'rth-1'
                }),
                host: spritesHostRow({
                    id: 'rth-1',
                    userId: 'user-1',
                    providerRef: {
                        kind: 'sprites',
                        spriteName: 'sprite-1',
                        spriteId: null
                    }
                }),
                daemon: null
            })
        ) as never
    )
    const internals = service as unknown as {
        logger: Record<string, (message: string) => void>
        runAdapter: (...args: unknown[]) => Promise<void>
    }
    internals.logger = {
        log: () => {},
        debug: () => {},
        verbose: () => {},
        error: () => {},
        warn: (message: string) => {
            warns.push(message)
        }
    }
    const originalRun = internals.runAdapter.bind(service)
    internals.runAdapter = async (...args: unknown[]): Promise<void> => {
        try {
            await originalRun(...args)
        } finally {
            finishedResolve()
        }
    }

    return {
        service,
        resolves: () => resolves,
        adapterCalls: () => adapterCalls,
        terminals,
        roles: () => inserted.map((row) => row.role),
        attempts: () =>
            events
                .filter((e) => e.name === 'chat.runner.resolve')
                .map((e) => [e.props.attempts, e.props.outcome]),
        resolveEvents: () =>
            events
                .filter((e) => e.name === 'chat.runner.resolve')
                .map((e) => e.props),
        warns,
        start: async (delays) => {
            await service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hello',
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [],
                [],
                delays ? { runnerRetryDelaysMs: delays } : undefined
            )
        },
        finished
    }
}

const retryWarns = (h: Harness): string[] =>
    h.warns.filter((w) => w.startsWith('runner resolution retry'))

test('a runner that failed to come up is asked again, and the turn runs once it answers', async () => {
    const h = makeHarness({ outcomes: [unavailable(), 'ok'] })
    await h.start([0, 0])
    await h.finished

    assert.equal(h.resolves(), 2)
    assert.deepEqual(h.attempts(), [
        [1, 'unavailable'],
        [2, 'runner']
    ])
    assert.equal(h.adapterCalls(), 1)
    assert.deepEqual(h.terminals, [{ type: 'done', code: null }])
    assert.deepEqual(h.roles(), ['user', 'assistant'])
    assert.deepEqual(retryWarns(h), [
        'runner resolution retry agentId=agent-1 attempt=2 inMs=0 reason=runner_unavailable'
    ])
    // The log store is at its column limit and refuses a whole batch that
    // brings a new attribute name, so this event keeps to the names it has.
    for (const props of h.resolveEvents())
        assert.deepEqual(Object.keys(props).sort(), [
            'agentId',
            'attempts',
            'errorCode',
            'outcome',
            'runnerKind'
        ])
})

test('a runner that never comes up ends the turn once, after every delay is spent', async () => {
    const h = makeHarness({
        outcomes: [
            unavailable(),
            new TurnDaemonError('sprites', 'runner_updating'),
            unavailable()
        ]
    })
    await h.start([0, 0])
    await h.finished

    assert.equal(h.resolves(), 3)
    assert.deepEqual(
        h.attempts().map(([attempt]) => attempt),
        [1, 2, 3]
    )
    assert.equal(h.adapterCalls(), 0)
    assert.deepEqual(h.terminals, [
        { type: 'error', code: 'chat_runner_unavailable' }
    ])
    assert.equal(retryWarns(h).length, 2)
})

test('a turn without retry delays fails on its first runner failure, as before', async () => {
    const h = makeHarness({ outcomes: [unavailable(), 'ok'] })
    await h.start()
    await h.finished

    assert.equal(h.resolves(), 1)
    assert.deepEqual(h.attempts(), [[1, 'unavailable']])
    assert.deepEqual(h.terminals, [
        { type: 'error', code: 'chat_runner_unavailable' }
    ])
    assert.deepEqual(retryWarns(h), [])
})

for (const [label, error] of [
    ['an old CLI', new TurnDaemonError('sprites', 'runner_cli_too_old', true)],
    [
        'an exec endpoint the bring-up proved dead',
        new TurnDaemonError('sprites', 'runner_unavailable', false, {
            failureClass: 'handshake_5xx',
            upstreamStatus: 502
        } as never)
    ],
    ['a runtime that is not ready', new TurnDaemonError('sprites', 'runtime unavailable')],
    [
        'a quota refusal',
        new ForbiddenException({
            code: 'active_hours_exceeded',
            message: 'active host quota reached'
        })
    ]
] as const) {
    test(`${label} is not asked again`, async () => {
        const h = makeHarness({ outcomes: [error, 'ok'] })
        await h.start([0, 0])
        await h.finished

        assert.equal(h.resolves(), 1)
        assert.equal(h.adapterCalls(), 0)
        assert.deepEqual(retryWarns(h), [])
    })
}

test('a cancel during the wait ends the turn cancelled without asking again', async () => {
    const h = makeHarness({ outcomes: [unavailable(), 'ok'] })
    await h.start([60_000, 180_000])
    await waitFor(() => retryWarns(h).length === 1)

    await h.service.cancelStream('user-1', 'agent-1', 'session-1')
    await h.finished

    assert.equal(h.resolves(), 1)
    assert.equal(h.adapterCalls(), 0)
    assert.deepEqual(h.terminals, [
        { type: 'error', code: 'cancelled_by_user' }
    ])
})

test('a shutdown drain during the wait ends the turn with its runner error and drains', async () => {
    const h = makeHarness({ outcomes: [unavailable(), 'ok'] })
    await h.start([60_000, 180_000])
    await waitFor(() => retryWarns(h).length === 1)

    const result = await h.service.prepareForShutdown(BOUND_MS)
    await h.finished

    assert.equal(result.drainOutcome, 'drained')
    assert.equal(result.activeTurnsRemaining, 0)
    assert.equal(h.resolves(), 1)
    assert.deepEqual(h.terminals, [
        { type: 'error', code: 'chat_runner_unavailable' }
    ])
})

test('a turn a peer already closed during the wait is not dispatched', async () => {
    const h = makeHarness({
        outcomes: [unavailable(), 'ok'],
        closedElsewhere: true
    })
    await h.start([0, 0])
    await h.finished

    assert.equal(h.resolves(), 1)
    assert.equal(h.adapterCalls(), 0)
})
