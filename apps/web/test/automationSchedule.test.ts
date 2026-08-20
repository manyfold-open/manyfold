import assert from 'node:assert/strict'
import test from 'node:test'
import { getLocale, setLanguage } from '@manyfold/i18n'
import {
    describeRrule,
    formatExactDateTime,
    formatNextRun,
    formatNextRunTerse,
    formatRelativePast,
    formatRunDuration
} from '../src/pages/Automations/automationSchedule'

setLanguage('en')

// Times render through Intl, so the expected clock string is built the same way
// the formatter builds it: the assertions are about sentence shape and branch
// selection, not about one machine's ICU output.
const clock = (hour: number, minute: number): string =>
    new Date(2000, 0, 1, hour, minute).toLocaleTimeString(getLocale(), {
        hour: 'numeric',
        minute: '2-digit'
    })

const weekdayList = (...days: string[]): string =>
    new Intl.ListFormat(getLocale(), {
        style: 'long',
        type: 'conjunction'
    }).format(days)

const localDay = (offsetDays: number, hour = 10, minute = 30): string => {
    const now = new Date()
    return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + offsetDays,
        hour,
        minute
    ).toISOString()
}

const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString()

const clockIn = (iso: string, timeZone: string): string =>
    new Date(iso).toLocaleTimeString(getLocale(), {
        timeZone,
        hour: 'numeric',
        minute: '2-digit'
    })

const ok = (rrule: string): string => {
    const described = describeRrule(rrule)
    assert.equal(described.ok, true, `expected ${rrule} to parse`)
    return described.ok ? described.text : ''
}

const failure = (rrule: string): string => {
    const described = describeRrule(rrule)
    assert.equal(described.ok, false, `expected ${rrule} to be rejected`)
    return described.ok ? '' : described.message
}

test('describeRrule reads hourly rules back with their minute offset', () => {
    assert.equal(
        ok('RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0'),
        'Every hour at :00'
    )
    assert.equal(
        ok('FREQ=HOURLY;INTERVAL=3;BYMINUTE=5'),
        'Every 3 hours at :05'
    )
})

test('describeRrule reads daily rules back at their time', () => {
    assert.equal(
        ok('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0'),
        `Every day at ${clock(9, 0)}`
    )
    assert.equal(
        ok('FREQ=DAILY;INTERVAL=2;BYHOUR=18;BYMINUTE=30'),
        `Every 2 days at ${clock(18, 30)}`
    )
})

test('describeRrule names every weekday a weekly rule fires on', () => {
    assert.equal(
        ok('FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=30'),
        `Every ${weekdayList('Monday', 'Wednesday')} at ${clock(9, 30)}`
    )
    assert.equal(
        ok('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=18;BYMINUTE=0'),
        `Every 2 weeks on Friday at ${clock(18, 0)}`
    )
})

test('a weekly rule covering the work week reads as "every weekday"', () => {
    assert.equal(
        ok('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0'),
        `Every weekday at ${clock(8, 0)}`
    )
    // An out-of-order work week is the same schedule, so it reads the same.
    assert.equal(
        ok('FREQ=WEEKLY;BYDAY=FR,TH,WE,TU,MO;BYHOUR=8;BYMINUTE=0'),
        `Every weekday at ${clock(8, 0)}`
    )
    // With an interval it is no longer "every" weekday.
    assert.equal(
        ok('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0'),
        `Every 2 weeks on ${weekdayList('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday')} at ${clock(8, 0)}`
    )
})

test('describeRrule reads monthly rules back with their day of month', () => {
    assert.equal(
        ok('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0'),
        `Every month on day 15 at ${clock(9, 0)}`
    )
})

test('describeRrule defaults the parts a rule leaves out', () => {
    assert.equal(ok('FREQ=DAILY'), `Every day at ${clock(9, 0)}`)
    assert.equal(ok('FREQ=WEEKLY'), `Every Monday at ${clock(9, 0)}`)
    assert.equal(ok('freq=daily'), `Every day at ${clock(9, 0)}`)
})

test('a rule without FREQ is rejected with an example to copy', () => {
    const message = failure('BYHOUR=9;BYMINUTE=0')
    assert.match(message, /FREQ/)
    assert.match(message, /FREQ=WEEKLY;BYDAY=MO;BYHOUR=9/)
})

test('an unsupported frequency names the value and the supported set', () => {
    const message = failure('FREQ=YEARLY;BYHOUR=9')
    assert.match(message, /YEARLY/)
    for (const supported of ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'])
        assert.match(message, new RegExp(supported))
})

test('an unknown weekday names the offending code', () => {
    const message = failure('FREQ=WEEKLY;BYDAY=MX;BYHOUR=9')
    assert.match(message, /BYDAY/)
    assert.match(message, /MX/)
    assert.match(message, /MO, TU, WE, TH, FR, SA or SU/)
})

test('out-of-range and non-numeric parts name the part that is wrong', () => {
    assert.match(failure('FREQ=DAILY;BYHOUR=24'), /BYHOUR/)
    assert.match(failure('FREQ=DAILY;BYHOUR=-1'), /BYHOUR/)
    assert.match(failure('FREQ=DAILY;BYHOUR=noon'), /BYHOUR/)
    assert.match(failure('FREQ=DAILY;BYHOUR=9;BYMINUTE=60'), /BYMINUTE/)
    assert.match(failure('FREQ=DAILY;INTERVAL=0'), /INTERVAL/)
    assert.match(failure('FREQ=MONTHLY;BYMONTHDAY=32'), /BYMONTHDAY/)
})

// Naming one of the hours would describe a schedule the automation does not
// keep, which is worse than admitting the rule is beyond this reader.
test('a rule firing at several hours is not narrowed down to the first', () => {
    assert.match(failure('FREQ=DAILY;BYHOUR=9,17'), /BYHOUR/)
    assert.match(failure('FREQ=DAILY;BYHOUR=9;BYMINUTE=0,30'), /BYMINUTE/)
    assert.match(failure('FREQ=MONTHLY;BYMONTHDAY=1,15'), /BYMONTHDAY/)
})

test('an hourly rule accepts the minute a preset writes without an hour', () => {
    assert.equal(
        ok('RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0;BYSECOND=0'),
        'Every hour at :00'
    )
})

test('the next run reads as a calendar day, never as a countdown', () => {
    assert.equal(formatNextRun(localDay(0)), `today, ${clock(10, 30)}`)
    assert.equal(formatNextRun(localDay(1)), `tomorrow, ${clock(10, 30)}`)
    // Inside the coming week the weekday alone locates the run.
    assert.match(formatNextRun(localDay(3)), /^[^\d]+, \d{1,2}:\d{2}/)
    assert.doesNotMatch(formatNextRun(localDay(3)), /^(today|tomorrow),/)
    // Beyond a week the weekday stops being unambiguous, so a date is used.
    assert.match(formatNextRun(localDay(10)), /\d{1,2}/)
    assert.doesNotMatch(formatNextRun(localDay(10)), /^(today|tomorrow),/)
})

test('a run already due reads as today rather than as a past date', () => {
    assert.equal(
        formatNextRun(agoIso(60000)),
        `today, ${new Date(Date.now() - 60000).toLocaleTimeString(getLocale(), { hour: 'numeric', minute: '2-digit' })}`
    )
})

// The surface prints the automation's timezone next to this time, so the clock
// has to be that timezone's — otherwise the label names a zone the number is
// not in, and a reader one zone over is told the wrong hour.
test('the next run prints its clock in the timezone it is labelled with', () => {
    const at = localDay(1)
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'])
        assert.ok(
            formatNextRun(at, zone).endsWith(clockIn(at, zone)),
            `${zone}: ${formatNextRun(at, zone)} should end with ${clockIn(at, zone)}`
        )
    // No zone passed keeps the reader's own clock.
    assert.equal(formatNextRun(at), `tomorrow, ${clock(10, 30)}`)
})

test('the exact date-time follows the timezone it is given', () => {
    const at = localDay(3)
    // 26 hours apart: no instant renders the same date and clock in both.
    assert.notEqual(
        formatExactDateTime(at, 'Pacific/Kiritimati'),
        formatExactDateTime(at, 'Etc/GMT+12')
    )
    assert.equal(formatExactDateTime(at), formatExactDateTime(at, undefined))
})

test('a next run left in the past reads as its date, not as today', () => {
    const stale = formatNextRun(localDay(-3))
    assert.doesNotMatch(stale, /^today,/)
    assert.doesNotMatch(stale, /^tomorrow,/)
    assert.match(stale, /\d/)
})

test('an unscheduled automation says so instead of showing a bare time', () => {
    assert.equal(formatNextRun(null), 'Not scheduled')
    assert.equal(formatNextRunTerse(null), 'Not scheduled')
})

test('the terse next run drops the today qualifier for copy that says "next"', () => {
    assert.equal(formatNextRunTerse(localDay(0)), clock(10, 30))
    // Any other day still needs its qualifier to be unambiguous.
    assert.equal(formatNextRunTerse(localDay(1)), `tomorrow, ${clock(10, 30)}`)
})

test('past runs read as elapsed time at every threshold', () => {
    assert.equal(formatRelativePast(agoIso(30 * 1000)), 'Just now')
    assert.equal(formatRelativePast(agoIso(59 * 1000)), 'Just now')
    assert.equal(formatRelativePast(agoIso(60 * 1000)), '1m ago')
    assert.equal(formatRelativePast(agoIso(45 * 60 * 1000)), '45m ago')
    assert.equal(formatRelativePast(agoIso(59 * 60 * 1000)), '59m ago')
    assert.equal(formatRelativePast(agoIso(60 * 60 * 1000)), '1h ago')
    assert.equal(formatRelativePast(agoIso(5 * 60 * 60 * 1000)), '5h ago')
    assert.equal(formatRelativePast(agoIso(23 * 60 * 60 * 1000)), '23h ago')
    assert.equal(formatRelativePast(agoIso(24 * 60 * 60 * 1000)), '1d ago')
    assert.equal(formatRelativePast(agoIso(6 * 24 * 60 * 60 * 1000)), '6d ago')
})

test('a past run older than a week falls back to its date', () => {
    const older = formatRelativePast(agoIso(10 * 24 * 60 * 60 * 1000))
    assert.doesNotMatch(older, /ago/)
    assert.match(older, /\d{1,2}/)
})

test('run duration reads in seconds below a minute and in minutes above it', () => {
    const started = '2026-04-28T09:00:00.000Z'
    assert.equal(formatRunDuration(started, '2026-04-28T09:00:42.000Z'), '42s')
    assert.equal(formatRunDuration(started, '2026-04-28T09:00:59.000Z'), '59s')
    assert.equal(
        formatRunDuration(started, '2026-04-28T09:01:00.000Z'),
        '1m 0s'
    )
    assert.equal(
        formatRunDuration(started, '2026-04-28T09:01:12.000Z'),
        '1m 12s'
    )
    assert.equal(
        formatRunDuration(started, '2026-04-28T09:02:30.000Z'),
        '2m 30s'
    )
})

test('a duration too short or impossible to measure is omitted', () => {
    const started = '2026-04-28T09:00:00.000Z'
    // A still-running run has no duration to show yet.
    assert.equal(formatRunDuration(started, null), null)
    // Sub-second runs round up so the row never reads "0s".
    assert.equal(formatRunDuration(started, '2026-04-28T09:00:00.400Z'), '1s')
    // Clock skew must not render a negative duration.
    assert.equal(formatRunDuration(started, '2026-04-28T08:59:59.000Z'), null)
})
