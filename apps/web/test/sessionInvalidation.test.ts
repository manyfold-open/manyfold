import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import {
    SESSION_INVALIDATION_WINDOW_MS,
    createSessionInvalidationQueue
} from '../src/lib/sessionInvalidation'

interface Harness {
    queue: ReturnType<typeof createSessionInvalidationQueue>
    refreshed: () => string[]
    setCached: (agentIds: string[]) => void
    advance: (ms: number) => void
}

const setup = (t: TestContext, cached: string[] = ['agent-1']): Harness => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const refreshed: string[] = []
    let cachedIds = new Set(cached)
    const queue = createSessionInvalidationQueue({
        refresh: (agentId) => {
            refreshed.push(agentId)
        },
        shouldRefresh: (agentId) => cachedIds.has(agentId)
    })
    t.after(() => {
        queue.dispose()
    })
    return {
        queue,
        refreshed: () => refreshed,
        setCached: (agentIds) => {
            cachedIds = new Set(agentIds)
        },
        advance: (ms) => t.mock.timers.tick(ms)
    }
}

test('refreshes after the window, not before', (t) => {
    const h = setup(t)
    h.queue.invalidate('agent-1')
    h.advance(SESSION_INVALIDATION_WINDOW_MS - 1)
    assert.deepEqual(h.refreshed(), [])
    h.advance(1)
    assert.deepEqual(h.refreshed(), ['agent-1'])
})

test('collapses a burst for one agent into a single refresh', (t) => {
    const h = setup(t)
    for (let i = 0; i < 5; i++) h.queue.invalidate('agent-1')
    h.advance(SESSION_INVALIDATION_WINDOW_MS)
    assert.deepEqual(h.refreshed(), ['agent-1'])
})

test('a cross-agent burst shares one window and refreshes each once', (t) => {
    const h = setup(t, ['agent-1', 'agent-2', 'agent-3'])
    h.queue.invalidate('agent-1')
    h.queue.invalidate('agent-2')
    h.queue.invalidate('agent-1')
    h.queue.invalidate('agent-3')
    h.advance(SESSION_INVALIDATION_WINDOW_MS)
    assert.deepEqual(h.refreshed().sort(), ['agent-1', 'agent-2', 'agent-3'])
})

test('an uncached agent is never queued', (t) => {
    const h = setup(t, ['agent-1'])
    h.queue.invalidate('agent-collapsed')
    h.advance(SESSION_INVALIDATION_WINDOW_MS)
    assert.deepEqual(h.refreshed(), [])
})

test('an agent cached only after the event arrived is not refreshed', (t) => {
    const h = setup(t, ['agent-1'])
    h.queue.invalidate('agent-expanded-later')
    h.setCached(['agent-1', 'agent-expanded-later'])
    h.advance(SESSION_INVALIDATION_WINDOW_MS)
    assert.deepEqual(h.refreshed(), [])
})

test('an agent pruned during the window is not refreshed', (t) => {
    const h = setup(t, ['agent-1', 'agent-2'])
    h.queue.invalidate('agent-1')
    h.queue.invalidate('agent-2')
    h.setCached(['agent-2'])
    h.advance(SESSION_INVALIDATION_WINDOW_MS)
    assert.deepEqual(h.refreshed(), ['agent-2'])
})

test('a later burst arms a fresh window', (t) => {
    const h = setup(t)
    h.queue.invalidate('agent-1')
    h.advance(SESSION_INVALIDATION_WINDOW_MS)
    assert.deepEqual(h.refreshed(), ['agent-1'])
    h.queue.invalidate('agent-1')
    h.advance(SESSION_INVALIDATION_WINDOW_MS)
    assert.deepEqual(h.refreshed(), ['agent-1', 'agent-1'])
})

test('dispose cancels a pending window', (t) => {
    const h = setup(t)
    h.queue.invalidate('agent-1')
    h.queue.dispose()
    h.advance(SESSION_INVALIDATION_WINDOW_MS * 4)
    assert.deepEqual(h.refreshed(), [])
})
