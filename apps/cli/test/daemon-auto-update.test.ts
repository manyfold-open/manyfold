import test from 'node:test'
import assert from 'node:assert/strict'
import {
    AUTO_UPDATE_BUSY_RETRY_MS,
    AUTO_UPDATE_CHECK_INTERVAL_MS,
    DaemonAutoUpdater,
    resolveAutoUpdateEnabled,
    type AutoUpdateLoopDeps
} from '../src/daemon/auto-update'
import type { IdleUpdateOutcome } from '../src/daemon/update-drain'

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

// mock.timers leaves setImmediate real, so this yields a full macrotask
// boundary: every microtask the tick chain enqueued — the fetch, the apply and
// the reschedule that follows them — has drained before we look at the counter.
const settle = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

const decision = (
    overrides: Partial<Parameters<typeof resolveAutoUpdateEnabled>[0]>
): ReturnType<typeof resolveAutoUpdateEnabled> =>
    resolveAutoUpdateEnabled({
        envValue: undefined,
        apiUrl: 'https://api.manyfold.ai/api',
        channel: 'stable',
        standalone: true,
        startupMethod: 'launchd-user',
        ...overrides
    })

test('auto-update defaults on for the official channel API, off for custom URLs', () => {
    assert.equal(decision({}).enabled, true)
    assert.equal(
        decision({ apiUrl: 'https://api.manyfold.ai/api/' }).enabled,
        true
    )
    assert.equal(
        decision({ apiUrl: 'https://self-hosted.example.test/api' }).enabled,
        false
    )
})

test('a self-update without a supervisor would kill the daemon — hard-gated off', () => {
    const manual = decision({ startupMethod: 'manual', envValue: '1' })
    assert.equal(manual.enabled, false)
    const dev = decision({ standalone: false, envValue: '1' })
    assert.equal(dev.enabled, false)
})

test('MF_DAEMON_AUTO_UPDATE overrides the default in both directions, garbage fails closed', () => {
    assert.equal(decision({ envValue: '0' }).enabled, false)
    assert.equal(decision({ envValue: 'off' }).enabled, false)
    assert.equal(
        decision({
            envValue: '1',
            apiUrl: 'https://self-hosted.example.test/api'
        }).enabled,
        true
    )
    assert.equal(decision({ envValue: 'maybe' }).enabled, false)
})

interface Harness {
    updater: DaemonAutoUpdater
    applied: string[]
    logs: string[]
}

const makeUpdater = (opts: {
    latest: string | (() => Promise<string>)
    channel?: 'stable' | 'dev'
    current?: string
    outcome?: (target: string) => Promise<IdleUpdateOutcome>
    checkIntervalMs?: number
    busyRetryMs?: number
    initialDelayMs?: number
}): Harness => {
    const applied: string[] = []
    const logs: string[] = []
    const deps: AutoUpdateLoopDeps = {
        channel: opts.channel ?? 'stable',
        currentVersion: opts.current ?? '1.0.0',
        fetchLatestVersion:
            typeof opts.latest === 'function'
                ? opts.latest
                : async () => opts.latest as string,
        applyIfIdle: async (target) => {
            applied.push(target)
            if (opts.outcome) return opts.outcome(target)
            return {
                kind: 'applied',
                result: {
                    from: opts.current ?? '1.0.0',
                    to: target,
                    execPath: '/tmp/mf',
                    changed: true
                }
            }
        },
        log: (msg) => logs.push(msg),
        checkIntervalMs: opts.checkIntervalMs,
        busyRetryMs: opts.busyRetryMs,
        initialDelayMs: opts.initialDelayMs
    }
    return { updater: new DaemonAutoUpdater(deps), applied, logs }
}

test('an idle daemon installs the newer build and restarts', async () => {
    const h = makeUpdater({ latest: '1.1.0' })
    assert.equal(await h.updater.tick(), 'restarting')
    assert.deepEqual(h.applied, ['1.1.0'])
})

test('an up-to-date daemon does nothing', async () => {
    const h = makeUpdater({ latest: '1.0.0' })
    assert.equal(await h.updater.tick(), 'up-to-date')
    assert.equal(h.applied.length, 0)
})

test('stable never downgrades a binary that is ahead of the channel', async () => {
    const h = makeUpdater({ latest: '0.9.0', current: '1.0.0' })
    assert.equal(await h.updater.tick(), 'up-to-date')
    assert.equal(h.applied.length, 0)
})

test('dev follows the channel head exactly, including rollbacks', async () => {
    const h = makeUpdater({
        channel: 'dev',
        current: '1.0.0-dev.2.def',
        latest: '1.0.0-dev.1.abc'
    })
    assert.equal(await h.updater.tick(), 'restarting')
    assert.deepEqual(h.applied, ['1.0.0-dev.1.abc'])
})

test('a busy daemon is left alone and retried sooner than the normal interval', async () => {
    const h = makeUpdater({
        latest: '1.1.0',
        outcome: async () => ({ kind: 'busy', activeSessions: 2 })
    })
    const result = await h.updater.tick()
    assert.equal(result, 'busy')
    assert.ok(h.logs.some((l) => /2 active session/.test(l)))
    assert.equal(h.updater.nextDelayMs(result), AUTO_UPDATE_BUSY_RETRY_MS)
    assert.equal(
        h.updater.nextDelayMs('up-to-date'),
        AUTO_UPDATE_CHECK_INTERVAL_MS
    )
    assert.ok(AUTO_UPDATE_BUSY_RETRY_MS < AUTO_UPDATE_CHECK_INTERVAL_MS)
})

test('a flaky CDN or failed download logs and keeps the loop alive', async () => {
    const failing = makeUpdater({
        latest: async () => {
            throw new Error('cdn down')
        }
    })
    assert.equal(await failing.updater.tick(), 'check-failed')
    assert.ok(failing.logs.some((l) => /cdn down/.test(l)))

    const applyFails = makeUpdater({
        latest: '1.1.0',
        outcome: async () => {
            throw new Error('sha256 mismatch')
        }
    })
    assert.equal(await applyFails.updater.tick(), 'apply-failed')
    assert.ok(applyFails.logs.some((l) => /sha256 mismatch/.test(l)))
})

// The loop is driven tick by tick rather than left to run for a wall-clock
// window. The old shape slept 120ms real and asserted exactly 3 polls had
// happened at 5ms intervals, so it was really asserting "this machine scheduled
// me 3 times in 120ms" — under `pnpm test` at the repo root (16 suites in
// parallel) it got 1 and failed `1 !== 3`. Reproduced deterministically with a
// single 200ms synchronous block in place of the contention.
//
// Ticking makes the poll count a function of this test alone, and it also lets
// the second half assert something the wall-clock version could not: advance
// far past any interval and prove `restarting` never rescheduled, rather than
// inferring it from "only 3 happened in the time I waited".
test('the loop keeps polling after failures and stops rescheduling once restarting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let calls = 0
    const h = makeUpdater({
        latest: async () => {
            calls += 1
            if (calls < 3) throw new Error('flaky')
            return '1.1.0'
        },
        initialDelayMs: 5,
        checkIntervalMs: 5,
        busyRetryMs: 5
    })
    h.updater.start()
    // 20ms clears the +10% jitter ceiling on a 5ms delay. One tick can only
    // ever fire one poll: the reschedule runs in a microtask after tick()
    // returns, so it cannot be swallowed by the same advance.
    for (let i = 0; i < 3; i += 1) {
        t.mock.timers.tick(20)
        await settle()
    }
    assert.equal(calls, 3, 'poll must survive failures, then stop on restart')
    assert.deepEqual(h.applied, ['1.1.0'])

    t.mock.timers.tick(60_000)
    await settle()
    assert.equal(calls, 3, 'restarting must not schedule another poll')
    h.updater.stop()
})

test('stop() cancels a scheduled tick', async () => {
    let calls = 0
    const h = makeUpdater({
        latest: async () => {
            calls += 1
            return '1.0.0'
        },
        initialDelayMs: 30
    })
    h.updater.start()
    h.updater.stop()
    await sleep(80)
    assert.equal(calls, 0)
})
