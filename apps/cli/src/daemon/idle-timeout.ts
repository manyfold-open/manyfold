import { performance } from 'node:perf_hooks'

// A machine that is paused — a sprite going cold under a turn — wakes with its
// clocks moved past every timer armed before the pause, so an inactivity
// budget fires the moment it wakes, for a silence the paused child could not
// have broken. The clock below notices those jumps; an idle budget subtracts
// them and counts only the time this process could run.
// Seen on staging [2026-10-07]: a hermes turn whose sprite was paused for
// 267 s failed its 240 s idle budget 7 s after the sprite woke.

const TICK_MS = 1_000
// A tick this late means the process did not run at all, not that it was busy.
const JUMP_MS = 10_000

export interface SuspendClock {
    now: () => number
    // Total time the process was paused, as of now.
    suspendedMs: () => number
}

export const createSuspendClock = (
    now: () => number = () => performance.now(),
    tickMs: number = TICK_MS,
    jumpMs: number = JUMP_MS
): SuspendClock & { sample: () => void } => {
    let lastTick = now()
    let suspended = 0
    // Synchronous, so a budget that fires first thing on wake sees the jump
    // before the ticker has run again.
    const sample = (): void => {
        const t = now()
        const gap = t - lastTick
        if (gap > jumpMs) suspended += gap - tickMs
        lastTick = t
    }
    return {
        now,
        sample,
        suspendedMs: () => {
            sample()
            return suspended
        }
    }
}

let processClock: (SuspendClock & { sample: () => void }) | null = null

const defaultClock = (): SuspendClock => {
    if (!processClock) {
        processClock = createSuspendClock()
        const clock = processClock
        setInterval(() => clock.sample(), TICK_MS).unref()
    }
    return processClock
}

export interface IdleTimeout {
    // Activity: the budget starts over.
    touch: () => void
    clear: () => void
}

// An inactivity budget of `idleMs` of RUNNING time: when the timer comes due
// it checks how much of the wait the process was paused for, and waits out
// the rest instead of firing.
export const idleTimeout = (
    onIdle: () => void,
    idleMs: number,
    clock: SuspendClock = defaultClock()
): IdleTimeout => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let since = 0
    let pausedAtStart = 0
    const wait = (ms: number): void => {
        timer = setTimeout(() => {
            timer = null
            const ran = clock.now() - since - (clock.suspendedMs() - pausedAtStart)
            if (ran >= idleMs) onIdle()
            else wait(idleMs - ran)
        }, ms)
        timer.unref?.()
    }
    const clear = (): void => {
        if (timer) clearTimeout(timer)
        timer = null
    }
    return {
        touch: () => {
            clear()
            since = clock.now()
            pausedAtStart = clock.suspendedMs()
            wait(idleMs)
        },
        clear
    }
}
