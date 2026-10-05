import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveUsagePeriod } from '@/common/usage-period/usage-period'

const iso = (d: Date): string => d.toISOString()

const providerPeriod = (start: string, end: string) => ({
    currentPeriodStartAt: new Date(start),
    currentPeriodEndAt: new Date(end),
    startedAt: new Date(start)
})

// A monthly period is the window as it stands, including the 31 days that
// follow a February clamped from a day-31 anchor.
test('a monthly provider period is the usage window as it stands', () => {
    for (const [start, end, now] of [
        ['2026-06-30T15:14:57.413Z', '2026-07-30T15:16:50.000Z', '2026-07-15T00:00:00Z'],
        ['2026-02-28T10:00:00.000Z', '2026-03-31T10:00:00.000Z', '2026-03-30T00:00:00Z']
    ]) {
        const p = resolveUsagePeriod(providerPeriod(start, end), new Date(now))
        assert.equal(p.source, 'subscription')
        assert.equal(iso(p.start), start)
        assert.equal(iso(p.end), end)
    }
})

// The plan allowances are monthly. Metered over a whole annual term, one
// month's use stayed spent until the term ended.
test('an annual provider period is metered month by month from its start', () => {
    const sub = providerPeriod('2026-07-24T16:13:40.000Z', '2027-07-24T16:13:40.000Z')
    const p = resolveUsagePeriod(sub, new Date('2026-10-05T09:00:00Z'))
    assert.equal(p.source, 'subscription')
    assert.equal(iso(p.start), '2026-09-24T16:13:40.000Z')
    assert.equal(iso(p.end), '2026-10-24T16:13:40.000Z')
})

test('a month inside a long term starts exactly on its anniversary', () => {
    const sub = providerPeriod('2026-07-24T16:13:40.000Z', '2027-07-24T16:13:40.000Z')
    const p = resolveUsagePeriod(sub, new Date('2026-10-24T16:13:40.000Z'))
    assert.equal(iso(p.start), '2026-10-24T16:13:40.000Z')
    assert.equal(iso(p.end), '2026-11-24T16:13:40.000Z')
})

test('the last month of a long term ends with the term', () => {
    const sub = providerPeriod('2026-07-24T16:13:40.000Z', '2027-12-31T00:00:00.000Z')
    const p = resolveUsagePeriod(sub, new Date('2027-12-28T00:00:00Z'))
    assert.equal(iso(p.start), '2027-12-24T16:13:40.000Z')
    assert.equal(iso(p.end), '2027-12-31T00:00:00.000Z')
})

test('months inside a long term keep a day-31 start without drifting', () => {
    const sub = providerPeriod('2026-01-31T10:00:00.000Z', '2027-01-31T10:00:00.000Z')
    const window = (now: string): string => {
        const p = resolveUsagePeriod(sub, new Date(now))
        return `${iso(p.start)} ${iso(p.end)}`
    }
    assert.equal(window('2026-03-15T00:00:00Z'), '2026-02-28T10:00:00.000Z 2026-03-31T10:00:00.000Z')
    assert.equal(window('2026-04-15T00:00:00Z'), '2026-03-31T10:00:00.000Z 2026-04-30T10:00:00.000Z')
})
