import test from 'node:test'
import assert from 'node:assert/strict'
import type { UserExternalAgentProviderSummary } from '@manyfold/shared'
import {
    normalizeEndpoint,
    providerRuntimeCounts
} from '../src/lib/runtimesDashboardData'

let seq = 0
const makeProvider = (
    over: Partial<UserExternalAgentProviderSummary> = {}
): UserExternalAgentProviderSummary => {
    seq += 1
    return {
        id: `uep_${seq}`,
        provider: 'dify',
        label: `Provider ${seq}`,
        apiKeyMasked: 'app-****',
        endpointUrl: `https://api.example${seq}.com/v1`,
        metadata: {},
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestMessage: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over
    }
}

test('normalizeEndpoint ignores trailing slashes, host case and whitespace', () => {
    assert.equal(
        normalizeEndpoint(' https://API.Example.com/v1/ '),
        normalizeEndpoint('https://api.example.com/v1')
    )
    assert.equal(
        normalizeEndpoint('https://api.example.com'),
        normalizeEndpoint('https://api.example.com/')
    )
})

test('normalizeEndpoint keeps path case significant', () => {
    assert.notEqual(
        normalizeEndpoint('https://api.example.com/V1'),
        normalizeEndpoint('https://api.example.com/v1')
    )
})

test('normalizeEndpoint tolerates non-URL values', () => {
    assert.equal(normalizeEndpoint(' Not-A-Url// '), 'not-a-url')
})

test('providerRuntimeCounts matches runtimes on the normalized endpoint', () => {
    const bound = makeProvider({ endpointUrl: 'https://api.dify.ai/v1' })
    const idle = makeProvider({ endpointUrl: 'https://langflow.example.com' })
    const counts = providerRuntimeCounts(
        [bound, idle],
        ['https://API.dify.ai/v1/', 'https://api.dify.ai/v1', null, '']
    )
    assert.equal(counts.get(bound.id), 2)
    assert.equal(counts.get(idle.id), 0)
})

test('providerRuntimeCounts covers every provider, even with no runtimes', () => {
    const a = makeProvider()
    const b = makeProvider()
    const counts = providerRuntimeCounts([a, b], [])
    assert.deepEqual(
        [...counts.entries()],
        [
            [a.id, 0],
            [b.id, 0]
        ]
    )
})

test('providerRuntimeCounts ignores endpoints no provider owns', () => {
    const a = makeProvider({ endpointUrl: 'https://api.dify.ai/v1' })
    const counts = providerRuntimeCounts(
        [a],
        ['https://other.example.com/v1']
    )
    assert.equal(counts.get(a.id), 0)
})
