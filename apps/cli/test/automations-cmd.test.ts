import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommanderError } from 'commander'
import type {
    AutomationDetail,
    AutomationRunSummary,
    ChatMessage,
    ChatMessagesPage
} from '@manyfold/shared'
import { json, runMf, type Route, type Run } from './fixtures/fake-api'
import {
    chatEvent,
    sse,
    sseFrame,
    type StreamEvent
} from './fixtures/chat-stream'
import { spawnMf } from './fixtures/spawn-mf'

// `mf automations`: when an automation runs is said once, as a preset (timed
// with --at and --day) or as an --rrule, in this machine's timezone unless
// told otherwise; a run's reply is followed as it streams, or read back once
// the run has ended.

const detail = (over: Partial<AutomationDetail> = {}): AutomationDetail =>
    ({
        id: 'aut_1',
        agentId: 'agt_1',
        title: 'Daily check',
        status: 'active',
        schedulePreset: 'daily',
        rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
        timezone: 'UTC',
        nextRunAt: '2026-10-01T09:00:00.000Z',
        prompt: 'Check the workspace.',
        runs: [],
        ...over
    }) as AutomationDetail

const create = (...flags: string[]) =>
    runMf(
        [
            'automations',
            'create',
            '--agent-id',
            'agt_1',
            '--title',
            'Daily check',
            '--prompt',
            'Check the workspace.',
            ...flags
        ],
        {
            'POST /automations': (call) =>
                json(detail(call.body as object), 201)
        }
    )

const posted = (run: Run) =>
    run.calls.find((call) => call.method !== 'GET')?.body as Record<
        string,
        unknown
    >

const usageError = (run: Run): string => {
    assert.ok(
        run.error instanceof CommanderError,
        `expected a usage error, got ${String(run.error)}`
    )
    assert.deepEqual(
        run.calls.filter((call) => call.method !== 'GET'),
        [],
        'nothing may be sent'
    )
    return run.error.message
}

test('a preset alone is enough: its rule, and this machine’s timezone', async () => {
    const run = await create('--schedule-preset', 'daily')
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(posted(run), {
        agentId: 'agt_1',
        title: 'Daily check',
        prompt: 'Check the workspace.',
        schedulePreset: 'daily',
        rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    })
})

test('--at and --day time a preset', async () => {
    const weekdays = await create(
        '--schedule-preset',
        'weekdays',
        '--at',
        '17:30',
        '--timezone',
        'Asia/Shanghai'
    )
    assert.equal(
        posted(weekdays).rrule,
        'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=17;BYMINUTE=30;BYSECOND=0'
    )
    assert.equal(posted(weekdays).timezone, 'Asia/Shanghai')
    const weekly = await create(
        '--schedule-preset',
        'weekly',
        '--day',
        'Fri',
        '--at',
        '8:05'
    )
    assert.equal(
        posted(weekly).rrule,
        'RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=8;BYMINUTE=5;BYSECOND=0'
    )
    const hourly = await create('--schedule-preset', 'hourly', '--at', '00:15')
    assert.equal(
        posted(hourly).rrule,
        'RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=15;BYSECOND=0'
    )
})

test('an --rrule alone is a custom schedule', async () => {
    const run = await create('--rrule', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
    assert.equal(posted(run).schedulePreset, 'custom')
    assert.equal(posted(run).rrule, 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
    // Both given are taken as given.
    const both = await create(
        '--schedule-preset',
        'daily',
        '--rrule',
        'FREQ=DAILY;BYHOUR=7'
    )
    assert.equal(posted(both).schedulePreset, 'daily')
})

test('a schedule that cannot be read is refused before anything is sent', async () => {
    const cases: Array<[string[], RegExp]> = [
        [[], /say when it runs: --schedule-preset/],
        [['--schedule-preset', 'yearly'], /--schedule-preset takes hourly/],
        [['--schedule-preset', 'custom'], /custom needs its --rrule/],
        [
            ['--schedule-preset', 'daily', '--at', '25:00'],
            /--at takes a time of day as HH:MM/
        ],
        [
            ['--schedule-preset', 'daily', '--day', 'fri'],
            /--day goes with --schedule-preset weekly/
        ],
        [
            ['--schedule-preset', 'weekly', '--day', 'someday'],
            /--day takes a weekday/
        ],
        [['--at', '09:00'], /--at and --day go with --schedule-preset/],
        [
            ['--rrule', 'FREQ=DAILY', '--at', '09:00'],
            /an --rrule carries its own time/
        ]
    ]
    for (const [flags, message] of cases)
        assert.match(
            usageError(await create(...flags)),
            message,
            flags.join(' ')
        )
})

test('what it creates reads as its schedule and next run', async () => {
    const run = await create('--schedule-preset', 'daily', '--timezone', 'UTC')
    assert.deepEqual(run.out, [
        'aut_1  Daily check  active  daily at 09:00 (UTC) · next 2026-10-01 09:00'
    ])
})

test('update: --at alone re-times the automation’s own preset, keeping its day', async () => {
    const weekly = detail({
        schedulePreset: 'weekly',
        rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=0;BYSECOND=0'
    })
    const retimed = await runMf(
        ['automations', 'update', 'aut_1', '--at', '07:15'],
        {
            'GET /automations/aut_1': () => json(weekly),
            'PATCH /automations/aut_1': (call) =>
                json({ ...weekly, ...(call.body as object) })
        }
    )
    assert.equal(retimed.error, undefined, String(retimed.error))
    assert.deepEqual(posted(retimed), {
        schedulePreset: 'weekly',
        rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TH;BYHOUR=7;BYMINUTE=15;BYSECOND=0'
    })
    assert.match(retimed.out.join('\n'), /weekly on Thursday at 07:15 \(UTC\)/)

    const custom = await runMf(
        [
            'automations',
            'update',
            'aut_1',
            '--rrule',
            'FREQ=MONTHLY;BYMONTHDAY=1'
        ],
        {
            'PATCH /automations/aut_1': (call) =>
                json({ ...weekly, ...(call.body as object) })
        }
    )
    assert.deepEqual(posted(custom), {
        schedulePreset: 'custom',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=1'
    })
    // No GET: an --rrule needs nothing from the current schedule.
    assert.equal(
        custom.calls.some((call) => call.method === 'GET'),
        false
    )

    const onCustom = await runMf(
        ['automations', 'update', 'aut_1', '--at', '07:15'],
        {
            'GET /automations/aut_1': () =>
                json(
                    detail({
                        schedulePreset: 'custom',
                        rrule: 'FREQ=MONTHLY;BYMONTHDAY=1'
                    })
                )
        }
    )
    assert.match(usageError(onCustom), /runs on a custom --rrule/)
})

const aRun = (
    over: Partial<AutomationRunSummary> = {}
): AutomationRunSummary => ({
    id: 'aur_1',
    automationId: 'aut_1',
    trigger: 'manual',
    status: 'running',
    chatSessionId: 'cts_1',
    assistantMessageId: 'msg_a',
    errorMessage: null,
    deliveryStatus: null,
    resultPreview: null,
    startedAt: '2026-09-30T08:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-30T08:00:00.000Z',
    ...over
})

const succeeded = aRun({
    status: 'succeeded',
    deliveryStatus: 'sent',
    resultPreview: 'All clear.',
    finishedAt: '2026-09-30T08:00:12.500Z'
})

const turnUsage = {
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 10,
    outputTokens: 122,
    cacheReadTokens: 0,
    cacheCreationTokens: 29593,
    costUsd: 0.0376,
    costSource: 'table',
    firstTokenMs: 900,
    totalMs: 3100
}

const reply: StreamEvent[] = [
    chatEvent('token', 1, { text: 'All ' }),
    chatEvent('tool_call', 2, {
        toolCallId: 't1',
        toolName: 'Bash',
        args: { command: 'git status' }
    }),
    chatEvent('token', 3, { text: 'clear.' }),
    chatEvent('usage', 4, { usage: turnUsage }),
    chatEvent('done', 5, { finalMessageId: 'msg_a' })
]

// What a person reads on stderr about a run that went well.
const endedWell = [
    '→ Bash git status',
    'claude-haiku-4-5-20251001 · 10 in / 29.6k cache / 122 out · $0.0376 · 12.5 s',
    'session cts_1 · continue: mf agent send agt_1 --session cts_1 "…"',
    'run aur_1 succeeded · sent to its channel'
]

// The automation before its run, and after it `settled` into.
const waitRoutes = (
    events: StreamEvent[],
    settled: AutomationRunSummary,
    over: Record<string, Route> = {}
): Record<string, Route> => ({
    'GET /automations/aut_1': (_call, index) =>
        json(detail({ runs: index === 0 ? [] : [settled] })),
    'POST /automations/aut_1/run': () => json(aRun(), 201),
    'GET /agents/agt_1/sessions/cts_1/stream': () => sse(events),
    ...over
})

const streamed = (run: Run) =>
    run.calls.filter((call) => call.path.endsWith('/stream'))

test('run --wait follows the reply to its end, then says how the run ended', async () => {
    const listeners = process.listenerCount('SIGINT')
    const run = await runMf(
        ['automations', 'run', 'aut_1', '--wait'],
        waitRoutes(reply, succeeded)
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.equal(run.exitCode, 0)
    assert.deepEqual(run.out, ['All clear.'])
    assert.deepEqual(run.err, [
        'run aur_1 is running · following its reply (Ctrl-C stops following; the run goes on)',
        ...endedWell
    ])
    assert.equal(streamed(run)[0]?.query.get('replayMessageId'), 'msg_a')
    assert.equal(
        run.calls.some((call) => call.path.endsWith('/cancel')),
        false
    )
    assert.equal(process.listenerCount('SIGINT'), listeners)
})

test('run --wait exits 1 for a run that failed, with what failed it', async () => {
    const run = await runMf(
        ['automations', 'run', 'aut_1', '--wait'],
        waitRoutes(
            [
                chatEvent('token', 1, { text: 'Checking' }),
                chatEvent('error', 2, {
                    error: {
                        code: 'provider_error',
                        message: 'upstream 529: overloaded',
                        retryable: true
                    }
                })
            ],
            aRun({
                status: 'failed',
                errorMessage: 'upstream 529: overloaded',
                finishedAt: '2026-09-30T08:00:03.000Z'
            })
        )
    )
    assert.equal(run.exitCode, 1)
    assert.equal(
        run.err.at(-1),
        'run aur_1 failed: upstream 529: overloaded (provider_error)'
    )
})

test('run --wait --json prints the ended run and its reply as one object', async () => {
    const run = await runMf(
        ['automations', 'run', 'aut_1', '--wait', '--json'],
        waitRoutes(reply, succeeded)
    )
    assert.deepEqual(JSON.parse(run.out.join('\n')), {
        run: succeeded,
        text: 'All clear.',
        usage: turnUsage,
        error: null
    })
    assert.deepEqual(run.err, [])
})

test('run alone starts the run and says where its result will be', async () => {
    const run = await runMf(['automations', 'run', 'aut_1'], {
        'POST /automations/aut_1/run': () => json(aRun(), 201)
    })
    assert.deepEqual(run.out, ['aur_1  manual  running'])
    assert.deepEqual(run.err, [
        'its result: mf automations result aut_1 --run aur_1, or trigger with --wait to follow it'
    ])
    assert.deepEqual(
        run.calls.map((call) => `${call.method} ${call.path}`),
        ['POST /automations/aut_1/run']
    )
    const thinking = await runMf([
        'automations',
        'run',
        'aut_1',
        '--show-thinking'
    ])
    assert.match(usageError(thinking), /--show-thinking goes with --wait/)
})

test('a run already going is pointed at rather than started again', async () => {
    const run = await runMf(['automations', 'run', 'aut_1', '--wait'], {
        'GET /automations/aut_1': () => json(detail({ runs: [aRun()] })),
        'POST /automations/aut_1/run': () =>
            json(
                {
                    error: {
                        code: 'bad_request',
                        message: 'automation already has a running run'
                    }
                },
                409
            )
    })
    assert.equal(run.exitCode, 1)
    assert.match(run.err.join('\n'), /already has a running run/)
    assert.match(
        run.err.join('\n'),
        /Follow that run with mf automations result aut_1/
    )
})

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: 'msg_a',
    sessionId: 'cts_1',
    role: 'assistant',
    contentBlocks: [
        { type: 'thinking', text: 'Look at git first.' },
        {
            type: 'tool_call',
            toolCallId: 't1',
            toolName: 'Bash',
            args: { command: 'git status' }
        },
        { type: 'text', text: 'All clear.' }
    ],
    createdAt: '2026-09-30T08:00:12.000Z',
    usage: turnUsage as ChatMessage['usage'],
    error: null,
    ...over
})

const page = (
    messages: ChatMessage[],
    over: Partial<ChatMessagesPage> = {}
): ChatMessagesPage =>
    ({
        messages,
        hasMore: false,
        nextBefore: null,
        inflightAssistantMessageId: null,
        inflightCheckpointEventId: null,
        ...over
    }) as ChatMessagesPage

const prompt = message({
    id: 'msg_u',
    role: 'user',
    contentBlocks: [{ type: 'text', text: 'Check the workspace.' }],
    usage: null
})

test('result reads an ended run back as it streamed: the latest run by default', async () => {
    const run = await runMf(['automations', 'result', 'aut_1'], {
        'GET /automations/aut_1': () =>
            json(
                detail({
                    runs: [succeeded, aRun({ id: 'aur_0', status: 'failed' })]
                })
            ),
        'GET /agents/agt_1/sessions/cts_1/messages': () =>
            json(page([prompt, message()]))
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.equal(run.exitCode, 0)
    assert.deepEqual(run.out, ['All clear.'])
    assert.deepEqual(run.err, endedWell)
    assert.deepEqual(streamed(run), [])

    const asJson = await runMf(
        ['automations', 'result', 'aut_1', '--json', '--show-thinking'],
        {
            'GET /automations/aut_1': () => json(detail({ runs: [succeeded] })),
            'GET /agents/agt_1/sessions/cts_1/messages': () =>
                json(page([prompt, message()]))
        }
    )
    assert.deepEqual(JSON.parse(asJson.out.join('\n')), {
        run: succeeded,
        text: 'All clear.',
        thinking: 'Look at git first.',
        usage: turnUsage,
        error: null
    })
})

test('result --run reads that run, paging back through its session', async () => {
    const older = aRun({
        id: 'aur_0',
        status: 'succeeded',
        chatSessionId: 'cts_0',
        assistantMessageId: 'msg_0',
        finishedAt: '2026-09-30T08:00:12.500Z'
    })
    const run = await runMf(
        ['automations', 'result', 'aut_1', '--run', 'aur_0'],
        {
            'GET /automations/aut_1': () =>
                json(detail({ runs: [succeeded, older] })),
            // The session went on after the run: its reply is on an older page.
            'GET /agents/agt_1/sessions/cts_0/messages': (_call, index) =>
                json(
                    index === 0
                        ? page(
                              [
                                  message({
                                      id: 'msg_later',
                                      sessionId: 'cts_0'
                                  })
                              ],
                              {
                                  hasMore: true,
                                  nextBefore: 'cursor_1'
                              }
                          )
                        : page([
                              message({
                                  id: 'msg_0',
                                  sessionId: 'cts_0',
                                  contentBlocks: [
                                      {
                                          type: 'text',
                                          text: 'Yesterday: all clear.'
                                      }
                                  ]
                              })
                          ])
                )
        }
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, ['Yesterday: all clear.'])
    const pages = run.calls.filter((call) => call.path.endsWith('/messages'))
    assert.deepEqual(
        pages.map((call) => call.query.get('before')),
        [null, 'cursor_1']
    )
})

test('result follows a run still going to its end', async () => {
    const run = await runMf(['automations', 'result', 'aut_1'], {
        'GET /automations/aut_1': (_call, index) =>
            json(detail({ runs: [index === 0 ? aRun() : succeeded] })),
        'GET /agents/agt_1/sessions/cts_1/stream': () => sse(reply)
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, ['All clear.'])
    assert.equal(run.err.at(-1), 'run aur_1 succeeded · sent to its channel')
    assert.equal(streamed(run)[0]?.query.get('replayMessageId'), 'msg_a')
})

test('result says why a run failed, and what a run without a reply left', async () => {
    const neverSent = await runMf(['automations', 'result', 'aut_1'], {
        'GET /automations/aut_1': () =>
            json(
                detail({
                    runs: [
                        aRun({
                            status: 'failed',
                            chatSessionId: null,
                            assistantMessageId: null,
                            errorMessage: 'agent is stopped',
                            finishedAt: '2026-09-30T08:00:00.200Z'
                        })
                    ]
                })
            )
    })
    assert.equal(neverSent.exitCode, 1)
    assert.deepEqual(neverSent.out, [])
    assert.deepEqual(neverSent.err, ['run aur_1 failed: agent is stopped'])

    // No messages route: the run's session was deleted.
    const sessionGone = await runMf(['automations', 'result', 'aut_1'], {
        'GET /automations/aut_1': () => json(detail({ runs: [succeeded] }))
    })
    assert.equal(sessionGone.error, undefined, String(sessionGone.error))
    assert.deepEqual(sessionGone.out, ['All clear.'])
    assert.deepEqual(sessionGone.err, [
        "(the reply's first line, as the run recorded it: its chat session is gone)",
        'run aur_1 succeeded · sent to its channel'
    ])
})

test('result names a run it does not have', async () => {
    const unknown = await runMf(
        ['automations', 'result', 'aut_1', '--run', 'aur_9'],
        { 'GET /automations/aut_1': () => json(detail({ runs: [succeeded] })) }
    )
    assert.match(
        String(unknown.error),
        /aur_9 is not one of the 1 latest runs of aut_1 \(mf automations get aut_1 lists them\)/
    )
    const never = await runMf(['automations', 'result', 'aut_1'], {
        'GET /automations/aut_1': () => json(detail())
    })
    assert.match(
        String(never.error),
        /aut_1 has not run yet: mf automations run aut_1 --wait/
    )
})

test(
    'Ctrl-C stops following a run, not the run, and exits 130',
    { timeout: 60_000 },
    async (t) => {
        const seen: string[] = []
        let opened = () => {}
        const streamOpen = new Promise<void>((resolve) => (opened = resolve))
        const server = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://x')
            seen.push(`${req.method} ${url.pathname}`)
            const send = (status: number, body: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' })
                res.end(JSON.stringify(body))
            }
            if (url.pathname === '/api/automations/aut_1') send(200, detail())
            else if (url.pathname === '/api/automations/aut_1/run')
                send(201, aRun())
            else if (url.pathname.endsWith('/stream')) {
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                res.write(sseFrame(chatEvent('token', 1, { text: 'Checking' })))
                opened()
            } else send(404, { error: { code: 'not_found', message: '' } })
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const dir = await mkdtemp(join(tmpdir(), 'mf-automations-child-'))
        t.after(async () => {
            server.closeAllConnections()
            server.close()
            await rm(dir, { recursive: true, force: true })
        })
        const child = spawnMf(
            [
                '--api-url',
                `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
                'automations',
                'run',
                'aut_1',
                '--wait'
            ],
            { HOME: dir, MF_CONFIG_DIR: dir, MF_API_TOKEN: 'nca_rt_env' }
        )
        let stderr = ''
        child.stderr.on('data', (data) => (stderr += data))
        const closed = once(child, 'close')
        await Promise.race([
            streamOpen,
            closed.then(() => {
                throw new Error(`mf exited before the stream opened: ${stderr}`)
            })
        ])
        child.kill('SIGINT')
        const [code] = await closed
        assert.equal(code, 130, stderr)
        assert.match(
            stderr,
            /stopped following run aur_1; it goes on\. Its result: mf automations result aut_1 --run aur_1/
        )
        assert.equal(
            seen.some((request) => request.includes('/cancel')),
            false,
            seen.join('\n')
        )
    }
)
