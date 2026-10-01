import test from 'node:test'
import assert from 'node:assert/strict'
import {
    UpdateDrainCoordinator,
    type DaemonUpdateSpec
} from '../src/daemon/update-drain'
import type { SelfUpdateResult } from '../src/commands/update'

const flush = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
    coordinator: UpdateDrainCoordinator
    setActive: (n: number) => void
    applied: DaemonUpdateSpec[]
    restarts: number
    logs: string[]
}

const makeHarness = (opts?: {
    changed?: boolean
    drainTimeoutMs?: number
    retryDelayMs?: number
    applyUpdate?: (spec: DaemonUpdateSpec) => Promise<SelfUpdateResult>
}): Harness => {
    let active = 0
    const applied: DaemonUpdateSpec[] = []
    const logs: string[] = []
    const harness: Harness = {
        coordinator: undefined as unknown as UpdateDrainCoordinator,
        setActive: (n) => {
            active = n
        },
        applied,
        restarts: 0,
        logs
    }
    harness.coordinator = new UpdateDrainCoordinator({
        activeSessions: () => active,
        applyUpdate:
            opts?.applyUpdate ??
            (async (spec) => {
                applied.push(spec)
                return {
                    from: '1.0.0',
                    to: spec.targetVersion ?? '2.0.0',
                    commit: 'a72f4de',
                    execPath: '/tmp/mf',
                    changed: opts?.changed ?? true
                }
            }),
        restart: () => {
            harness.restarts += 1
        },
        log: (msg) => logs.push(msg),
        drainTimeoutMs: opts?.drainTimeoutMs,
        retryDelayMs: opts?.retryDelayMs
    })
    return harness
}

test('an idle daemon applies the update immediately and restarts', async () => {
    const h = makeHarness()
    const outcome = await h.coordinator.request({ targetVersion: '2.0.0' })
    assert.equal(outcome.kind, 'applied')
    assert.deepEqual(h.applied, [{ targetVersion: '2.0.0' }])
    assert.equal(h.restarts, 1)
})

test('an already-current binary does not restart and keeps admitting sessions', async () => {
    const h = makeHarness({ changed: false })
    const outcome = await h.coordinator.request({})
    assert.equal(outcome.kind, 'applied')
    assert.equal(h.restarts, 0)
    assert.equal(h.coordinator.blocksNewSessions(), false)
})

test('live sessions defer the update instead of being killed by a restart', async () => {
    const h = makeHarness()
    h.setActive(2)
    const outcome = await h.coordinator.request({ targetVersion: '2.0.0' })
    assert.deepEqual(outcome, { kind: 'deferred', activeSessions: 2 })
    assert.equal(h.applied.length, 0)
    assert.equal(h.restarts, 0)
    assert.equal(h.coordinator.blocksNewSessions(), true)
})

test('the deferred update applies once the last session ends', async () => {
    const h = makeHarness()
    h.setActive(1)
    await h.coordinator.request({ targetVersion: '2.0.0' })

    h.coordinator.onSessionEnd()
    await flush()
    assert.equal(h.applied.length, 0, 'must wait while a session is live')

    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()
    assert.deepEqual(h.applied, [{ targetVersion: '2.0.0' }])
    assert.equal(h.restarts, 1)
})

test('the drain deadline bounds the wait and force-applies', async () => {
    const h = makeHarness({ drainTimeoutMs: 20 })
    h.setActive(1)
    await h.coordinator.request({ targetVersion: '2.0.0' })

    await sleep(60)
    assert.deepEqual(h.applied, [{ targetVersion: '2.0.0' }])
    assert.equal(h.restarts, 1)
    assert.ok(h.logs.some((l) => /drain deadline/.test(l)))
})

// WHY: nobody waits on a deferred update's RPC, so a failure there dropped an
// update its caller had been told would land.
//
// The retry tests tick their timers by hand. On the wall clock, a retry had to
// stay unfired for as long as the test took to look, which a loaded machine
// does not promise. Seen on macOS with the cli, web and shared suites running
// at once [2026-10-01]: `a session ending does not cut the wait short` failed
// `2 !== 1`.
test('a deferred apply that fails is tried again, with new sessions still refused', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let attempts = 0
    const h = makeHarness({
        retryDelayMs: 20,
        applyUpdate: async (spec) => {
            attempts += 1
            if (attempts === 1) throw new Error('The operation was aborted.')
            h.applied.push(spec)
            return {
                from: '1.0.0',
                to: '2.0.0',
                commit: 'a72f4de',
                execPath: '/tmp/mf',
                changed: true
            }
        }
    })
    h.setActive(1)
    await h.coordinator.request({ targetVersion: '2.0.0' })

    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()
    assert.ok(
        h.logs.some((l) => /deferred update failed: The operation was aborted\.; trying again in/.test(l)),
        h.logs.join('\n')
    )
    assert.equal(h.coordinator.blocksNewSessions(), true)
    h.coordinator.onSessionEnd()
    await flush()
    assert.equal(attempts, 1, 'a session ending does not cut the wait short')

    t.mock.timers.tick(20)
    await flush()
    assert.deepEqual(h.applied, [{ targetVersion: '2.0.0' }])
    assert.equal(h.restarts, 1)
})

test('a deferred apply that keeps failing gives up and unblocks new sessions', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let attempts = 0
    const h = makeHarness({
        retryDelayMs: 5,
        applyUpdate: async () => {
            attempts += 1
            throw new Error('cdn unreachable')
        }
    })
    h.setActive(1)
    await h.coordinator.request({})

    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()
    // The next retry is scheduled after tick() returns, so each tick fires one.
    for (let i = 0; i < 2; i += 1) {
        t.mock.timers.tick(5)
        await flush()
    }
    assert.equal(attempts, 3)
    assert.equal(h.logs.at(-1), 'deferred update failed: cdn unreachable')
    assert.equal(h.coordinator.blocksNewSessions(), false)
    assert.equal(h.restarts, 0)
})

test('a retry that finds a session live drains it first', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let attempts = 0
    const h = makeHarness({
        retryDelayMs: 10,
        drainTimeoutMs: 60_000,
        applyUpdate: async (spec) => {
            attempts += 1
            if (attempts === 1) throw new Error('cdn unreachable')
            h.applied.push(spec)
            return {
                from: '1.0.0',
                to: '2.0.0',
                commit: 'a72f4de',
                execPath: '/tmp/mf',
                changed: true
            }
        }
    })
    h.setActive(1)
    await h.coordinator.request({ targetVersion: '2.0.0' })
    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()

    h.setActive(1)
    t.mock.timers.tick(10)
    await flush()
    assert.equal(attempts, 1, 'the live session is not killed')
    assert.equal(h.coordinator.blocksNewSessions(), true)

    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()
    assert.deepEqual(h.applied, [{ targetVersion: '2.0.0' }])
    assert.equal(h.restarts, 1)
})

test('a request while a failed deferred apply waits applies at once', async () => {
    let attempts = 0
    const h = makeHarness({
        retryDelayMs: 60_000,
        applyUpdate: async (spec) => {
            attempts += 1
            if (attempts === 1) throw new Error('cdn unreachable')
            h.applied.push(spec)
            return {
                from: '1.0.0',
                to: spec.targetVersion ?? '2.0.0',
                commit: 'a72f4de',
                execPath: '/tmp/mf',
                changed: true
            }
        }
    })
    h.setActive(1)
    await h.coordinator.request({ targetVersion: '2.0.0' })
    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()

    const outcome = await h.coordinator.request({ targetVersion: '2.1.0' })
    assert.equal(outcome.kind, 'applied')
    assert.deepEqual(h.applied, [{ targetVersion: '2.1.0' }])
    assert.equal(h.restarts, 1)
})

test('a repeated request while draining replaces the pending target', async () => {
    const h = makeHarness()
    h.setActive(1)
    await h.coordinator.request({ targetVersion: '2.0.0' })
    await h.coordinator.request({ targetVersion: '2.1.0' })

    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()
    assert.deepEqual(h.applied, [{ targetVersion: '2.1.0' }])
})

// A caller that keeps asking must not keep postponing: the deadline is the
// first request's, and the update runs when it passes.
test('a repeated request while draining keeps the first deadline', async () => {
    const h = makeHarness({ drainTimeoutMs: 60 })
    h.setActive(1)
    await h.coordinator.request({ targetVersion: '2.0.0' })
    await sleep(40)
    await h.coordinator.request({ targetVersion: '2.0.0' })
    await sleep(40)
    assert.deepEqual(h.applied, [{ targetVersion: '2.0.0' }])
    assert.equal(h.restarts, 1)
})

test('requestIfIdle applies immediately on an idle daemon', async () => {
    const h = makeHarness()
    const outcome = await h.coordinator.requestIfIdle({
        targetVersion: '2.0.0'
    })
    assert.equal(outcome.kind, 'applied')
    assert.deepEqual(h.applied, [{ targetVersion: '2.0.0' }])
    assert.equal(h.restarts, 1)
})

test('requestIfIdle on a busy daemon steps aside WITHOUT pausing new sessions', async () => {
    const h = makeHarness()
    h.setActive(2)
    const outcome = await h.coordinator.requestIfIdle({})
    assert.deepEqual(outcome, { kind: 'busy', activeSessions: 2 })
    assert.equal(h.applied.length, 0)
    assert.equal(
        h.coordinator.blocksNewSessions(),
        false,
        'a background auto-update must never degrade service by gating sessions'
    )

    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()
    assert.equal(
        h.applied.length,
        0,
        'stepping aside must not leave a pending update behind'
    )
})

test('requestIfIdle defers to an admin drain already in progress', async () => {
    const h = makeHarness()
    h.setActive(1)
    await h.coordinator.request({ targetVersion: '2.0.0' })

    h.setActive(0)
    const outcome = await h.coordinator.requestIfIdle({
        targetVersion: '9.9.9'
    })
    assert.equal(outcome.kind, 'busy')

    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()
    assert.deepEqual(
        h.applied,
        [{ targetVersion: '2.0.0' }],
        'the admin-requested target owns the restart'
    )
})

test('a request during an in-flight apply is rejected', async () => {
    let release: (() => void) | undefined
    const h = makeHarness({
        applyUpdate: async () => {
            await new Promise<void>((resolve) => {
                release = resolve
            })
            return {
                from: '1.0.0',
                to: '2.0.0',
                commit: 'a72f4de',
                execPath: '/tmp/mf',
                changed: true
            }
        }
    })
    const first = h.coordinator.request({})
    await flush()
    await assert.rejects(
        h.coordinator.request({}),
        /update already in progress/
    )
    release?.()
    await first
})
