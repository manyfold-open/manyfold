import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError } from 'commander'
import type { AutomationDetail } from '@manyfold/shared'
import { json, runMf, type Run } from './fixtures/fake-api'

// `mf automations`: when an automation runs is said once, as a preset (timed
// with --at and --day) or as an --rrule, in this machine's timezone unless
// told otherwise.

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
