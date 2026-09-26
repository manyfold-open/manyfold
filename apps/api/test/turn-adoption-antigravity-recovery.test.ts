import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { AntigravityCliAdapter } from '../src/modules/chat/adapters/antigravity-cli.adapter'
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
    recoverTurnFromAntigravityTranscript,
    type AntigravityTurnVerdict
} from '../src/modules/chat/recovery/turn-antigravity-transcript-recovery'
import { runAdoption } from './turn-adoption-harness'

// One real agy 1.2.11 run against a local stub (see the fixtures' README):
// turn-multitool.stdout.jsonl is its stream, and the transcript is the log
// agy wrote for the same conversation — a prompt, three planner steps each
// calling a tool, the tools' results, then the answer.
const DIR = join(__dirname, 'fixtures', 'antigravity-cli', '1.2.11')
const fixture = (name: string): string => readFileSync(join(DIR, name), 'utf8')
const TRANSCRIPT = 'transcripts/multitool.transcript_full.jsonl'

const REF = '4a0dbd6a-267c-442d-a678-f6f33270fa3c'
const FILE = `/home/sprite/.gemini/antigravity-cli/brain/${REF}/.system_generated/logs/transcript_full.jsonl`
const PROMPT = 'Say hello.'
// Just after agy wrote the prompt.
const CREATED_AT = new Date('2026-09-26T16:41:13.500Z')

const lines = (name: string): string[] =>
    fixture(name).split('\n').filter(Boolean)
const upTo = (name: string, count: number): string =>
    `${lines(name).slice(0, count).join('\n')}\n`

const fsOf = (text: string | null): RecoveryFs =>
    ({
        locate: async () => (text === null ? null : FILE),
        readFile: async () => text,
        listFiles: async () => []
    }) as never

const recover = (
    text: string | null,
    opts: Partial<
        Parameters<typeof recoverTurnFromAntigravityTranscript>[0]
    > = {}
): Promise<AntigravityTurnVerdict> =>
    recoverTurnFromAntigravityTranscript({
        fs: fsOf(text),
        frameworkSessionRef: REF,
        promptText: PROMPT,
        messageCreatedAt: CREATED_AT,
        settledLines: null,
        sinceLine: 0,
        ...opts
    })

const semantic = (events: EmittedChatEvent[]): EmittedChatEvent[] =>
    events.filter((e) => e.type !== 'raw_source')

const tokens = (events: EmittedChatEvent[]): string =>
    events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join('')

const shape = (events: EmittedChatEvent[]) => ({
    text: tokens(events),
    tools: events
        .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
        .map((e) => `${e.type}:${(e as { toolCallId: string }).toolCallId}`)
})

test('a finished tool-using turn comes back whole, under the stream’s tool ids, with no usage', async () => {
    const v = await recover(fixture(TRANSCRIPT))
    assert.equal(v.outcome, 'recovered')
    if (v.outcome !== 'recovered') return
    assert.deepEqual(shape(v.events), {
        text: 'All 3 tool calls finished.\n',
        tools: [
            'tool_call:agy-2',
            'tool_result:agy-2',
            'tool_call:agy-4',
            'tool_result:agy-4',
            'tool_call:agy-6',
            'tool_result:agy-6'
        ]
    })
    const call = v.events.find((e) => e.type === 'tool_call')
    assert.ok(call?.type === 'tool_call')
    assert.equal(call.toolName, 'run_command')
    assert.equal(
        (call.args as Record<string, unknown>).CommandLine,
        'echo first'
    )
    assert.equal(v.usage, null)
    assert.equal(v.lastSourceSeq, 8)
    assert.equal(v.recoveredLines, 7)
    // Nothing agy logged as reasoning reached the stream, nor comes back.
    assert.ok(!v.events.some((e) => e.type === 'thinking'))
})

test('a turn still calling tools streams what is there and stays open', async () => {
    const v = await recover(upTo(TRANSCRIPT, 5))
    assert.equal(v.outcome, 'result_lost')
    if (v.outcome !== 'result_lost') return
    assert.equal(v.detail, 'turn not finished')
    assert.deepEqual(shape(v.events).tools, [
        'tool_call:agy-2',
        'tool_result:agy-2',
        'tool_call:agy-4',
        'tool_result:agy-4'
    ])
})

test('the line cursor emits only what the previous poll did not', async () => {
    const v = await recover(fixture(TRANSCRIPT), { sinceLine: 5 })
    assert.deepEqual(shape(v.outcome === 'recovered' ? v.events : []), {
        text: 'All 3 tool calls finished.\n',
        tools: ['tool_call:agy-6', 'tool_result:agy-6']
    })
})

test('a line agy is still writing waits for the next poll', async () => {
    const all = lines(TRANSCRIPT)
    const partial = `${all.slice(0, 7).join('\n')}\n${all[7].slice(0, 40)}`
    const v = await recover(partial)
    assert.equal(v.outcome, 'result_lost')
    assert.equal(v.outcome === 'result_lost' && v.lastSourceSeq, 7)
})

test('a later turn anchors past the settled lines, never on an earlier prompt', async () => {
    const resumed = fixture('transcripts/resumed.transcript_full.jsonl')
    const at = new Date('2026-09-26T16:47:16.500Z')
    const second = await recover(resumed, {
        frameworkSessionRef: '6bce3054-1614-4b63-b9b5-9590cdfc8458',
        promptText: 'Second turn.',
        messageCreatedAt: at,
        settledLines: 2
    })
    assert.equal(second.outcome, 'recovered')
    assert.equal(
        tokens(second.outcome === 'recovered' ? second.events : []),
        'Hello from the stub (turn 2).\n'
    )
    const beforeSettled = await recover(resumed, {
        frameworkSessionRef: '6bce3054-1614-4b63-b9b5-9590cdfc8458',
        promptText: 'First turn.',
        messageCreatedAt: at,
        settledLines: 2
    })
    assert.equal(beforeSettled.outcome, 'result_lost')
})

test('an anchor far older than the adopted message is a previous turn', async () => {
    const v = await recover(fixture(TRANSCRIPT), {
        messageCreatedAt: new Date('2026-09-26T18:00:00Z')
    })
    assert.equal(v.outcome, 'result_lost')
    assert.equal(
        v.outcome === 'result_lost' && v.detail,
        'anchored prompt predates this message'
    )
})

test('a fresh conversation anchors on the latest message closing its fork transcript', async () => {
    const [first, ...rest] = lines(TRANSCRIPT)
    const prompt = JSON.parse(first)
    prompt.content = [
        '<USER_REQUEST>',
        'You are continuing a Manyfold chat in a fresh Antigravity CLI runtime session.',
        '<previous_transcript>',
        '<message role="user">\nearlier\n</message>',
        '</previous_transcript>',
        '',
        'Continue from this latest user message:',
        '<latest_user_message>',
        PROMPT,
        '</latest_user_message>',
        '</USER_REQUEST>'
    ].join('\n')
    const v = await recover(`${[JSON.stringify(prompt), ...rest].join('\n')}\n`)
    assert.equal(v.outcome, 'recovered')
})

test('a turn that stops on a failed model call is left open for agy to retry', async () => {
    const [prompt] = lines(TRANSCRIPT)
    const failed = JSON.stringify({
        step_index: 1,
        source: 'SYSTEM',
        type: 'ERROR_MESSAGE',
        status: 'DONE',
        error: 'API error (attempt 1): Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: []',
        created_at: '2026-09-26T16:41:14Z'
    })
    const v = await recover(`${prompt}\n${failed}\n`)
    assert.equal(v.outcome, 'result_lost')
    assert.match(v.outcome === 'result_lost' ? v.detail : '', /may retry/)
})

test('no transcript is a failed read', async () => {
    assert.equal((await recover(null)).outcome, 'failed')
})

// What the live stream delivered for a prefix of the fixture turn, through
// the real adapter: the relay's side of the handover.
const streamed = async (stdout: string): Promise<EmittedChatEvent[]> => {
    const adapter = new AntigravityCliAdapter(
        {
            forAgent: async () => ({
                driver: {
                    stream: () => ({
                        stdout: (async function* () {
                            yield stdout
                        })(),
                        stderr: (async function* () {})(),
                        result: Promise.resolve({
                            exitCode: 0,
                            stderr: '',
                            stdout: ''
                        }),
                        abort: () => {},
                        lastDeliveredSeq: () => 0
                    })
                },
                daemonId: 'dh_runner',
                creds: null,
                runtime: 'sprites',
                agent: {
                    id: 'agt_1',
                    framework: 'antigravity-cli',
                    runtime: 'sprites',
                    runtimeId: 'art_1',
                    workspacePath: '/w',
                    extras: { modelConfig: { source: 'runtime-local' } }
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
            contentBlocks: [{ type: 'text', text: PROMPT }]
        } as never
    ))
        if (
            ev.type === 'token' ||
            ev.type === 'tool_call' ||
            ev.type === 'tool_result'
        )
            out.push(ev)
    return out
}

// The relay died while the second tool ran: the first call and its result,
// and the second call, were delivered.
const deliveredPrefix = (): string => {
    const stdout = fixture('turn-multitool.stdout.jsonl').split('\n')
    const cut =
        stdout.findIndex(
            (l) => l.includes('"step_index":4') && l.includes('"ACTIVE"')
        ) + 1
    return `${stdout.slice(0, cut).join('\n')}\n`
}

test('the stream and the transcript agree: an adopter emits exactly what the relay had not', async () => {
    const full = await streamed(fixture('turn-multitool.stdout.jsonl'))
    const delivered = await streamed(deliveredPrefix())
    assert.deepEqual(shape(delivered).tools, [
        'tool_call:agy-2',
        'tool_result:agy-2',
        'tool_call:agy-4'
    ])
    const interceptor = createAdoptionInterceptor(
        deliveredBaselineFromStreamEvents(
            delivered.map((e) => ({ eventType: e.type, payloadJson: e }))
        ),
        { toolDedup: 'id' }
    )
    const v = await recover(fixture(TRANSCRIPT))
    assert.equal(v.outcome, 'recovered')
    const emitted = v.events.flatMap((ev) => {
        const res = interceptor.intercept(ev)
        assert.equal(res.mismatch, undefined)
        return res.events
    })
    assert.ok(interceptor.aligned())
    assert.deepEqual(shape([...delivered, ...semantic(emitted)]), shape(full))
})

// The fixture's clock moved to now: the adopter's turn budget runs from the
// message's creation, and the anchor has to be as fresh as the message.
const shifted = (text: string, byMs: number): string =>
    `${text
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const record = JSON.parse(line)
            if (typeof record.created_at === 'string')
                record.created_at = new Date(
                    Date.parse(record.created_at) + byMs
                ).toISOString()
            return JSON.stringify(record)
        })
        .join('\n')}\n`

test('an orphaned agy turn is adopted from its transcript and settles the sync cursor', async () => {
    const now = new Date()
    const { emitted, cursors, usage } = await runAdoption({
        framework: 'antigravity-cli',
        transcript: shifted(
            fixture(TRANSCRIPT),
            now.getTime() - CREATED_AT.getTime()
        ),
        delivered: await streamed(deliveredPrefix()),
        prompt: PROMPT,
        createdAt: now,
        frameworkSessionRef: REF
    })
    const types = emitted.map((e) => e.type)
    assert.equal(types.at(-1), 'done')
    assert.ok(!types.includes('error'))
    assert.equal(
        emitted
            .filter((e) => e.type === 'token')
            .map((e) => e.payload.text)
            .join(''),
        'All 3 tool calls finished.\n'
    )
    // Only what the relay had not delivered: the second result, the third
    // call and its result.
    assert.deepEqual(
        emitted
            .filter((e) => e.type === 'tool_call' || e.type === 'tool_result')
            .map((e) => `${e.type}:${e.payload.toolCallId}`),
        ['tool_result:agy-4', 'tool_call:agy-6', 'tool_result:agy-6']
    )
    assert.deepEqual(usage, [])
    assert.deepEqual(cursors, [{ cursor: 8, fenced: true }])
})
