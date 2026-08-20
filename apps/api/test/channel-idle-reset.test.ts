import assert from 'node:assert/strict'
import test from 'node:test'
import {
    parseResetOnIdleMins,
    shouldAutoResetOnIdle,
    mostRecentDate
} from '../src/modules/channels/config-helpers'

test('parseResetOnIdleMins accepts positive integers', () => {
    assert.equal(parseResetOnIdleMins(30), 30)
    assert.equal(parseResetOnIdleMins(1), 1)
})

test('parseResetOnIdleMins returns null for non-numbers and non-positive', () => {
    assert.equal(parseResetOnIdleMins(undefined), null)
    assert.equal(parseResetOnIdleMins(null), null)
    assert.equal(parseResetOnIdleMins('30'), null)
    assert.equal(parseResetOnIdleMins(0), null)
    assert.equal(parseResetOnIdleMins(-5), null)
    assert.equal(parseResetOnIdleMins(NaN), null)
    assert.equal(parseResetOnIdleMins(Infinity), null)
})

test('parseResetOnIdleMins caps at 1 week and floors decimals', () => {
    assert.equal(parseResetOnIdleMins(99999), 60 * 24 * 7)
    assert.equal(parseResetOnIdleMins(30.7), 30)
})

test('shouldAutoResetOnIdle returns false when mins missing or non-positive', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000)
    assert.equal(shouldAutoResetOnIdle(null, past), false)
    assert.equal(shouldAutoResetOnIdle(undefined, past), false)
    assert.equal(shouldAutoResetOnIdle(0, past), false)
    assert.equal(shouldAutoResetOnIdle(-1, past), false)
})

test('shouldAutoResetOnIdle returns false for recent activity', () => {
    const recent = new Date(Date.now() - 10_000)
    assert.equal(shouldAutoResetOnIdle(30, recent), false)
})

test('shouldAutoResetOnIdle returns true once threshold exceeded', () => {
    const now = new Date('2026-05-15T10:00:00Z')
    const stale = new Date(now.getTime() - 31 * 60_000)
    assert.equal(shouldAutoResetOnIdle(30, stale, now), true)
})

test('shouldAutoResetOnIdle returns false when no activity timestamp', () => {
    assert.equal(shouldAutoResetOnIdle(30, null), false)
})

test('mostRecentDate picks the latest of several', () => {
    const a = new Date('2026-05-15T10:00:00Z')
    const b = new Date('2026-05-15T10:30:00Z')
    const c = new Date('2026-05-15T09:00:00Z')
    assert.equal(mostRecentDate(a, b, c)?.toISOString(), b.toISOString())
})

test('mostRecentDate ignores null and undefined', () => {
    const a = new Date('2026-05-15T10:00:00Z')
    assert.equal(mostRecentDate(null, a, undefined)?.toISOString(), a.toISOString())
    assert.equal(mostRecentDate(null, undefined), null)
})
