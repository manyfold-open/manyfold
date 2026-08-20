import assert from 'node:assert/strict'
import test from 'node:test'
import { extractClaudeCodeUsage } from '../src/modules/chat/adapters/claude-code-usage'

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
