// A slice of NetMind's price-table body, copied verbatim from the live response
// (2026-07-28) and trimmed to the rows that carry a rule:
//
// - anthropic/claude-sonnet-5   the only shape with a cache WRITE rate
// - google/gemini-3.5-flash     a bare-id turn has to reach this through the
//                               `google/` prefix candidate
// - Qwen/Qwen3.7-Plus           two price_details: base tier + long-context band
// - openai/gpt-5.4              carries member_price AND four competitor blocks,
//                               none of which may ever be read as the rate
// - BAAI/bge-m3                 Embedding: token-billed, input only
// - google/imagen-4.0           billing_type 'Image': NOT a token rate
//
// Kept as raw JSON rather than a parsed map so the parser is what the tests
// exercise: the competitor blocks are the whole reason this fixture exists.
// The `success` / `status` / `data` wrapper is the old gateway's envelope; the
// new one publishes the same groups at the top level, which the parser also
// accepts and which the tests derive from `.data` rather than duplicating.
export const NETMIND_PRICING_SAMPLE: Record<string, unknown> = {
    success: true,
    status: 200,
    data: {
        Chat: [
            {
                usd_input_token_price_str: '$2.0',
                usd_output_token_price_str: '$10.0',
                usd_cache_read_token_price_str: '$0.2',
                usd_cache_write_token_price_str: '$2.5',
                price_details: [
                    {
                        usd_input_token_price_unit: 2,
                        usd_output_token_price_unit: 10,
                        usd_cache_read_token_price_unit: 0.2,
                        usd_cache_write_token_price_unit: 2.5,
                        cny_input_token_price_unit: 14.6,
                        cny_output_token_price_unit: 73,
                        anthropic: {
                            usd_input_token_price_unit: 3,
                            usd_output_token_price_unit: 15,
                            usd_cache_read_token_price_unit: 0.3
                        }
                    }
                ],
                context: '1M',
                billing_type: '1M Tokens',
                model: 'anthropic/claude-sonnet-5'
            },
            {
                usd_input_token_price_str: '$1.5',
                usd_output_token_price_str: '$9.0',
                price_details: [
                    {
                        usd_input_token_price_unit: 1.5,
                        usd_output_token_price_unit: 9,
                        usd_cache_read_token_price_unit: 0.15,
                        cny_input_token_price_unit: 10.95,
                        google: {
                            usd_input_token_price_unit: 0.3,
                            usd_output_token_price_unit: 2.5
                        }
                    }
                ],
                context: '1024K',
                billing_type: '1M Tokens',
                model: 'google/gemini-3.5-flash'
            },
            {
                usd_input_token_price_str: '$0.274',
                usd_output_token_price_str: '$1.096',
                price_details: [
                    {
                        name: '≤256K',
                        max_input_tokens: 262144,
                        usd_input_token_price_unit: 0.274,
                        usd_output_token_price_unit: 1.096,
                        usd_cache_read_token_price_unit: 0.0548,
                        aliyun: {
                            usd_input_token_price_unit: 0.2739726,
                            usd_output_token_price_unit: 1.09589041
                        }
                    },
                    {
                        name: '256K-1M',
                        usd_input_token_price_unit: 0.822,
                        usd_output_token_price_unit: 3.288,
                        usd_cache_read_token_price_unit: 0.164
                    }
                ],
                context: '1M',
                billing_type: '1M Tokens',
                model: 'Qwen/Qwen3.7-Plus'
            },
            {
                usd_input_token_price_str: '$2.5',
                usd_output_token_price_str: '$15.0',
                price_details: [
                    {
                        usd_input_token_price_unit: 2.5,
                        usd_output_token_price_unit: 15,
                        usd_cache_read_token_price_unit: 0.25,
                        member_price: {
                            factor: 0.8,
                            effective_factor: 0.8,
                            usd_input_token_price_unit: 2,
                            usd_output_token_price_unit: 12,
                            usd_cache_read_token_price_unit: 0.2
                        },
                        openai: {
                            usd_input_token_price_unit: 1.25,
                            usd_output_token_price_unit: 10,
                            usd_cache_read_token_price_unit: 0.125
                        },
                        openrouter: {
                            usd_input_token_price_unit: 1.3,
                            usd_output_token_price_unit: 11
                        }
                    }
                ],
                context: '1M',
                billing_type: '1M Tokens',
                model: 'openai/gpt-5.4'
            }
        ],
        Embedding: [
            {
                price_details: [
                    {
                        usd_input_token_price_unit: 0.01,
                        cny_input_token_price_unit: 0.073
                    }
                ],
                billing_type: '1M Tokens',
                model: 'BAAI/bge-m3'
            }
        ],
        Image: [
            {
                usd_price_str: '$0.04/Image',
                price_details: [{ usd_price_unit: 0.04 }],
                billing_type: 'Image',
                model: 'google/imagen-4.0'
            }
        ]
    }
}
