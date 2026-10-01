import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError } from 'commander'
import { UsageError } from '../src/usage-error'
import { json, runMf, type Route } from './fixtures/fake-api'

// The root --agent-id defaults to $MF_AGENT_ID, which a runtime sets.
const NO_AGENT = { MF_AGENT_ID: undefined }

const emptySummary = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0,
    eventCount: 0,
    fallbackEventCount: 0,
    byModel: []
}

const routes = (over: Record<string, Route> = {}): Record<string, Route> => ({
    'GET /usage/summary': () => json(emptySummary),
    'GET /usage/timeseries': () => json([]),
    'GET /usage/events': () => json({ items: [], nextCursor: null }),
    'GET /usage/sessions': () => json([]),
    'GET /usage/top-agents': () => json([]),
    ...over
})

test('bad usage options are refused before anything is sent', async () => {
    for (const args of [
        ['usage', 'timeseries', '--bucket', 'month'],
        ['usage', 'events', '--limit', 'abc'],
        ['usage', 'events', '--limit', '-1'],
        ['usage', 'events', '--limit', '0'],
        ['usage', 'events', '--limit', '201'],
        ['usage', 'top-agents', '--limit', '101'],
        ['usage', 'summary', '--from', 'garbage'],
        ['usage', 'sessions', '--to', '2026-02-30'],
        ['usage', 'top-agents', '--from', '1']
    ]) {
        const run = await runMf(args, routes(), NO_AGENT)
        assert.ok(run.error instanceof CommanderError, args.join(' '))
        assert.deepEqual(run.calls, [], args.join(' '))
    }
})

test('good options reach the query as given', async () => {
    const events = await runMf(
        [
            'usage',
            'events',
            '--limit',
            '200',
            '--from',
            '2026-10-01',
            '--to',
            '2026-10-02T00:00:00+01:00'
        ],
        routes(),
        NO_AGENT
    )
    assert.equal(events.error, undefined, String(events.error))
    const query = events.calls[0]?.query
    assert.equal(query?.get('limit'), '200')
    assert.equal(query?.get('from'), '2026-10-01')
    assert.equal(query?.get('to'), '2026-10-02T00:00:00+01:00')

    const hourly = await runMf(
        ['usage', 'timeseries', '--bucket', 'hour'],
        routes(),
        NO_AGENT
    )
    assert.equal(hourly.calls[0]?.query.get('bucket'), 'hour')
})

test("--account reads past the runtime's own agent; a typed --agent-id still filters", async () => {
    const runtime = { MF_AGENT_ID: 'agt_self' }
    const agentOf = async (args: string[]): Promise<string | null> => {
        const run = await runMf(args, routes(), runtime)
        assert.equal(run.error, undefined, String(run.error))
        return run.calls[0]?.query.get('agentId') ?? null
    }
    assert.equal(await agentOf(['usage', 'summary']), 'agt_self')
    assert.equal(await agentOf(['--account', 'usage', 'summary']), null)
    assert.equal(await agentOf(['--account', 'usage', 'sessions']), null)
    assert.equal(
        await agentOf(['--account', 'usage', 'summary', '--agent-id', 'agt_other']),
        'agt_other'
    )
    assert.equal(
        await agentOf(['--account', '--agent-id', 'agt_other', 'usage', 'events']),
        'agt_other'
    )
})

const summary = {
    totalInputTokens: 92,
    totalOutputTokens: 2505,
    totalCacheReadTokens: 1033157,
    totalCacheCreationTokens: 18402,
    totalCostUsd: 1.7712,
    eventCount: 37,
    fallbackEventCount: 2,
    byModel: [
        {
            model: 'claude-sonnet-5',
            framework: 'claude-code',
            runtimeKind: 'sprites',
            inputTokens: 80,
            outputTokens: 2400,
            cacheReadTokens: 1000000,
            cacheCreationTokens: 18000,
            costUsd: 1.62,
            eventCount: 31,
            fallbackEventCount: 0,
            isFallback: false
        },
        {
            model: 'gpt-5.5',
            framework: 'codex',
            runtimeKind: 'daemon',
            inputTokens: 12,
            outputTokens: 105,
            cacheReadTokens: 33157,
            cacheCreationTokens: 402,
            costUsd: 0.1512,
            eventCount: 4,
            fallbackEventCount: 2,
            isFallback: true
        },
        {
            model: null,
            framework: 'hermes',
            runtimeKind: 'mainframe',
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: null,
            eventCount: 2,
            fallbackEventCount: 0,
            isFallback: false
        }
    ]
}

const event = (over: object) => ({
    id: 'evt_1',
    userId: 'usr_1',
    agentId: 'agt_1',
    runtimeId: 'art_1',
    sessionId: 'ses_1',
    messageId: 'msg_1',
    framework: 'claude-code',
    runtimeKind: 'sprites',
    model: 'claude-sonnet-5',
    inputTokens: 3,
    outputTokens: 120,
    cacheReadTokens: 41210,
    cacheCreationTokens: 0,
    costUsd: 0.0412,
    costSource: 'upstream',
    isFallbackModel: false,
    firstTokenMs: 1840,
    totalMs: 6210,
    createdAt: '2026-10-01T14:03:22.418Z',
    ...over
})

const events = {
    items: [
        event({}),
        event({
            id: 'evt_2',
            model: 'gpt-5.5',
            framework: 'codex',
            costUsd: null,
            isFallbackModel: true,
            firstTokenMs: null,
            totalMs: null,
            createdAt: '2026-10-01T13:59:01.002Z'
        })
    ],
    nextCursor: '2026-10-01T13:59:01.002Z'
}

const timeseries = [
    {
        bucket: '2026-09-30T00:00:00.000Z',
        inputTokens: 80,
        outputTokens: 2100,
        cacheReadTokens: 900000,
        cacheCreationTokens: 0,
        costUsd: 1.5,
        eventCount: 30,
        fallbackEventCount: 0
    },
    {
        bucket: '2026-10-01T14:00:00.000Z',
        inputTokens: 12,
        outputTokens: 405,
        cacheReadTokens: 133157,
        cacheCreationTokens: 0,
        costUsd: null,
        eventCount: 7,
        fallbackEventCount: 0
    }
]

const sessions = () => [
    {
        sessionId: 'ses_agqpihe6szzjfe3xjjvr4gac2e',
        agentId: 'agt_agqpihe6szzjfe3xjjvr4gac2e',
        runtimeId: 'art_1',
        framework: 'claude-code',
        runtimeKind: 'sprites',
        inputTokens: 35,
        outputTokens: 2505,
        cacheReadTokens: 1000000,
        cacheCreationTokens: 0,
        costUsd: 1.62,
        eventCount: 33,
        fallbackEventCount: 0,
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString()
    }
]

const topAgents = [
    {
        agentId: 'agt_agqpihe6szzjfe3xjjvr4gac2e',
        name: 'peer-agent',
        framework: 'claude-code',
        runtimeKind: 'sprites',
        userId: 'usr_1',
        userEmail: 'ying@example.com',
        inputTokens: 35,
        outputTokens: 2505,
        costUsd: 1.62,
        eventCount: 33
    },
    {
        agentId: 'agt_deleted',
        name: null,
        framework: null,
        runtimeKind: null,
        userId: 'usr_1',
        userEmail: 'ying@example.com',
        inputTokens: 1,
        outputTokens: 2,
        costUsd: null,
        eventCount: 1
    }
]

const full = (): Record<string, Route> =>
    routes({
        'GET /usage/summary': () => json(summary),
        'GET /usage/timeseries': () => json(timeseries),
        'GET /usage/events': () => json(events),
        'GET /usage/sessions': () => json(sessions()),
        'GET /usage/top-agents': () => json(topAgents)
    })

// Column widths follow the data; compare with runs of spaces folded.
const folded = (lines: string[]): string[] =>
    lines.map((line) => line.replace(/(\S) +/g, '$1 '))

test('mf usage alone is the summary, with the filters given to it', async () => {
    const run = await runMf(['usage', '--from', '2026-10-01'], full(), NO_AGENT)
    assert.equal(run.error, undefined, String(run.error))
    assert.equal(run.calls[0]?.path, '/usage/summary')
    assert.equal(run.calls[0]?.query.get('from'), '2026-10-01')
    assert.deepEqual(folded(run.out), [
        '$1.7712 · 37 events · tokens 92 in, 2,505 out, 1,033,157 cache read, 18,402 cache write',
        '',
        'MODEL FRAMEWORK RUNTIME IN OUT CACHE READ COST EVENTS',
        'claude-sonnet-5 claude-code Stateful sandbox 80 2,400 1,000,000 $1.62 31',
        'gpt-5.5* codex Self-owned computer 12 105 33,157 $0.1512 4',
        '— hermes mainframe 0 0 0 unknown 2',
        '',
        '* includes events whose runtime reported no model; they are priced as this one, so their cost is an estimate'
    ])
})

test('a word that names no usage subcommand is refused, not run as summary', async () => {
    const run = await runMf(['usage', 'sumary'], full(), NO_AGENT)
    assert.ok(run.error instanceof UsageError)
    assert.equal(
        run.error.message,
        "unknown command 'sumary': mf usage has summary, timeseries, events, sessions and top-agents"
    )
    assert.deepEqual(run.calls, [])
})

test('--json prints each payload exactly as the API sent it', async () => {
    const payloads: Array<[string, unknown]> = [
        ['summary', summary],
        ['timeseries', timeseries],
        ['events', events],
        ['top-agents', topAgents]
    ]
    for (const [name, payload] of payloads) {
        const run = await runMf(['usage', name, '--json'], full(), NO_AGENT)
        assert.equal(run.error, undefined, String(run.error))
        assert.deepEqual(JSON.parse(run.out.join('\n')), payload, name)
        assert.deepEqual(run.err, [], name)
    }
})

test('timeseries labels each bucket in UTC, by day or by hour', async () => {
    const day = await runMf(['usage', 'timeseries'], full(), NO_AGENT)
    assert.deepEqual(folded(day.out), [
        'DAY (UTC) IN OUT CACHE READ COST EVENTS',
        '2026-09-30 80 2,100 900,000 $1.50 30',
        '2026-10-01 12 405 133,157 unknown 7'
    ])
    const hour = await runMf(
        ['usage', 'timeseries', '--bucket', 'hour'],
        full(),
        NO_AGENT
    )
    assert.equal(folded(hour.out)[0], 'HOUR (UTC) IN OUT CACHE READ COST EVENTS')
    assert.equal(folded(hour.out)[2]?.split(' ').slice(0, 2).join(' '), '2026-10-01 14:00')
})

test('events lists each call and says where the next page starts', async () => {
    const run = await runMf(['usage', 'events', '--limit', '2'], full(), NO_AGENT)
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(folded(run.out), [
        'TIME (UTC) FRAMEWORK MODEL IN OUT CACHE READ COST FIRST TOKEN TOTAL',
        '2026-10-01 14:03:22 claude-code claude-sonnet-5 3 120 41,210 $0.0412 1.8 s 6.2 s',
        '2026-10-01 13:59:01 codex gpt-5.5* 3 120 41,210 unknown — —',
        '',
        '* includes events whose runtime reported no model; they are priced as this one, so their cost is an estimate'
    ])
    assert.deepEqual(run.err, [
        '(more — continue with --cursor 2026-10-01T13:59:01.002Z)'
    ])
})

test('sessions and top-agents rank with what the API knows', async () => {
    const byLast = await runMf(['usage', 'sessions'], full(), NO_AGENT)
    assert.deepEqual(folded(byLast.out), [
        'SESSION AGENT FRAMEWORK IN OUT COST EVENTS LAST ACTIVITY',
        'ses_agqpihe6szzjfe3xjjvr4gac2e agt_agqpihe6szzjfe3xjjvr4gac2e claude-code 35 2,505 $1.62 33 5m ago'
    ])
    const top = await runMf(['usage', 'top-agents'], full(), NO_AGENT)
    assert.deepEqual(folded(top.out), [
        'NAME ID FRAMEWORK IN OUT COST EVENTS',
        'peer-agent agt_agqpihe6szzjfe3xjjvr4gac2e claude-code 35 2,505 $1.62 33',
        '— agt_deleted — 1 2 unknown 1'
    ])
})

test('nothing in the window is a note on stderr and exit 0', async () => {
    for (const [name, note] of [
        ['summary', 'no usage in this window'],
        ['timeseries', 'no usage in this window'],
        ['events', 'no usage events in this window'],
        ['sessions', 'no sessions with usage in this window'],
        ['top-agents', 'no agent usage in this window']
    ]) {
        const run = await runMf(['usage', name], routes(), NO_AGENT)
        assert.equal(run.error, undefined, `${name}: ${String(run.error)}`)
        assert.equal(run.exitCode, undefined, name)
        assert.deepEqual(run.out, [], name)
        assert.deepEqual(run.err, [note], name)
    }
})
