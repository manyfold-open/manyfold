import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

// Where a turn's slot came from. Kept alongside the count because a deploy
// burst and an organic traffic spike look identical in a bare number, and
// they call for opposite responses: recovery draining is the instance doing
// its job, dispatch climbing is the instance taking on more than it was asked
// to.
export type TurnOrigin = 'dispatch' | 'resume' | 'adoption'

// Same cadence as the turn-adoption sweep, so a saturated instance is sampled
// at least as often as it tries to take on more recovery work. Idle ticks
// still sample (see below) but emit nothing, so this costs one event per 15s
// only while turns are actually in flight.
export const TURN_CONCURRENCY_GAUGE_MS = 15_000

// Node's default. Measured on this machine [2026-08-10]: the monitor adds 100
// libuv wakeups/s, and its effect on loop-iteration throughput sat below the
// noise floor of a warmed benchmark — run-to-run spread swamped the on/off
// delta across five alternating rounds. Reading it costs 38us per gauge tick
// (percentile + max + reset, mean of 1000 calls), i.e. once per 15s. A
// coarser resolution would halve the wakeups and buy nothing measurable.
const EVENT_LOOP_DELAY_RESOLUTION_MS = 10

export interface ProcessLoadSample {
    eventLoopUtilization: number
    eventLoopDelayP99Ms: number
    eventLoopDelayMaxMs: number
    rssMb: number
    heapUsedMb: number
}

export interface ProcessLoadSampler {
    sample: () => ProcessLoadSample
    stop: () => void
}

const nsToMs = (ns: number): number =>
    Number.isFinite(ns) && ns > 0 ? Math.round(ns / 1_000) / 1_000 : 0

// A concurrency count on its own cannot answer the only question worth asking
// of it — "did the instance carry that level safely?" — so every sample
// carries what degradation actually looks like next to the number.
//
// Event-loop DELAY is the signal that can see it. Utilization is a duty
// cycle: a one-second synchronous stall inside a 15s window is ~7%
// utilization, which reads as healthy while every request in that second
// missed its deadline. An operator setting a limit from utilization alone
// would be picking the concurrency at which the series still looked fine.
// Delay answers the question utilization dodges — how long did work wait for
// the loop — where max catches a single stall and p99 catches chronic
// degradation.
//
// Utilization stays because it is the one that distinguishes a loop that is
// BUSY from one that is blocked, and the pair separates "carrying real load"
// from "wedged". Memory is the third axis: the only OOM this fleet has on
// record (staging, 1GB, 2026-08-03, exit_code=137) had no per-turn memory
// number to blame or exonerate.
//
// Both loop signals are windowed, so they must be read on EVERY tick, idle
// ones included: ELU is cumulative and only means anything as a delta, the
// histogram accumulates until reset, and skipping a tick folds the skipped
// stretch into the next reported window. Skipping idle ticks understates the
// first sample after an idle period — precisely when a burst arrives.
export const createProcessLoadSampler = (): ProcessLoadSampler => {
    let previous = performance.eventLoopUtilization()
    const delay = monitorEventLoopDelay({
        resolution: EVENT_LOOP_DELAY_RESOLUTION_MS
    })
    delay.enable()
    return {
        sample: () => {
            const current = performance.eventLoopUtilization()
            const elu = performance.eventLoopUtilization(current, previous)
            previous = current
            const p99 = nsToMs(delay.percentile(99))
            const max = nsToMs(delay.max)
            delay.reset()
            const memory = process.memoryUsage()
            return {
                eventLoopUtilization: Math.round(elu.utilization * 1000) / 1000,
                eventLoopDelayP99Ms: p99,
                eventLoopDelayMaxMs: max,
                rssMb: Math.round(memory.rss / 1024 / 1024),
                heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024)
            }
        },
        stop: () => delay.disable()
    }
}
