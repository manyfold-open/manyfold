import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DEFAULT_ACTIVITY_WINDOW_DAYS,
    MAX_ACTIVITY_WINDOW_DAYS,
    resolveActivityWindowDays
} from '../src/modules/channels/channel-activity-window'

test('defaults to 30 days for anything unusable', () => {
    for (const requested of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])
        assert.equal(
            resolveActivityWindowDays(requested, null),
            DEFAULT_ACTIVITY_WINDOW_DAYS
        )
})

test('clamps a request to the maximum span', () => {
    assert.equal(
        resolveActivityWindowDays(365, null),
        MAX_ACTIVITY_WINDOW_DAYS
    )
    assert.equal(resolveActivityWindowDays(14, null), 14)
    assert.equal(resolveActivityWindowDays(7.9, null), 7)
})

test('never reports a window longer than delivery retention', () => {
    // The point of the module: a deployment that keeps 7 days of deliveries
    // must not label a 7-day count as 30 days.
    assert.equal(resolveActivityWindowDays(undefined, 7), 7)
    assert.equal(resolveActivityWindowDays(90, 30), 30)
    assert.equal(resolveActivityWindowDays(14, 30), 14)
})

test('pruning disabled means retention imposes no clamp', () => {
    assert.equal(
        resolveActivityWindowDays(undefined, null),
        DEFAULT_ACTIVITY_WINDOW_DAYS
    )
    assert.equal(resolveActivityWindowDays(90, null), 90)
})

test('never resolves to a zero-length window', () => {
    assert.equal(resolveActivityWindowDays(30, 0), 1)
})
