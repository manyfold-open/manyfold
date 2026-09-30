import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import {
    extractClaudeCodeUsage,
    newClaudeRunFacts,
    observeClaudeRun,
    type ClaudeTurnUsage,
    type StreamJsonLine
} from '../src/modules/chat/adapters/claude-code-usage'
import {
    UsagePricingEngine,
    type UsagePricingService
} from '../src/modules/usage/usage-pricing.service'
import { LITELLM_PRICING_SAMPLE } from './litellm-pricing-sample'

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
}) as unknown as UsagePricingService

before(() => (pricing as unknown as UsagePricingEngine).ensureLoaded())

test('extractClaudeCodeUsage reads result usage and camelCase modelUsage model', () => {
    const usage = extractClaudeCodeUsage(
        {
            type: 'result',
            total_cost_usd: 0.02245035,
            usage: {
                input_tokens: 3,
                cache_creation_input_tokens: 4337,
                cache_read_input_tokens: 20342,
                output_tokens: 5
            },
            modelUsage: {
                'claude-sonnet-4-6': {
                    inputTokens: 3,
                    outputTokens: 5,
                    cacheReadInputTokens: 20342,
                    cacheCreationInputTokens: 4337
                }
            }
        },
        null,
        Date.now(),
        null
    )

    assert.ok(usage)
    assert.equal(usage.model, 'claude-sonnet-4-6')
    assert.equal(usage.inputTokens, 3)
    assert.equal(usage.outputTokens, 5)
    assert.equal(usage.cacheReadTokens, 20342)
    assert.equal(usage.cacheCreationTokens, 4337)
    assert.equal(usage.costUsd, 0.02245035)
    assert.equal(usage.costSource, 'upstream')
})

test('extractClaudeCodeUsage falls back to camelCase modelUsage tokens', () => {
    const usage = extractClaudeCodeUsage(
        {
            type: 'result',
            modelUsage: {
                'claude-sonnet-4-6': {
                    inputTokens: 7,
                    outputTokens: 11,
                    cacheReadInputTokens: 13,
                    cacheCreationInputTokens: 17
                }
            }
        },
        'claude-fallback',
        Date.now(),
        null
    )

    assert.ok(usage)
    assert.equal(usage.model, 'claude-sonnet-4-6')
    assert.equal(usage.inputTokens, 7)
    assert.equal(usage.outputTokens, 11)
    assert.equal(usage.cacheReadTokens, 13)
    assert.equal(usage.cacheCreationTokens, 17)
    assert.equal(usage.costUsd, null)
    assert.equal(usage.costSource, 'unknown')
})

test('extractClaudeCodeUsage returns null when no usage payload is present', () => {
    assert.equal(
        extractClaudeCodeUsage(
            { type: 'result', total_cost_usd: 0.01 },
            'claude-fallback',
            Date.now(),
            null
        ),
        null
    )
})

test('extractClaudeCodeUsage uses fallback model when modelUsage is missing', () => {
    const usage = extractClaudeCodeUsage(
        {
            type: 'result',
            usage: {
                input_tokens: 3,
                output_tokens: 5
            }
        },
        'opus',
        Date.now(),
        null
    )

    assert.ok(usage)
    assert.equal(usage.model, 'opus')
})

// A run's lines as Claude Code prints them, the result last.
const turnOf = (
    lines: StreamJsonLine[],
    over: Partial<Omit<ClaudeTurnUsage, 'facts'>> = {}
) => {
    const facts = newClaudeRunFacts()
    for (const line of lines.slice(0, -1)) observeClaudeRun(facts, line)
    return extractClaudeCodeUsage(lines[lines.length - 1], 'haiku', 0, null, {
        facts,
        resumed: true,
        requestedModel: 'haiku',
        pricing,
        ...over
    })
}

const init = (model: string, version = '2.1.285'): StreamJsonLine =>
    ({
        type: 'system',
        subtype: 'init',
        model,
        claude_code_version: version
    }) as StreamJsonLine

// Seen on a local stack [2026-09-29]: the first turn of a session ran on
// Sonnet, then the agent was switched to Haiku and the session resumed.
const switchedResult: StreamJsonLine = {
    type: 'result',
    total_cost_usd: 0.12682025,
    usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 29593,
        cache_read_input_tokens: 0,
        output_tokens: 122
    },
    modelUsage: {
        'claude-sonnet-5': {
            inputTokens: 2,
            outputTokens: 13,
            cacheCreationInputTokens: 35630
        },
        'claude-haiku-4-5-20251001': {
            inputTokens: 10,
            outputTokens: 122,
            cacheCreationInputTokens: 29593
        }
    }
}

test('a resumed run is recorded on the model it ran on, priced from its own tokens', () => {
    const usage = turnOf([
        init('claude-haiku-4-5-20251001'),
        {
            type: 'assistant',
            message: { id: 'msg_1', model: 'claude-haiku-4-5-20251001' }
        },
        switchedResult
    ])
    assert.equal(usage?.model, 'claude-haiku-4-5-20251001')
    // Not the session's 0.12682: this run's 10 in, 29 593 cache written and
    // 122 out at Haiku 4.5's prices.
    assert.equal(usage?.costUsd, 0.037611)
    assert.equal(usage?.costSource, 'table')
    assert.equal(usage?.inputTokens, 10)
    assert.equal(usage?.cacheCreationTokens, 29593)
})

test("a session's running total never becomes one run's cost", () => {
    // A Haiku-only session on its fifth turn: the ledger has grown to 0.0816
    // while this run read 62 876 cached tokens and wrote 878.
    const later: StreamJsonLine = {
        type: 'result',
        total_cost_usd: 0.081582,
        usage: {
            input_tokens: 18,
            cache_creation_input_tokens: 878,
            cache_read_input_tokens: 62876,
            output_tokens: 543
        },
        modelUsage: {
            'claude-haiku-4-5-20251001': { inputTokens: 88, outputTokens: 1900 }
        }
    }
    const usage = turnOf([init('claude-haiku-4-5-20251001'), later])
    // The ledger's own step for that turn: 0.081582 − 0.071464.
    assert.equal(usage?.costUsd, 0.010118)
    const unpriced = turnOf([init('claude-mystery-9'), later])
    assert.equal(unpriced?.model, 'claude-mystery-9')
    assert.equal(unpriced?.costUsd, null)
    assert.equal(unpriced?.costSource, 'unknown')
    const nothingToPriceWith = turnOf(
        [init('claude-haiku-4-5-20251001'), later],
        { pricing: null }
    )
    assert.equal(nothingToPriceWith?.costUsd, null)
})

test('input tokens are priced apart from the cache tokens Anthropic counts separately', () => {
    const usage = turnOf([
        init('claude-haiku-4-5-20251001'),
        {
            type: 'result',
            total_cost_usd: 9,
            usage: {
                input_tokens: 1000,
                cache_read_input_tokens: 5000,
                cache_creation_input_tokens: 0,
                output_tokens: 0
            }
        }
    ])
    // 1000 × $1/M + 5000 × $0.1/M, not (1000 − 5000 → 0) × $1/M + …
    assert.equal(usage?.costUsd, 0.0015)
})

test("the run's model comes from init, else its first own assistant line, else the alias's mapping", () => {
    const result: StreamJsonLine = {
        type: 'result',
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { 'claude-sonnet-5': {} }
    }
    const fromAssistant = turnOf([
        {
            type: 'assistant',
            parent_tool_use_id: 'toolu_1',
            message: { id: 'sub', model: 'claude-fable-5' }
        },
        {
            type: 'assistant',
            message: { id: 'main', model: 'claude-haiku-4-5-20251001' }
        },
        result
    ])
    assert.equal(fromAssistant?.model, 'claude-haiku-4-5-20251001')
    const fromMapping = turnOf([result], {
        requestedModel: 'opus',
        modelMap: { opus: 'claude-opus-5-5' }
    })
    assert.equal(fromMapping?.model, 'claude-opus-5-5')
})

test('a fresh run, or one on a CLI that does not restore the ledger, keeps the reported cost', () => {
    const fresh = turnOf([init('claude-haiku-4-5-20251001'), switchedResult], {
        resumed: false
    })
    assert.equal(fresh?.costUsd, 0.12682025)
    assert.equal(fresh?.costSource, 'upstream')
    const older = turnOf([
        init('claude-haiku-4-5-20251001', '2.1.276'),
        switchedResult
    ])
    assert.equal(older?.costSource, 'upstream')
    // A version it cannot read, like a re-attach that does not know whether
    // the run resumed, is priced from the run's tokens.
    const unknown = turnOf(
        [init('claude-haiku-4-5-20251001', 'nightly'), switchedResult],
        { resumed: null }
    )
    assert.equal(unknown?.costSource, 'table')
})
