import { BadRequestException } from '@nestjs/common'
import { rrulestr } from 'rrule'

// The time `date` shows on a clock in `timeZone`, as the UTC date with
// those fields: the "floating" time a rule is evaluated on.
const wallClock = (date: Date, timeZone: string): Date => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(date)
    const get = (type: string): number =>
        Number(parts.find((part) => part.type === type)?.value ?? 0)
    return new Date(
        Date.UTC(
            get('year'),
            get('month') - 1,
            get('day'),
            get('hour'),
            get('minute'),
            get('second'),
            date.getUTCMilliseconds()
        )
    )
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// The instant a clock in `timeZone` shows `wall`. RFC 5545 3.3.5: a time a
// DST change skips is read on the offset before the gap, and one it
// repeats is its first showing.
const instantOf = (wall: Date, timeZone: string): Date => {
    const at = wall.getTime()
    const offsetAt = (instant: number): number =>
        wallClock(new Date(instant), timeZone).getTime() - instant
    const before = offsetAt(at - DAY_MS)
    const shown = [before, offsetAt(at + DAY_MS)]
        .map((offset) => at - offset)
        .filter(
            (instant) => wallClock(new Date(instant), timeZone).getTime() === at
        )
    return new Date(shown.length > 0 ? Math.min(...shown) : at - before)
}

const icalUtc = (date: Date): string =>
    `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`

// The first time `rrule` fires after `after`, at the times of day it names
// in `timezone`. The rule runs on floating time (its DTSTART in UTC with
// the zone's wall-clock fields) and only what it yields is placed in the
// zone: rrule's own TZID support converts through the zone the process
// runs in, which put every run off by that zone's UTC offset on any host
// not on UTC.
export const nextOccurrence = (input: {
    after: Date
    dtstart: Date
    rrule: string
    timezone: string
}): Date | null => {
    try {
        const rule = rrulestr(
            `DTSTART:${icalUtc(wallClock(input.dtstart, input.timezone))}\n${input.rrule}`
        ) as {
            after: (date: Date, inc?: boolean) => Date | null
            between: (after: Date, before: Date, inc?: boolean) => Date[]
        }
        const wall = wallClock(input.after, input.timezone)
        // In a repeated hour's second showing, what is left of it ran at
        // its first: the next two hours are read one by one, then on.
        const horizon = new Date(wall.getTime() + 2 * HOUR_MS)
        for (const occurrence of rule.between(wall, horizon, false)) {
            const instant = instantOf(occurrence, input.timezone)
            if (instant.getTime() > input.after.getTime()) return instant
        }
        const later = rule.after(horizon, true)
        return later ? instantOf(later, input.timezone) : null
    } catch (err) {
        if (err instanceof BadRequestException) throw err
        throw new BadRequestException(
            `invalid schedule: ${(err as Error).message}`
        )
    }
}
