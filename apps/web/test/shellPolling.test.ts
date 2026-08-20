import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { createPollController } from '../src/lib/shellPolling'

const flush = (): Promise<void> =>
    new Promise((resolve) => {
        setImmediate(resolve)
    })

interface Harness {
    controller: ReturnType<typeof createPollController>
    runs: () => number
    setVisible: (value: boolean) => void
    advance: (ms: number) => void
    resolvePending: () => void
    pendingMode: (enabled: boolean) => void
}

const setup = (
    t: TestContext,
    options?: { intervalMs?: number; minSpacingMs?: number; visible?: boolean }
): Harness => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let clock = 0
    let visible = options?.visible ?? true
    let runCount = 0
    let pending = false
    let resolvers: Array<() => void> = []
    const controller = createPollController({
        task: () => {
            runCount++
            if (!pending) return undefined
            return new Promise<void>((resolve) => {
                resolvers.push(resolve)
            })
        },
        intervalMs: options?.intervalMs ?? 60_000,
        minSpacingMs: options?.minSpacingMs ?? 5_000,
        isVisible: () => visible,
        now: () => clock
    })
    t.after(() => controller.stop())
    return {
        controller,
        runs: () => runCount,
        setVisible: (value) => {
            visible = value
            controller.handleVisibilityChange()
        },
        advance: (ms) => {
            clock += ms
            t.mock.timers.tick(ms)
        },
        resolvePending: () => {
            for (const resolve of resolvers) resolve()
            resolvers = []
        },
        pendingMode: (enabled) => {
            pending = enabled
        }
    }
}

test('runs immediately on start and again per interval while visible', async (t) => {
    const h = setup(t)
    h.controller.start()
    assert.equal(h.runs(), 1)
    await flush()
    h.advance(60_000)
    assert.equal(h.runs(), 2)
    await flush()
    h.advance(60_000)
    assert.equal(h.runs(), 3)
})

test('start in a hidden tab performs no runs until visible', async (t) => {
    const h = setup(t, { visible: false })
    h.controller.start()
    assert.equal(h.runs(), 0)
    h.advance(300_000)
    assert.equal(h.runs(), 0)
    h.setVisible(true)
    assert.equal(h.runs(), 1)
    await flush()
    h.advance(60_000)
    assert.equal(h.runs(), 2)
})

test('hiding the tab stops recurring runs', async (t) => {
    const h = setup(t)
    h.controller.start()
    assert.equal(h.runs(), 1)
    await flush()
    h.setVisible(false)
    h.advance(600_000)
    assert.equal(h.runs(), 1)
})

test('returning to a recently polled tab restarts interval without an immediate run', async (t) => {
    const h = setup(t)
    h.controller.start()
    assert.equal(h.runs(), 1)
    await flush()
    h.setVisible(false)
    h.advance(2_000)
    h.setVisible(true)
    assert.equal(h.runs(), 1)
    h.advance(60_000)
    assert.equal(h.runs(), 2)
})

test('returning after min spacing elapsed runs immediately', async (t) => {
    const h = setup(t)
    h.controller.start()
    await flush()
    h.setVisible(false)
    h.advance(10_000)
    h.setVisible(true)
    assert.equal(h.runs(), 2)
})

test('kick runs immediately once spacing elapsed and coalesces bursts', async (t) => {
    const h = setup(t)
    h.controller.start()
    assert.equal(h.runs(), 1)
    await flush()
    h.advance(10_000)
    h.controller.kick()
    assert.equal(h.runs(), 2)
    await flush()
    h.controller.kick()
    h.controller.kick()
    assert.equal(h.runs(), 2)
})

test('kick while hidden performs no run', async (t) => {
    const h = setup(t)
    h.controller.start()
    await flush()
    h.setVisible(false)
    h.advance(60_000)
    h.controller.kick()
    assert.equal(h.runs(), 1)
})

test('overlapping executions are skipped while a run is in flight', async (t) => {
    const h = setup(t)
    h.pendingMode(true)
    h.controller.start()
    assert.equal(h.runs(), 1)
    h.advance(60_000)
    assert.equal(h.runs(), 1)
    h.advance(60_000)
    assert.equal(h.runs(), 1)
    h.resolvePending()
    await flush()
    h.advance(60_000)
    assert.equal(h.runs(), 2)
})

test('stop clears the interval', async (t) => {
    const h = setup(t)
    h.controller.start()
    assert.equal(h.runs(), 1)
    await flush()
    h.controller.stop()
    h.advance(600_000)
    assert.equal(h.runs(), 1)
})

test('a throwing task does not break subsequent polls', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    let clock = 0
    let runCount = 0
    const controller = createPollController({
        task: () => {
            runCount++
            throw new Error('boom')
        },
        intervalMs: 60_000,
        isVisible: () => true,
        now: () => clock
    })
    t.after(() => controller.stop())
    controller.start()
    assert.equal(runCount, 1)
    await flush()
    clock += 60_000
    t.mock.timers.tick(60_000)
    assert.equal(runCount, 2)
})
