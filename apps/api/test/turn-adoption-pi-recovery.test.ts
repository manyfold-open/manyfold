import { readyChatRunner, withRunnerCursors } from './chat-runner-fixture'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { TurnExecutionRow } from '@manyfold/db'
import { PiAdapter } from '../src/modules/chat/adapters/pi.adapter'
import { ChatService } from '../src/modules/chat/chat.service'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import {
    createAdoptionInterceptor,
    deliveredBaselineFromStreamEvents
} from '../src/modules/chat/recovery/adoption-interceptor'
import type { RecoveryFs } from '../src/modules/chat/recovery/recovery-fs'
import {
    recoverTurnFromPiSession,
    type PiTurnVerdict
} from '../src/modules/chat/recovery/turn-pi-session-recovery'

// The fixtures are one real pi 0.87.1 run against a local stub (macOS dev
// [2026-09-23]): session.jsonl is the session file that run wrote, and
// turn-tool-call.stdout.jsonl is the stream of its first turn — text, a
// `bash` call and its result, then the answer. session-retry.jsonl is a turn
// whose first request got a 529 that pi retried.
const fixture = (name: string): string =>
    readFileSync(join(__dirname, 'fixtures', 'pi', name), 'utf8')

const REF = '11111111-2222-4333-8444-555555555555'
const FILE = `/home/sprite/.pi/agent/sessions/--w--/2026-09-23T20-32-34-309Z_${REF}.jsonl`
const FIRST_PROMPT = 'list the files in this directory'
const SECOND_PROMPT = 'do you remember what you found?'
// Just after pi wrote the first turn's prompt.
const CREATED_AT = new Date('2026-09-23T20:32:34.400Z')

const lines = (name: string): string[] =>
    fixture(name).split('\n').filter(Boolean)

const fsOf = (text: string | null): RecoveryFs =>
    ({
        locate: async () => (text === null ? null : FILE),
        readFile: async () => text,
        listFiles: async () => []
    }) as never

const recover = (
    text: string,
    opts: Partial<Parameters<typeof recoverTurnFromPiSession>[0]> = {}
): Promise<PiTurnVerdict> =>
    recoverTurnFromPiSession({
        fs: fsOf(text),
        frameworkSessionRef: REF,
        workspacePath: '/w',
        promptText: FIRST_PROMPT,
        model: 'fallback-model',
        messageCreatedAt: CREATED_AT,
        settledLines: null,
        sinceLine: 0,
        previousLineCount: null,
        ...opts
    })

const upTo = (name: string, lineCount: number): string =>
    lines(name).slice(0, lineCount).join('\n') + '\n'

const semantic = (events: EmittedChatEvent[]): EmittedChatEvent[] =>
    events.filter((e) => e.type !== 'raw_source')

const tokens = (events: EmittedChatEvent[]): string =>
    events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join('')

test('a finished tool-using turn comes back whole, with the usage of every attempt', async () => {
    const v = await recover(upTo('session.jsonl', 8))
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    assert.deepEqual(
        semantic(v.events).map((e) => e.type),
        ['token', 'tool_call', 'tool_result', 'token']
    )
    assert.equal(
        tokens(v.events),
        'Let me list the files.Done: there are two files here.'
    )
    const call = v.events.find((e) => e.type === 'tool_call') as {
        toolCallId: string
        toolName: string
    }
    assert.equal(call.toolCallId, 'toolu_stub_toolcall_1')
    assert.equal(call.toolName, 'bash')
    const result = v.events.find((e) => e.type === 'tool_result') as {
        toolCallId: string
        result: { isError: boolean }
    }
    assert.equal(result.toolCallId, 'toolu_stub_toolcall_1')
    assert.equal(result.result.isError, false)
    assert.deepEqual(
        {
            model: v.usage.model,
            input: v.usage.inputTokens,
            output: v.usage.outputTokens,
            cacheRead: v.usage.cacheReadTokens,
            cacheWrite: v.usage.cacheCreationTokens
        },
        {
            model: 'claude-sonnet-4-6',
            input: 270,
            output: 26,
            cacheRead: 6,
            cacheWrite: 4
        }
    )
    assert.equal(v.lastSourceSeq, 8)
    // Every entry is provenance under its own id.
    const sources = v.events.filter((e) => e.type === 'raw_source') as Array<{
        source: { externalId: string; sourceSeq: number }
    }>
    assert.deepEqual(
        sources.map((s) => s.source.sourceSeq),
        [6, 7, 8]
    )
})

test('a turn still calling tools streams what is there and stays open', async () => {
    const v = await recover(upTo('session.jsonl', 7))
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.match(v.detail, /toolUse/)
    assert.deepEqual(
        semantic(v.events).map((e) => e.type),
        ['token', 'tool_call', 'tool_result']
    )
})

test('the line cursor emits only what the previous poll did not', async () => {
    const v = await recover(upTo('session.jsonl', 8), { sinceLine: 7 })
    assert.equal(v.outcome, 'recovered')
    assert.equal(tokens(v.events), 'Done: there are two files here.')
    assert.equal(semantic(v.events).length, 1)
})

test('a line pi is still writing waits for the next poll', async () => {
    const text =
        upTo('session.jsonl', 7) + lines('session.jsonl')[7].slice(0, 80)
    const v = await recover(text)
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.equal(v.lastSourceSeq, 7)
})

test('a later turn anchors past the settled lines, never on an earlier prompt', async () => {
    const v = await recover(upTo('session.jsonl', 10), {
        promptText: SECOND_PROMPT,
        settledLines: 8,
        messageCreatedAt: new Date('2026-09-23T20:32:34.600Z')
    })
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    assert.equal(tokens(v.events), 'Resumed reply: yes, I remember.')
    assert.equal(v.usage.inputTokens, 40)

    // The same prompt again, with its turn not yet written: the one before it
    // is settled, so nothing of it is taken for this turn.
    const repeated = await recover(upTo('session.jsonl', 10), {
        promptText: FIRST_PROMPT,
        settledLines: 10
    })
    assert.equal(repeated.outcome, 'result_lost')
    if (repeated.outcome !== 'result_lost') return
    assert.equal(repeated.events.length, 0)
    assert.match(repeated.detail, /prompt not found/)
})

test('an anchor far older than the adopted message is a previous turn', async () => {
    const v = await recover(upTo('session.jsonl', 8), {
        messageCreatedAt: new Date('2026-09-23T21:00:00.000Z')
    })
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.match(v.detail, /predates/)
    assert.equal(v.events.length, 0)
})

test('a fresh session anchors on the latest message closing its fork transcript', async () => {
    const all = lines('session.jsonl').slice(0, 8)
    const user = JSON.parse(all[4])
    user.message.content = [
        {
            type: 'text',
            text: [
                'You are continuing a Manyfold chat in a fresh Pi runtime session.',
                '<previous_transcript>',
                '<message role="user">\nhello\n</message>',
                '</previous_transcript>',
                '',
                'Continue from this latest user message:',
                '<latest_user_message>',
                FIRST_PROMPT,
                '</latest_user_message>'
            ].join('\n')
        }
    ]
    all[4] = JSON.stringify(user)
    const v = await recover(all.join('\n') + '\n')
    assert.equal(v.outcome, 'recovered')
})

test('a failed attempt pi takes back keeps the turn open until the retry answers', async () => {
    // The 529 alone, first sighting: pi has not said yet whether it retries.
    const first = await recover(upTo('session-retry.jsonl', 6))
    assert.equal(first.outcome, 'result_lost')
    // The context_edit naming it: a retry is under way.
    const retrying = await recover(upTo('session-retry.jsonl', 7), {
        previousLineCount: 7
    })
    assert.equal(retrying.outcome, 'result_lost')
    if (retrying.outcome !== 'result_lost') return
    assert.match(retrying.detail, /took back/)

    const done = await recover(upTo('session-retry.jsonl', 10))
    assert.equal(done.outcome, 'recovered')
    if (done.outcome !== 'recovered') return
    assert.equal(
        tokens(done.events),
        'Let me list the files.Done: there are two files here.'
    )
})

test('a failure the file still ends on a poll later is the turn verdict', async () => {
    const v = await recover(upTo('session-retry.jsonl', 6), {
        previousLineCount: 6
    })
    assert.equal(v.outcome, 'turn_failed')
    if (v.outcome !== 'turn_failed') return
    assert.match(v.errorMessage ?? '', /529/)
})

test('an aborted attempt ends the turn at once, with no verdict of pi', async () => {
    const all = lines('session-retry.jsonl').slice(0, 6)
    const failed = JSON.parse(all[5])
    failed.message.stopReason = 'aborted'
    all[5] = JSON.stringify(failed)
    const v = await recover(all.join('\n') + '\n')
    assert.equal(v.outcome, 'turn_failed')
    if (v.outcome !== 'turn_failed') return
    assert.equal(v.errorMessage, null)
})

test('a failed attempt that had text is set apart from the retry, as the stream did', async () => {
    const all = lines('session-retry.jsonl').slice(0, 10)
    const failed = JSON.parse(all[5])
    failed.message.content = [{ type: 'text', text: 'Let me' }]
    all[5] = JSON.stringify(failed)
    const v = await recover(all.join('\n') + '\n')
    assert.equal(v.outcome, 'recovered')
    assert.equal(
        tokens(v.outcome === 'recovered' ? v.events : []),
        'Let me\n\nLet me list the files.Done: there are two files here.'
    )
})

test('no session file is a failed read', async () => {
    const v = await recoverTurnFromPiSession({
        fs: fsOf(null),
        frameworkSessionRef: REF,
        workspacePath: null,
        promptText: FIRST_PROMPT,
        model: null,
        settledLines: null,
        sinceLine: 0,
        previousLineCount: null
    })
    assert.equal(v.outcome, 'failed')
})

// What the live stream delivered for a prefix of the fixture turn, through
// the real adapter: the relay's side of the handover.
const streamed = async (stdout: string): Promise<EmittedChatEvent[]> => {
    const handle = {
        stdout: (async function* () {
            yield stdout
        })(),
        stderr: (async function* () {})(),
        result: Promise.resolve({ exitCode: 0, stderr: '', stdout: '' }),
        abort: () => {},
        lastDeliveredSeq: () => 0
    }
    const adapter = new PiAdapter(
        {
            forAgent: async () => ({
                driver: { stream: () => handle },
                daemonId: 'dh_runner',
                creds: { apiKey: 'sk-marker', provider: 'anthropic' },
                runtime: 'sprites',
                agent: {
                    id: 'agt_1',
                    framework: 'pi',
                    runtime: 'sprites',
                    runtimeId: 'art_1',
                    daemonId: null,
                    workspacePath: '/w',
                    extras: {}
                },
                resolvePriceScope: async () => ({
                    modelProviderId: null,
                    modelProviderBuiltInId: null,
                    modelProviderManagedBrand: null
                }),
                authContext: null
            }),
            recoveryFsForAgent: async () => ({
                agent: { workspacePath: '/w' },
                fs: { exec: async () => '8\n' }
            })
        } as never,
        {
            updateFrameworkSessionRef: async () => undefined,
            setRuntimeSyncCursor: async () => undefined
        } as never,
        {
            computeCost: () => ({ costUsd: null, costSource: 'unknown' })
        } as never
    )
    const out: EmittedChatEvent[] = []
    for await (const ev of adapter.sendMessage(
        {
            agentId: 'agt_1',
            sessionId: 'cts_1',
            messageId: 'msg_1',
            frameworkSessionRef: REF,
            history: []
        } as unknown as ApiChatAdapterContext,
        {
            id: 'cmsg_user',
            role: 'user',
            contentBlocks: [{ type: 'text', text: FIRST_PROMPT }]
        } as never
    ))
        if (
            ev.type === 'token' ||
            ev.type === 'thinking' ||
            ev.type === 'tool_call' ||
            ev.type === 'tool_result'
        )
            out.push(ev)
    return out
}

const shape = (events: EmittedChatEvent[]) => ({
    text: tokens(events),
    tools: events
        .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
        .map((e) => `${e.type}:${(e as { toolCallId: string }).toolCallId}`)
})

test('the stream and the session file agree: an adopter emits exactly what the relay had not', async () => {
    const stdout = fixture('turn-tool-call.stdout.jsonl').split('\n')
    const full = await streamed(stdout.join('\n'))
    // The relay died while `bash` ran: the text and the call were delivered.
    const cut =
        stdout.findIndex((l) => l.includes('"type":"tool_execution_start"')) + 1
    const delivered = await streamed(stdout.slice(0, cut).join('\n') + '\n')
    assert.deepEqual(shape(delivered).tools, [
        'tool_call:toolu_stub_toolcall_1'
    ])

    const interceptor = createAdoptionInterceptor(
        deliveredBaselineFromStreamEvents(
            delivered.map((e) => ({ eventType: e.type, payloadJson: e }))
        ),
        { toolDedup: 'id' }
    )
    const v = await recover(upTo('session.jsonl', 8))
    assert.equal(v.outcome, 'recovered')
    const emitted = v.events.flatMap((ev) => {
        const res = interceptor.intercept(ev)
        assert.equal(res.mismatch, undefined)
        return res.events
    })
    assert.ok(interceptor.aligned())
    assert.deepEqual(shape([...delivered, ...semantic(emitted)]), shape(full))
    assert.deepEqual(shape(semantic(emitted)), {
        text: 'Done: there are two files here.',
        tools: ['tool_result:toolu_stub_toolcall_1']
    })
})

// ---------------------------------------------------------------------------
// The adoption path itself: a pi turn orphaned mid-`bash` finishes under its
// own message id from the session file, and settles the sync cursor.
// ---------------------------------------------------------------------------

// The fixture's clock moved to now: the adopter's turn budget runs from the
// message's creation, and the anchor has to be as fresh as the message.
const shifted = (text: string, byMs: number): string =>
    text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const entry = JSON.parse(line)
            if (typeof entry.timestamp === 'string')
                entry.timestamp = new Date(
                    Date.parse(entry.timestamp) + byMs
                ).toISOString()
            if (typeof entry.message?.timestamp === 'number')
                entry.message.timestamp += byMs
            return JSON.stringify(entry)
        })
        .join('\n') + '\n'

test('an orphaned pi turn is adopted from its session file and settles the sync cursor', async () => {
    const now = new Date()
    const session = shifted(
        upTo('session.jsonl', 8),
        now.getTime() - CREATED_AT.getTime()
    )
    const stdout = fixture('turn-tool-call.stdout.jsonl').split('\n')
    const cut =
        stdout.findIndex((l) => l.includes('"type":"tool_execution_start"')) + 1
    const delivered = await streamed(stdout.slice(0, cut).join('\n') + '\n')
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> =
        []
    const cursors: Array<{ cursor: number | null; fenced: boolean }> = []
    const usage: Array<Record<string, unknown>> = []
    const agentRow = {
        id: 'agent-1',
        userId: 'user-1',
        framework: 'pi',
        runtime: 'sprites',
        runtimeId: 'runtime-1',
        model: 'claude-sonnet-4-6',
        modelProviderId: null,
        modelProviderBuiltInId: null,
        daemonId: null,
        spriteName: 'sprite-1',
        workspacePath: '/w'
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
    const execRow = {
        messageId: 'assistant-1',
        sessionId: 'session-1',
        agentId: 'agent-1',
        runtime: 'sprites',
        spriteName: 'sprite-1',
        execSessionId: null,
        upstreamTaskId: null,
        upstreamMessageId: null,
        ownerId: 'instance-under-test',
        generation: 2,
        leaseExpiresAt: new Date(0),
        state: 'adopting',
        adoptCount: 1,
        createdAt: new Date(0),
        updatedAt: new Date(0)
    } as unknown as TurnExecutionRow
    const repo = {
        getSessionById: async () => ({
            id: 'session-1',
            userId: 'user-1',
            agentId: 'agent-1',
            title: null,
            frameworkSessionRef: REF,
            runtimeSyncCursor: null,
            createdAt: new Date(),
            updatedAt: new Date()
        }),
        getMessageById: async () => ({
            id: 'assistant-1',
            sessionId: 'session-1',
            role: 'assistant' as const,
            daemonId: 'dh_runner',
            daemonExecRef: 'assistant-1',
            contentBlocksJson: [],
            capabilityEventsJson: null,
            cancelRequestedAt: null,
            abortDispatchedAt: null,
            createdAt: now
        }),
        getTurnExecution: async () => ({ ...execRow, state: 'running' }),
        maxStreamEventSeq: async () => delivered.length,
        listStreamEventsSince: async () =>
            delivered.map((e, i) => ({
                id: BigInt(i + 1),
                eventType: e.type,
                payloadJson: e,
                sourceEventKey: null,
                sourceEventOrdinal: null
            })),
        listMessageSourceRows: async () => [],
        listForeignSourceUuids: async () => new Set<string>(),
        latestUserMessageBefore: async () => ({
            id: 'user-msg-1',
            sessionId: 'session-1',
            role: 'user' as const,
            daemonId: null,
            daemonExecRef: null,
            contentBlocksJson: [{ type: 'text', text: FIRST_PROMPT }],
            capabilityEventsJson: null,
            cancelRequestedAt: null,
            abortDispatchedAt: null,
            createdAt: new Date(now.getTime() - 1000)
        }),
        setRuntimeSyncCursor: async (
            _sessionId: string,
            cursor: number | null,
            fence?: unknown
        ) => {
            cursors.push({ cursor, fenced: fence !== undefined })
        },
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
        daemonSeenWithin: async () => false
    }
    const record = async (
        _messageId: string,
        event: { type: string; payload: Record<string, unknown> }
    ) => {
        emitted.push({ type: event.type, payload: event.payload })
        return { persisted: true, fenceLost: false }
    }
    const broadcaster = {
        hasStream: () => false,
        beginStream: () => undefined,
        setStreamFence: () => undefined,
        beginResumeStream: async () => undefined,
        endStream: () => undefined,
        emit: record,
        emitDetached: async (
            messageId: string,
            event: { type: string; payload: Record<string, unknown> }
        ) => {
            await record(messageId, event)
        }
    }
    const execDrivers = {
        recoveryFsForAgent: async () => ({
            fs: fsOf(session),
            agent: agentRow,
            spritesClient: null
        })
    }
    const service = new ChatService(
        db as never,
        withRunnerCursors(repo as never),
        broadcaster as never,
        { get: () => ({ framework: 'pi' }) } as never,
        {
            record: async (row: { usage: Record<string, unknown> }) => {
                usage.push(row.usage)
            }
        } as never,
        {} as never,
        { publishStatus: () => undefined } as never,
        { event: () => undefined, error: () => undefined } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        readyChatRunner(execDrivers as never),
        undefined,
        { emit: () => undefined } as never,
        {
            ownerId: 'instance-under-test',
            enabled: true,
            kick: () => {},
            stopClaiming: async () => undefined
        } as never
    )

    await service.adoptTurnExecution(execRow)

    const types = emitted.map((e) => e.type)
    assert.equal(types.at(-1), 'done')
    assert.ok(!types.includes('error'))
    // Only what the relay had not delivered: the result and the answer.
    assert.deepEqual(
        emitted
            .filter((e) => e.type === 'token')
            .map((e) => e.payload.text)
            .join(''),
        'Done: there are two files here.'
    )
    assert.deepEqual(
        emitted.filter((e) => e.type === 'tool_call').length,
        0,
        'the delivered call is not repeated'
    )
    assert.equal(emitted.filter((e) => e.type === 'tool_result').length, 1)
    assert.deepEqual(
        usage.map((u) => [u.inputTokens, u.outputTokens, u.model]),
        [[270, 26, 'claude-sonnet-4-6']]
    )
    assert.deepEqual(cursors, [{ cursor: 8, fenced: true }])
})
