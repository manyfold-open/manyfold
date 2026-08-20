import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { extractCodexUsage } from '../src/modules/chat/adapters/codex-usage'
import {
    UsagePricingEngine,
    type UsagePricingService
} from '../src/modules/usage/usage-pricing.service'
import { LITELLM_PRICING_SAMPLE } from './litellm-pricing-sample'

// The engine loads its tables from model_price_snapshots, so a unit test hands one
// over the way the repository would rather than reaching the network.
const pricing = new UsagePricingEngine({
    fetchPricing: async () => ({ raw: null, etag: null }),
    fetchModelsDev: async () => ({ raw: null, etag: null }),
    fetchNetmind: async () => ({ raw: null, etag: null }),
    loadSnapshot: async (source) =>
        source === 'litellm'
            ? {
                  prices: LITELLM_PRICING_SAMPLE,
                  etag: null,
                  fetchedAt: new Date()
              }
            : null,
    ttlMs: Number.POSITIVE_INFINITY
})
const pricingService = pricing as unknown as UsagePricingService

before(() => pricing.ensureLoaded())

test('extractCodexUsage marks configured model fallback', () => {
    const usage = extractCodexUsage(
        {
            type: 'result',
            usage: {
                input_tokens: 1000,
                cached_input_tokens: 100,
                output_tokens: 50
            }
        },
        'gpt-5',
        Date.now(),
        null,
        pricingService
    )

    assert.ok(usage)
    assert.equal(usage.model, 'gpt-5')
    assert.equal(usage.isFallbackModel, true)
    assert.equal(usage.costSource, 'table')
})

test('extractCodexUsage trusts emitted model metadata', () => {
    const usage = extractCodexUsage(
        {
            type: 'result',
            model: 'gpt-4o-mini',
            usage: {
                input_tokens: 1000,
                cached_input_tokens: 100,
                output_tokens: 50
            }
        },
        'gpt-5',
        Date.now(),
        null,
        pricingService
    )

    assert.ok(usage)
    assert.equal(usage.model, 'gpt-4o-mini')
    assert.equal(usage.isFallbackModel, false)
    assert.equal(usage.costSource, 'table')
})

test('extractCodexUsage reads turn response model metadata', () => {
    const usage = extractCodexUsage(
        {
            type: 'turn.completed',
            turn: {
                response: {
                    model: 'gpt-5.4-codex'
                },
                usage: {
                    input_tokens: 1200,
                    cached_input_tokens: 200,
                    output_tokens: 75
                }
            }
        },
        'gpt-5',
        Date.now(),
        null,
        pricingService
    )

    assert.ok(usage)
    assert.equal(usage.model, 'gpt-5.4-codex')
    assert.equal(usage.isFallbackModel, false)
})

test('extractCodexUsage does not mark selected fallback model as assumed', () => {
    const usage = extractCodexUsage(
        {
            type: 'turn.completed',
            usage: {
                input_tokens: 1200,
                cached_input_tokens: 200,
                output_tokens: 75
            }
        },
        'gpt-5.5',
        Date.now(),
        null,
        pricingService,
        { fallbackModelIsAssumed: false }
    )

    assert.ok(usage)
    assert.equal(usage.model, 'gpt-5.5')
    assert.equal(usage.isFallbackModel, false)
})
