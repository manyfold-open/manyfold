import type { LiteLlmModelPricing } from '../src/modules/usage/usage-pricing.service'

// A realistic slice of the LiteLLM table, kept as fixture data now that the
// engine seeds itself from model_price_snapshots instead of a bundled file. The
// ranking tests need real-world id shapes (dated suffixes, reasoning tiers,
// version-adjacent siblings) to be worth anything.
export const LITELLM_PRICING_SAMPLE: Record<string, LiteLlmModelPricing> = {
    'gpt-5': {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.000000125
    },
    'gpt-5-mini': {
        input_cost_per_token: 0.00000025,
        output_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.000000025
    },
    'gpt-5.6-sol': {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.00003,
        cache_read_input_token_cost: 0.0000005
    },
    'gpt-5.6-terra': {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.00000025
    },
    'gpt-5.6-luna': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000006,
        cache_read_input_token_cost: 0.0000001
    },
    'gpt-5.5': {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.00003,
        cache_read_input_token_cost: 0.0000005
    },
    'gpt-5.4': {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.000015,
        cache_read_input_token_cost: 0.00000025
    },
    'gpt-5.4-mini': {
        input_cost_per_token: 0.00000075,
        output_cost_per_token: 0.0000045,
        cache_read_input_token_cost: 0.000000075
    },
    'azure/gpt-5-codex': {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.000000125
    },
    'azure/gpt-5.2-codex': {
        input_cost_per_token: 0.00000175,
        output_cost_per_token: 0.000014,
        cache_read_input_token_cost: 0.000000175
    },
    'azure/gpt-5.3-codex': {
        input_cost_per_token: 0.00000175,
        output_cost_per_token: 0.000014,
        cache_read_input_token_cost: 0.000000175
    },
    'gpt-4o': {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.00000125
    },
    'gpt-4o-mini': {
        input_cost_per_token: 0.00000015,
        output_cost_per_token: 0.0000006,
        cache_read_input_token_cost: 0.000000075
    },
    'claude-sonnet-4-20250514': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_creation_input_token_cost: 0.00000375,
        cache_read_input_token_cost: 0.0000003
    },
    'claude-opus-4-20250514': {
        input_cost_per_token: 0.000015,
        output_cost_per_token: 0.000075,
        cache_creation_input_token_cost: 0.00001875,
        cache_read_input_token_cost: 0.0000015
    },
    'claude-fable-5': {
        input_cost_per_token: 0.00001,
        output_cost_per_token: 0.00005,
        cache_creation_input_token_cost: 0.0000125,
        cache_read_input_token_cost: 0.000001
    },
    'claude-opus-4-8': {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_creation_input_token_cost: 0.00000625,
        cache_read_input_token_cost: 0.0000005
    },
    'claude-opus-4-7': {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_creation_input_token_cost: 0.00000625,
        cache_read_input_token_cost: 0.0000005
    },
    'claude-opus-4-6': {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_creation_input_token_cost: 0.00000625,
        cache_read_input_token_cost: 0.0000005
    },
    'claude-sonnet-5': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000015,
        cache_creation_input_token_cost: 0.00000375,
        cache_read_input_token_cost: 0.0000003
    },
    'claude-haiku-4-5': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000005,
        cache_creation_input_token_cost: 0.00000125,
        cache_read_input_token_cost: 0.0000001
    },
    'claude-haiku-4-5-20251001': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000005,
        cache_creation_input_token_cost: 0.00000125,
        cache_read_input_token_cost: 0.0000001
    },
    // Covers the gateway's tiered ids too (gemini-3.6-flash-high/-medium/
    // -low/-tiered) via findModelPricing's boundary match, which is why only
    // the base id is listed.
    'gemini-3.6-flash': {
        input_cost_per_token: 0.0000015,
        output_cost_per_token: 0.0000075,
        cache_read_input_token_cost: 0.00000015
    },
    'gemini-3.5-flash': {
        input_cost_per_token: 0.0000015,
        output_cost_per_token: 0.000009,
        cache_read_input_token_cost: 0.00000015
    },
    'gemini-3.1-flash-lite': {
        input_cost_per_token: 0.00000025,
        output_cost_per_token: 0.0000015,
        cache_read_input_token_cost: 0.000000025
    },
    'gemini-3.1-pro-preview': {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000002
    },
    'gemini-3-flash-preview': {
        input_cost_per_token: 0.0000005,
        output_cost_per_token: 0.000003,
        cache_read_input_token_cost: 0.00000005
    },
    'gemini-2.5-pro': {
        input_cost_per_token: 0.00000125,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.000000125
    },
    'gemini-2.5-flash': {
        input_cost_per_token: 0.0000003,
        output_cost_per_token: 0.0000025,
        cache_read_input_token_cost: 0.00000003
    },
    'gemini-2.5-flash-lite': {
        input_cost_per_token: 0.0000001,
        output_cost_per_token: 0.0000004,
        cache_read_input_token_cost: 0.00000001
    }
}
