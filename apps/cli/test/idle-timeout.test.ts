import assert from 'node:assert/strict'
import test from 'node:test'
import { createSuspendClock, idleTimeout } from '../src/daemon/idle-timeout'

// The budget's timer is real; the clock it reads is not. Moving the fake clock
// past the jump threshold without a tick is what a paused VM looks like from
// inside: every clock moved, and nothing ran.

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const fakeClock = () => {
    const state = { now: 0 }
    const clock = createSuspendClock(() => state.now, 10, 100)
    return { state, clock }
}

// Seen on staging [2026-10-07]: a hermes turn whose sprite was paused for
// 267 s failed its 240 s idle budget 7 s after the sprite woke.
test('a pause does not spend the idle budget', async () => {
    const { state, clock } = fakeClock()
    let fired = 0
    const idle = idleTimeout(() => fired++, 50, clock)
    idle.touch()
    state.now = 1_000 // paused for ~1 s: the timer comes due on wake
    await later(70)
    assert.equal(fired, 0, 'the paused second is not silence')
    state.now = 1_045 // 45 ms of running time since the wake
    await later(60)
    assert.equal(fired, 1)
    idle.clear()
})

test('running silence still spends it', async () => {
    const { state, clock } = fakeClock()
    let fired = 0
    const idle = idleTimeout(() => fired++, 50, clock)
    idle.touch()
    state.now = 60
    await later(70)
    assert.equal(fired, 1)
})

test('activity starts the budget over', async () => {
    const { state, clock } = fakeClock()
    let fired = 0
    const idle = idleTimeout(() => fired++, 50, clock)
    idle.touch()
    state.now = 40
    idle.touch()
    state.now = 70
    await later(60)
    assert.equal(fired, 0, 'only 30 ms since the last activity')
    state.now = 95
    await later(40)
    assert.equal(fired, 1)
})

test('a cleared budget never fires', async () => {
    const { state, clock } = fakeClock()
    let fired = 0
    const idle = idleTimeout(() => fired++, 20, clock)
    idle.touch()
    idle.clear()
    state.now = 500
    await later(40)
    assert.equal(fired, 0)
})

test('the clock counts only gaps the process could not have run through', () => {
    const { state, clock } = fakeClock()
    state.now = 50 // a slow tick, under the jump threshold
    assert.equal(clock.suspendedMs(), 0)
    state.now = 1_050 // a 1 s gap: paused, less the tick it would have taken
    assert.equal(clock.suspendedMs(), 990)
    state.now = 1_060
    assert.equal(clock.suspendedMs(), 990)
})
