import test from 'node:test'
import assert from 'node:assert/strict'
import type { UserExternalAgentProviderSummary } from '@manyfold/shared'
import {
    matchProviderByEndpoint,
    normalizeEndpoint,
    unusedProviders
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

test('matchProviderByEndpoint finds the normalized match', () => {
    const hit = makeProvider({ endpointUrl: 'https://api.dify.ai/v1' })
    const miss = makeProvider({ endpointUrl: 'https://other.example.com/v1' })
    assert.equal(
        matchProviderByEndpoint([miss, hit], 'https://API.dify.ai/v1/'),
        hit
    )
    assert.equal(matchProviderByEndpoint([miss], 'https://api.dify.ai/v1'), null)
    assert.equal(matchProviderByEndpoint([hit], null), null)
    assert.equal(matchProviderByEndpoint([hit], undefined), null)
})

test('unusedProviders keeps providers no runtime endpoint uses', () => {
    const used = makeProvider({ endpointUrl: 'https://api.dify.ai/v1' })
    const idle = makeProvider({ endpointUrl: 'https://langflow.example.com' })
    assert.deepEqual(
        unusedProviders([used, idle], ['https://api.dify.ai/v1/', null, '']),
        [idle]
    )
})

test('unusedProviders treats a provider shared by several runtimes as used', () => {
    const shared = makeProvider({ endpointUrl: 'https://api.dify.ai/v1' })
    assert.deepEqual(
        unusedProviders(
            [shared],
            ['https://api.dify.ai/v1', 'https://api.dify.ai/v1/']
        ),
        []
    )
})
