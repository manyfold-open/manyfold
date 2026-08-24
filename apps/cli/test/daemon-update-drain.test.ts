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
        drainTimeoutMs: opts?.drainTimeoutMs
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

test('a failed deferred apply logs and unblocks new sessions', async () => {
    const h = makeHarness({
        applyUpdate: async () => {
            throw new Error('cdn unreachable')
        }
    })
    h.setActive(1)
    await h.coordinator.request({})

    h.setActive(0)
    h.coordinator.onSessionEnd()
    await flush()
    assert.ok(h.logs.some((l) => /deferred update failed/.test(l)))
    assert.equal(h.coordinator.blocksNewSessions(), false)
    assert.equal(h.restarts, 0)
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
