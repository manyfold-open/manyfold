import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUsageInstant } from '../src/usage'

const iso = (value: string): string | null =>
    parseUsageInstant(value)?.toISOString() ?? null

test('a date, or a date and a time, is an instant; no zone means UTC', () => {
    assert.equal(iso('2026-10-01'), '2026-10-01T00:00:00.000Z')
    assert.equal(iso('2026-10-01T09:30'), '2026-10-01T09:30:00.000Z')
    assert.equal(iso('2026-10-01T09:30:15'), '2026-10-01T09:30:15.000Z')
    assert.equal(iso('2026-09-30T23:12:42.241Z'), '2026-09-30T23:12:42.241Z')
    assert.equal(iso('2026-10-01T09:30:15.123456789Z'), '2026-10-01T09:30:15.123Z')
})

test('a zone offset moves the instant to UTC', () => {
    assert.equal(iso('2026-10-01T09:00:00+01:00'), '2026-10-01T08:00:00.000Z')
    assert.equal(iso('2026-10-01T09:00:00-0530'), '2026-10-01T14:30:00.000Z')
    assert.equal(iso('2026-10-01T00:30+02:00'), '2026-09-30T22:30:00.000Z')
})

test('what Date.parse would bend into some other instant is refused', () => {
    for (const value of [
        '1',
        'hello 1',
        '2026-02-30',
        '2026-13-01',
        '2026-10-01T24:00',
        '2026-10-01T09:60',
        '2026-10-01 09:00',
        '2026-10-01T09',
        '2026-10-01T09:00+25:00',
        'Oct 1 2026',
        ' 2026-10-01',
        ''
    ])
        assert.equal(parseUsageInstant(value), null, value)
})

test('a leap day exists only in a leap year', () => {
    assert.equal(iso('2028-02-29'), '2028-02-29T00:00:00.000Z')
    assert.equal(parseUsageInstant('2026-02-29'), null)
})
