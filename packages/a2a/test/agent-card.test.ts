import assert from 'node:assert/strict'
import test from 'node:test'
import {
    assertSupportedProtocolVersion,
    parseMajorVersion,
    resolveAgentCardUrl,
    selectInterface
} from '../src/agent-card'
import type { AgentCard } from '../src/types'

const card = (over: Partial<AgentCard>): AgentCard => ({
    protocolVersion: '0.3.0',
    name: 'demo',
    url: 'https://demo.example.com/a2a/rpc',
    preferredTransport: 'JSONRPC',
    ...over
})

test('resolveAgentCardUrl: base URL falls back to well-known discovery', () => {
    assert.equal(
        resolveAgentCardUrl('https://agents.example.com'),
        'https://agents.example.com/.well-known/agent-card.json'
    )
    assert.equal(
        resolveAgentCardUrl('https://agents.example.com/'),
        'https://agents.example.com/.well-known/agent-card.json'
    )
})

test('resolveAgentCardUrl: explicit card / rpc URLs pass through', () => {
    assert.equal(
        resolveAgentCardUrl('https://x.com/.well-known/agent-card.json'),
        'https://x.com/.well-known/agent-card.json'
    )
    assert.equal(
        resolveAgentCardUrl('https://x.com/api/a2a/agents/ag1/rpc'),
        'https://x.com/api/a2a/agents/ag1/rpc'
    )
})

test('protocol version major parsing and gating', () => {
    assert.equal(parseMajorVersion('0.3.0'), 0)
    assert.equal(parseMajorVersion('0.3'), 0)
    assert.equal(parseMajorVersion('1.0.0'), 1)
    assert.doesNotThrow(() =>
        assertSupportedProtocolVersion(card({ protocolVersion: '0.3.0' }), 0)
    )
    assert.throws(() =>
        assertSupportedProtocolVersion(card({ protocolVersion: '1.0.0' }), 0)
    )
})

test('selectInterface uses preferredTransport url then additionalInterfaces', () => {
    assert.deepEqual(selectInterface(card({ url: 'https://x/rpc' })), {
        url: 'https://x/rpc',
        transport: 'JSONRPC'
    })
    assert.deepEqual(
        selectInterface(
            card({
                url: 'https://x/grpc',
                preferredTransport: 'GRPC',
                additionalInterfaces: [
                    { url: 'https://x/jsonrpc', transport: 'JSONRPC' }
                ]
            })
        ),
        { url: 'https://x/jsonrpc', transport: 'JSONRPC' }
    )
})

test('selectInterface throws when no JSONRPC interface exists', () => {
    assert.throws(() =>
        selectInterface(card({ url: 'https://x/grpc', preferredTransport: 'GRPC' }))
    )
})
