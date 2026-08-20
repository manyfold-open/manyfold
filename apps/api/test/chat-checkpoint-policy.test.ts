import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldCheckpointContent } from '../src/modules/chat/chat.service'

// The pure half of the content-checkpoint rule. The end-to-end cadence lives
// in chat-content-checkpoint.test.ts; these cover the two clauses that are
// keyed off elapsed time, which a synthetic turn runs through too fast to
// reach.
test('a tool boundary below the growth bar waits for its minimum interval', () => {
    const base = {
        pendingChars: 2000,
        contentChars: 5000,
        sinceFailureMs: null,
        forced: false
    }
    assert.equal(
        shouldCheckpointContent({
            ...base,
            sinceCheckpointMs: 6000,
            toolBoundary: false
        }),
        false,
        'below the 8 KiB floor, a plain token must not checkpoint'
    )
    assert.equal(
        shouldCheckpointContent({
            ...base,
            sinceCheckpointMs: 1000,
            toolBoundary: true
        }),
        false,
        'a tool boundary must not checkpoint again within the interval'
    )
    assert.equal(
        shouldCheckpointContent({
            ...base,
            sinceCheckpointMs: 6000,
            toolBoundary: true
        }),
        true,
        'past the interval a tool boundary checkpoints at the lower floor'
    )
})

// The ceiling is the only rule that can rewrite the row without the content
// having grown, so a flat interval would reintroduce a duration-bound term:
// a 2-hour turn would write the whole row D/60s times whatever its size.
// Scaling it with content makes the cost flat instead — at most one row per
// 32 KiB-minute, i.e. ~32 KiB per minute of turn duration at any size.
test('the slow-content ceiling eventually writes a trickle', () => {
    const trickle = {
        pendingChars: 5,
        contentChars: 4_000,
        toolBoundary: false,
        sinceFailureMs: null,
        forced: false
    }
    assert.equal(
        shouldCheckpointContent({ ...trickle, sinceCheckpointMs: 59_000 }),
        false
    )
    assert.equal(
        shouldCheckpointContent({ ...trickle, sinceCheckpointMs: 61_000 }),
        true
    )
})

test('the ceiling interval scales with content size', () => {
    const big = {
        pendingChars: 5,
        contentChars: 320 * 1024,
        toolBoundary: false,
        sinceFailureMs: null,
        forced: false
    }
    // 320 KiB is ten 32 KiB units, so ten minutes rather than one.
    assert.equal(
        shouldCheckpointContent({ ...big, sinceCheckpointMs: 9 * 60_000 }),
        false,
        'a large row must not be rewritten on the small-turn interval'
    )
    assert.equal(
        shouldCheckpointContent({ ...big, sinceCheckpointMs: 11 * 60_000 }),
        true
    )

    // The property that makes the bound flat: whatever the size, ceiling
    // writes cost no more than 32 KiB per minute of turn duration.
    for (const contentChars of [1, 8_192, 32_768, 200_000, 4_000_000]) {
        let waited = 0
        while (
            !shouldCheckpointContent({
                pendingChars: 1,
                contentChars,
                sinceCheckpointMs: waited,
                sinceFailureMs: null,
                toolBoundary: false,
                forced: false
            })
        )
            waited += 1_000
        const charsPerMinute = contentChars / (waited / 60_000)
        assert.ok(
            charsPerMinute <= 32 * 1024 + 1,
            `ceiling cost at ${contentChars} chars was ${Math.round(charsPerMinute)} chars/min`
        )
    }
})

test('a write needs something to say', () => {
    assert.equal(
        shouldCheckpointContent({
            pendingChars: 0,
            contentChars: 200_000,
            sinceCheckpointMs: 600_000,
            sinceFailureMs: null,
            toolBoundary: true,
            forced: false
        }),
        false
    )
    assert.equal(
        shouldCheckpointContent({
            pendingChars: 0,
            contentChars: 200_000,
            sinceCheckpointMs: 0,
            sinceFailureMs: null,
            toolBoundary: false,
            forced: true
        }),
        true
    )
})

// A failed write leaves its bytes owed, so pendingChars and the forced flag
// survive it — which would otherwise retry on every following event, because
// the growth rule is byte-based and those bytes are already past the bar.
test('a failed write backs off before anything retries', () => {
    const owed = {
        pendingChars: 64 * 1024,
        contentChars: 64 * 1024,
        sinceCheckpointMs: 10,
        toolBoundary: false,
        forced: false
    }
    assert.equal(
        shouldCheckpointContent({ ...owed, sinceFailureMs: 500 }),
        false,
        'growth well past the bar must still wait out the backoff'
    )
    assert.equal(
        shouldCheckpointContent({ ...owed, sinceFailureMs: 2_500 }),
        true
    )
    assert.equal(
        shouldCheckpointContent({
            ...owed,
            pendingChars: 0,
            forced: true,
            sinceFailureMs: 500
        }),
        false,
        'a forced write waits too — it is owed, not urgent enough to hammer'
    )
    assert.equal(
        shouldCheckpointContent({
            ...owed,
            pendingChars: 0,
            forced: true,
            sinceFailureMs: 2_500
        }),
        true,
        'and once the backoff passes the forced write is still owed'
    )
})
