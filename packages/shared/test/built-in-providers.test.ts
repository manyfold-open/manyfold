import assert from 'node:assert/strict'
import test from 'node:test'
import {
    brandFor,
    builtInBaseUrlForProtocol,
    builtInSupportsProtocol,
    lookupBuiltIn
} from '../src/built-in-providers'
import {
    compatibleProtocolsForProvider,
    defaultProtocolForProvider
} from '../src/inference-protocol'

test('managed brand is taken from the stored managedBrand, not the protocol', () => {
    assert.equal(
        brandFor({
            builtInId: null,
            inferenceProtocol: 'google_generate_content',
            source: 'managed',
            managedBrand: 'antigravity'
        }),
        'antigravity'
    )
    assert.equal(
        brandFor({
            builtInId: null,
            inferenceProtocol: 'google_generate_content',
            source: 'managed',
            managedBrand: 'google'
        }),
        'google'
    )
})

test('managed Antigravity and Gemini share google_generate_content but stay distinct brands', () => {
    const protocol = 'google_generate_content'
    const antigravity = brandFor({
        builtInId: null,
        inferenceProtocol: protocol,
        source: 'managed',
        managedBrand: 'antigravity'
    })
    const gemini = brandFor({
        builtInId: null,
        inferenceProtocol: protocol,
        source: 'managed',
        managedBrand: 'google'
    })
    assert.notEqual(antigravity, gemini)
})

test('managed Antigravity Claude and Anthropic share anthropic_messages but stay distinct brands', () => {
    const protocol = 'anthropic_messages'
    const antigravityClaude = brandFor({
        builtInId: null,
        inferenceProtocol: protocol,
        source: 'managed',
        managedBrand: 'antigravity_claude'
    })
    const anthropic = brandFor({
        builtInId: null,
        inferenceProtocol: protocol,
        source: 'managed',
        managedBrand: 'anthropic'
    })
    assert.notEqual(antigravityClaude, anthropic)
})

// The claude face of the antigravity group binds claude-code agents, so it has
// to resolve to anthropic_messages and nothing else. Its rank must stay behind
// Managed Anthropic, which is what makes it the fallback rather than the
// default pick.
test('antigravity_claude speaks anthropic_messages and ranks behind Managed Anthropic', () => {
    assert.equal(
        defaultProtocolForProvider('antigravity_claude'),
        'anthropic_messages'
    )
    assert.deepEqual(compatibleProtocolsForProvider('antigravity_claude'), [
        'anthropic_messages'
    ])
})

test('legacy managed rows without managedBrand fall back to protocol', () => {
    assert.equal(
        brandFor({
            builtInId: null,
            inferenceProtocol: 'google_generate_content',
            source: 'managed'
        }),
        'google'
    )
    assert.equal(
        brandFor({
            builtInId: null,
            inferenceProtocol: 'anthropic_messages',
            source: 'managed'
        }),
        'anthropic'
    )
})

test('built-in id wins over managed protocol/brand derivation', () => {
    assert.equal(
        brandFor({
            builtInId: 'google-gemini',
            inferenceProtocol: 'google_generate_content',
            source: 'byo'
        }),
        'google'
    )
})

test('byo rows without a built-in id have no brand', () => {
    assert.equal(
        brandFor({
            builtInId: null,
            inferenceProtocol: 'openai_responses',
            source: 'byo'
        }),
        null
    )
})

test('NetMind built-in exposes the OpenAI Responses protocol for Codex', () => {
    const entry = lookupBuiltIn('netmind')
    assert.ok(entry)
    assert.equal(
        builtInSupportsProtocol(entry, 'openai_responses'),
        'openai_responses'
    )
    assert.equal(
        builtInBaseUrlForProtocol(entry, 'openai_responses'),
        'https://api.netmind.ai/inference-api/openai/v1'
    )
})
