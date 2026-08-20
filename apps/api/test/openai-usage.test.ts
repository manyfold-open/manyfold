import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeProviderUsage } from '../src/modules/chat/adapters/openai-usage'

test('normalizeProviderUsage reads OpenAI usage fields', () => {
    assert.deepEqual(
        normalizeProviderUsage({
            prompt_tokens: 1000,
            completion_tokens: 250,
            prompt_tokens_details: { cached_tokens: 300 }
        }),
        {
            inputTokens: 1000,
            outputTokens: 250,
            cacheReadTokens: 300,
            cacheCreationTokens: 0,
            inputTokensIncludeCache: true
        }
    )
})

test('normalizeProviderUsage reads Anthropic-style cache fields', () => {
    assert.deepEqual(
        normalizeProviderUsage({
            input_tokens: 1200,
            output_tokens: 350,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 500
        }),
        {
            inputTokens: 1200,
            outputTokens: 350,
            cacheReadTokens: 400,
            cacheCreationTokens: 500,
            inputTokensIncludeCache: false
        }
    )
})

test('normalizeProviderUsage reads OpenClaw internal usage fields', () => {
    assert.deepEqual(
        normalizeProviderUsage({
            input: 1200,
            output: 350,
            cacheRead: 400,
            cacheWrite: 500,
            totalTokens: 2450
        }),
        {
            inputTokens: 1200,
            outputTokens: 350,
            cacheReadTokens: 400,
            cacheCreationTokens: 500,
            inputTokensIncludeCache: false
        }
    )
})
