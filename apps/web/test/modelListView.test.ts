import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProtocolModelMap } from '@manyfold/shared'
import {
    buildModelGroups,
    countModelPairs,
    enabledPairCount
} from '../src/lib/modelListView'

const map: ProtocolModelMap = {
    anthropic_messages: ['claude-opus-4-6', 'claude-sonnet-4-6'],
    openai_responses: ['claude-sonnet-4-6', 'gpt-5.2']
}

test('groups by protocol and keeps a shared model id in both groups', () => {
    const groups = buildModelGroups(map)
    assert.deepEqual(
        groups.map((group) => group.protocol),
        ['anthropic_messages', 'openai_responses']
    )
    // The row identity is (protocol, model): the same id appears under each
    // protocol that serves it, which is what the per-row protocol tag used to
    // have to say.
    assert.ok(groups[0].models.includes('claude-sonnet-4-6'))
    assert.ok(groups[1].models.includes('claude-sonnet-4-6'))
})

test('filters on the model id, case-insensitively', () => {
    const groups = buildModelGroups(map, 'SONNET')
    assert.equal(groups.length, 2)
    assert.deepEqual(
        groups.flatMap((group) => group.models),
        ['claude-sonnet-4-6', 'claude-sonnet-4-6']
    )
})

test('drops a protocol whose models all filter out', () => {
    const groups = buildModelGroups(map, 'gpt')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].protocol, 'openai_responses')
})

test('treats a blank query as no filter, and survives a missing map', () => {
    assert.equal(countModelPairs(buildModelGroups(map, '   ')), 4)
    assert.deepEqual(buildModelGroups(null, 'x'), [])
    assert.deepEqual(buildModelGroups(undefined), [])
})

test('counts pairs rather than distinct ids, so tabs sum to the total', () => {
    // Three distinct ids, four pairs: the "All" count has to be the sum of the
    // per-protocol tabs, or the tab labels contradict each other.
    assert.equal(countModelPairs(buildModelGroups(map)), 4)
})

test('enabled count reads a Set per protocol', () => {
    assert.equal(
        enabledPairCount(buildModelGroups(map), {
            anthropic_messages: new Set(['claude-opus-4-6']),
            openai_responses: new Set(['gpt-5.2', 'claude-sonnet-4-6'])
        }),
        3
    )
})

test("enabled count takes every model of a protocol pinned to 'all'", () => {
    assert.equal(
        enabledPairCount(buildModelGroups(map), {
            anthropic_messages: 'all'
        }),
        2
    )
})

test('enabled count ignores a protocol with no entry', () => {
    assert.equal(enabledPairCount(buildModelGroups(map), {}), 0)
})
