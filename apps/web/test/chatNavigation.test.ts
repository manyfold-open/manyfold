import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const store = new Map<string, string>()

// The module reads `window.localStorage` at call time, so a minimal stub is
// enough and no jsdom is needed.
;(globalThis as { window?: unknown }).window = {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value)
        }
    }
}

const KEY = 'nca.web.lastChatLocation'

const { readLastChatLocationRecord, storeLastChatLocation } =
    await import('../src/lib/chatNavigation')

beforeEach(() => {
    store.clear()
})

test('remembers the agent behind the conversation', () => {
    storeLastChatLocation({
        path: '/agents/agt_1/chat?session=s1',
        agentId: 'agt_1',
        agentName: 'adventurous-mayfly-2095'
    })
    assert.deepEqual(readLastChatLocationRecord(), {
        path: '/agents/agt_1/chat?session=s1',
        agentId: 'agt_1',
        agentName: 'adventurous-mayfly-2095'
    })
})

test('reads a bare path written by an older build', () => {
    store.set(KEY, '/agents/agt_9/chat')
    assert.deepEqual(readLastChatLocationRecord(), {
        path: '/agents/agt_9/chat',
        agentId: null,
        agentName: null
    })
})

test('refuses to remember a location outside the agent routes', () => {
    storeLastChatLocation({
        path: '/settings/general',
        agentId: null,
        agentName: null
    })
    assert.equal(readLastChatLocationRecord(), null)
})

test('survives a corrupt stored value', () => {
    store.set(KEY, '{not json')
    assert.equal(readLastChatLocationRecord(), null)
    store.set(KEY, '{"agentId":"agt_1"}')
    assert.equal(readLastChatLocationRecord(), null)
})

test('drops a stored record whose path left the agent routes', () => {
    store.set(KEY, JSON.stringify({ path: '/workspace', agentId: 'agt_1' }))
    assert.equal(readLastChatLocationRecord(), null)
})
