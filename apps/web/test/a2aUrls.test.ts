import test from 'node:test'
import assert from 'node:assert/strict'
import { a2aEndpointUrls } from '../src/pages/agents/a2aUrls'

test('a2aEndpointUrls builds card + rpc URLs from an absolute origin', () => {
    const urls = a2aEndpointUrls('agt_x', 'https://api.example.com/api')
    assert.equal(
        urls.cardUrl,
        'https://api.example.com/api/a2a/agents/agt_x/agent-card.json'
    )
    assert.equal(urls.rpcUrl, 'https://api.example.com/api/a2a/agents/agt_x/rpc')
})
