import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { extractGeminiUsage } from '../src/modules/chat/adapters/gemini-usage'
import { UsagePricingEngine } from '../src/modules/usage/usage-pricing.service'
import type { UsagePricingService } from '../src/modules/usage/usage-pricing.service'
import { LITELLM_PRICING_SAMPLE } from './litellm-pricing-sample'

// Seeded from a stored snapshot with both origins offline: metering has to keep
// working when the network does not, which is why the tables live in Postgres.
const pricing = new UsagePricingEngine({
    fetchPricing: async () => {
        throw new Error('offline')
    },
    fetchModelsDev: async () => {
        throw new Error('offline')
    },
    fetchNetmind: async () => {
        throw new Error('offline')
    },
    loadSnapshot: async (source) =>
        source === 'litellm'
            ? {
                  prices: LITELLM_PRICING_SAMPLE,
                  etag: null,
                  fetchedAt: new Date()
              }
            : null,
    ttlMs: Number.MAX_SAFE_INTEGER
}) as UsagePricingService

before(() => pricing.ensureLoaded())

const resultEvent = {
    type: 'result',
    timestamp: '2026-07-11T10:00:00.000Z',
    status: 'success',
    stats: {
        total_tokens: 1500,
        input_tokens: 1000,
        output_tokens: 300,
        cached: 200,
        input: 900,
        duration_ms: 1234,
        tool_calls: 2,
        models: {
            'gemini-2.5-pro': {
                total_tokens: 1200,
                input_tokens: 800,
                output_tokens: 250,
                cached: 200,
                input: 700
            },
            'gemini-2.5-flash-lite': {
                total_tokens: 300,
                input_tokens: 200,
                output_tokens: 50,
                cached: 0,
                input: 200
            }
        }
    }
}

test('extractGeminiUsage bills each model in the result stats breakdown', () => {
    const usages = extractGeminiUsage(
        resultEvent as never,
        'auto',
        Date.now() - 5000,
        Date.now() - 4000,
        pricing
    )

    assert.equal(usages.length, 2)
    const pro = usages.find((u) => u.model === 'gemini-2.5-pro')
    assert.ok(pro)
    assert.equal(pro.inputTokens, 800)
    assert.equal(pro.outputTokens, 250)
    assert.equal(pro.cacheReadTokens, 200)
    assert.equal(pro.isFallbackModel, false)
    assert.equal(pro.costSource, 'table')
    assert.equal(pro.costUsd, 0.003275)

    const lite = usages.find((u) => u.model === 'gemini-2.5-flash-lite')
    assert.ok(lite)
    assert.equal(lite.costUsd, 0.00004)
    assert.ok((pro.firstTokenMs ?? 0) >= 1000)
})

test('extractGeminiUsage falls back to aggregate stats and the configured model', () => {
    const usages = extractGeminiUsage(
        {
            type: 'result',
            status: 'error',
            stats: {
                total_tokens: 120,
                input_tokens: 100,
                output_tokens: 20,
                cached: 0,
                input: 100,
                duration_ms: 10,
                tool_calls: 0
            }
        } as never,
        'gemini-2.5-flash',
        Date.now(),
        null,
        pricing
    )

    assert.equal(usages.length, 1)
    assert.equal(usages[0]?.model, 'gemini-2.5-flash')
    assert.equal(usages[0]?.isFallbackModel, true)
    assert.equal(usages[0]?.inputTokens, 100)
    assert.equal(usages[0]?.firstTokenMs, null)
})

test('extractGeminiUsage returns nothing without stats or with empty counters', () => {
    assert.deepEqual(
        extractGeminiUsage(
            { type: 'result', status: 'success' } as never,
            null,
            Date.now(),
            null,
            pricing
        ),
        []
    )
    assert.deepEqual(
        extractGeminiUsage(
            {
                type: 'result',
                status: 'success',
                stats: {
                    total_tokens: 0,
                    input_tokens: 0,
                    output_tokens: 0,
                    cached: 0,
                    input: 0,
                    duration_ms: 5,
                    tool_calls: 0,
                    models: {}
                }
            } as never,
            null,
            Date.now(),
            null,
            pricing
        ),
        []
    )
})
