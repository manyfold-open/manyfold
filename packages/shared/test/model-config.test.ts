import assert from 'node:assert/strict'
import test from 'node:test'
import {
    codexCanonicalModelId,
    geminiCanonicalModelId,
    geminiProviderModelByCanonical,
    pickGeminiGatewayDefaultModel,
    resolveGeminiProviderModel
} from '../src/model-config'

test('geminiCanonicalModelId strips provider prefix and tag', () => {
    assert.equal(geminiCanonicalModelId('gemini-2.5-pro'), 'gemini-2.5-pro')
    assert.equal(
        geminiCanonicalModelId('google/gemini-2.5-pro'),
        'gemini-2.5-pro'
    )
    assert.equal(
        geminiCanonicalModelId('models/gemini-2.5-pro'),
        'gemini-2.5-pro'
    )
    assert.equal(
        geminiCanonicalModelId('gemini-2.5-pro:latest'),
        'gemini-2.5-pro'
    )
    assert.equal(
        geminiCanonicalModelId('google/gemini-2.5-pro:latest'),
        'gemini-2.5-pro'
    )
    assert.equal(geminiCanonicalModelId('  GEMINI-2.5-PRO '), 'gemini-2.5-pro')
})

test('geminiCanonicalModelId preserves hyphenated model variants', () => {
    assert.equal(
        geminiCanonicalModelId('gemini-2.5-flash-lite'),
        'gemini-2.5-flash-lite'
    )
    assert.equal(
        geminiCanonicalModelId('google/gemini-3.1-pro-preview'),
        'gemini-3.1-pro-preview'
    )
})

test('gemini needs its own canonicalizer: codex collapses a tagged id to the tag', () => {
    assert.equal(codexCanonicalModelId('gemini-2.5-pro:latest'), 'latest')
    assert.equal(
        geminiCanonicalModelId('gemini-2.5-pro:latest'),
        'gemini-2.5-pro'
    )
})

test('geminiProviderModelByCanonical keeps the first tested id per canonical', () => {
    const map = geminiProviderModelByCanonical([
        'google/gemini-2.5-pro',
        'gemini-2.5-pro:latest',
        'google/gemini-2.5-flash'
    ])
    assert.equal(map.get('gemini-2.5-pro'), 'google/gemini-2.5-pro')
    assert.equal(map.get('gemini-2.5-flash'), 'google/gemini-2.5-flash')
})

test('resolveGeminiProviderModel maps a catalog key to the provider exact id', () => {
    assert.equal(
        resolveGeminiProviderModel('gemini-2.5-pro', [
            'google/gemini-2.5-pro',
            'google/gemini-2.5-flash'
        ]),
        'google/gemini-2.5-pro'
    )
})

test('resolveGeminiProviderModel passes through an unmatched or bare id', () => {
    assert.equal(
        resolveGeminiProviderModel('gemini-2.5-pro', ['gemini-2.5-pro']),
        'gemini-2.5-pro'
    )
    assert.equal(
        resolveGeminiProviderModel('gemini-2.5-pro', ['gemini-2.5-flash']),
        'gemini-2.5-pro'
    )
})

test('resolveGeminiProviderModel leaves the auto router alias untouched', () => {
    assert.equal(
        resolveGeminiProviderModel('auto', ['google/gemini-2.5-pro']),
        'auto'
    )
    assert.equal(resolveGeminiProviderModel(null, ['gemini-2.5-pro']), null)
})

// Catalog order is the operator's lever for the default. Gateways commonly
// list ids alphabetically, so honouring the provider's order instead would
// pin every new agent to the oldest model it happens to serve.
test('pickGeminiGatewayDefaultModel follows catalog order, not the provider listing', () => {
    const providerModels = [
        'gemini-2.5-flash',
        'gemini-3.1-pro-high',
        'gemini-3.6-flash-high'
    ]
    const catalog = new Set([
        'gemini-3.6-flash-high',
        'gemini-3.1-pro-high',
        'gemini-2.5-flash'
    ])

    assert.equal(
        pickGeminiGatewayDefaultModel(providerModels, catalog),
        'gemini-3.6-flash-high'
    )
})

test('pickGeminiGatewayDefaultModel skips catalog entries the provider does not serve', () => {
    assert.equal(
        pickGeminiGatewayDefaultModel(
            ['google/gemini-2.5-flash'],
            new Set(['gemini-3.6-flash-high', 'gemini-2.5-flash'])
        ),
        'google/gemini-2.5-flash'
    )
})

test('pickGeminiGatewayDefaultModel falls back to the first tested model', () => {
    assert.equal(
        pickGeminiGatewayDefaultModel(['gemini-pro-agent'], new Set(['auto'])),
        'gemini-pro-agent'
    )
    assert.equal(pickGeminiGatewayDefaultModel([], new Set(['x'])), null)
})
