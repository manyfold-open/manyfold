import assert from 'node:assert/strict'
import test from 'node:test'
import { nextOccurrence } from '../src/modules/automations/next-occurrence'

// When an automation runs next: at the wall-clock time its rule names in the
// automation's own zone, whatever zone the API process runs in.

const HOSTS = ['UTC', 'Europe/London', 'Asia/Shanghai', 'America/Los_Angeles']

// `fn` once under each host zone, as the TZ the API runs with.
const onEachHost = (fn: (host: string) => void): void => {
    const saved = process.env.TZ
    try {
        for (const host of HOSTS) {
            process.env.TZ = host
            fn(host)
        }
    } finally {
        if (saved === undefined) delete process.env.TZ
        else process.env.TZ = saved
    }
}

const next = (rrule: string, timezone: string, after: string) =>
    nextOccurrence({
        rrule,
        timezone,
        dtstart: new Date(after),
        after: new Date(after)
    })?.toISOString()

test("a rule's time is its zone's wall-clock time, on any host", () => {
    const after = '2026-09-30T06:07:50.957Z'
    onEachHost((host) => {
        // 23:50 in London, on British Summer Time.
        assert.equal(
            next(
                'RRULE:FREQ=DAILY;BYHOUR=23;BYMINUTE=50;BYSECOND=0',
                'Europe/London',
                after
            ),
            '2026-09-30T22:50:00.000Z',
            host
        )
        assert.equal(
            next(
                'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
                'Asia/Shanghai',
                after
            ),
            '2026-10-01T01:00:00.000Z',
            host
        )
        // The weekday is the zone's too: Friday 18:00 in Los Angeles.
        assert.equal(
            next(
                'RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0;BYSECOND=0',
                'America/Los_Angeles',
                after
            ),
            '2026-10-03T01:00:00.000Z',
            host
        )
        // A half-hour zone: 11:37 in Kolkata, so :15 is 12:15.
        assert.equal(
            next(
                'RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=15;BYSECOND=0',
                'Asia/Kolkata',
                after
            ),
            '2026-09-30T06:45:00.000Z',
            host
        )
        assert.equal(
            next(
                'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
                'UTC',
                after
            ),
            '2026-09-30T09:00:00.000Z',
            host
        )
    })
})

// RFC 5545 3.3.5: a local time a change skips is read on the offset before
// the gap; one it repeats is its first showing.
test('across a DST change: a skipped time runs when the change moved it to, a repeated one at its first showing', () => {
    const daily = 'RRULE:FREQ=DAILY;BYHOUR=1;BYMINUTE=30;BYSECOND=0'
    onEachHost((host) => {
        // London skips 01:00–02:00 on 2027-03-28: 01:30 is 02:30 BST.
        assert.equal(
            next(daily, 'Europe/London', '2027-03-27T12:00:00.000Z'),
            '2027-03-28T01:30:00.000Z',
            host
        )
        // And shows 01:00–02:00 twice on 2026-10-25: first on BST.
        assert.equal(
            next(daily, 'Europe/London', '2026-10-24T12:00:00.000Z'),
            '2026-10-25T00:30:00.000Z',
            host
        )
        // A run at the first showing is not repeated at the second.
        assert.equal(
            next(daily, 'Europe/London', '2026-10-25T00:30:00.000Z'),
            '2026-10-26T01:30:00.000Z',
            host
        )
        // During the second showing, what is left of the hour has run.
        assert.equal(
            next(
                'RRULE:FREQ=MINUTELY;INTERVAL=5;BYSECOND=0',
                'Europe/London',
                '2026-10-25T01:10:00.000Z'
            ),
            '2026-10-25T02:00:00.000Z',
            host
        )
    })
})
