import type { ChatUsage } from '@manyfold/shared'
import type {
    ModelPriceScopeContext,
    UsagePricingService
} from '../../usage/usage-pricing.service'

export interface OpenAIUsage {
    prompt_tokens?: number
    input_tokens?: number
    input?: number
    inputTokens?: number
    completion_tokens?: number
    output_tokens?: number
    output?: number
    outputTokens?: number
    total_tokens?: number
    total?: number
    totalTokens?: number
    prompt_tokens_details?: {
        cached_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    }
    input_token_details?: {
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
    }
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    cacheRead?: number
    cacheReadTokens?: number
    cacheWrite?: number
    cacheCreationTokens?: number
}

export interface NormalizedProviderUsage {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    inputTokensIncludeCache: boolean
}

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0

export const normalizeProviderUsage = (
    usage: OpenAIUsage
): NormalizedProviderUsage => {
    const cacheReadTokens = toInt(
        usage.cache_read_input_tokens ??
            usage.cacheRead ??
            usage.cacheReadTokens ??
            usage.prompt_tokens_details?.cached_tokens ??
            usage.prompt_tokens_details?.cache_read_input_tokens ??
            usage.input_token_details?.cache_read_input_tokens
    )
    const cacheCreationTokens = toInt(
        usage.cache_creation_input_tokens ??
            usage.cacheWrite ??
            usage.cacheCreationTokens ??
            usage.prompt_tokens_details?.cache_creation_input_tokens ??
            usage.input_token_details?.cache_creation_input_tokens
    )
    const hasOpenAiPromptTotals =
        usage.prompt_tokens !== undefined ||
        usage.prompt_tokens_details?.cached_tokens !== undefined ||
        usage.input_token_details?.cache_read_input_tokens !== undefined
    return {
        inputTokens: toInt(
            usage.prompt_tokens ??
                usage.input_tokens ??
                usage.input ??
                usage.inputTokens
        ),
        outputTokens: toInt(
            usage.completion_tokens ??
                usage.output_tokens ??
                usage.output ??
                usage.outputTokens
        ),
        cacheReadTokens,
        cacheCreationTokens,
        inputTokensIncludeCache: hasOpenAiPromptTotals
    }
}

export const buildOpenAiUsage = (
    usage: OpenAIUsage,
    model: string | null,
    tStart: number,
    tFirstToken: number | null,
    pricing: UsagePricingService,
    scope?: ModelPriceScopeContext
): ChatUsage => {
    const normalized = normalizeProviderUsage(usage)
    const { inputTokensIncludeCache, ...tokens } = normalized
    const cost = pricing.computeCost({
        model,
        ...tokens,
        inputTokensIncludeCache,
        modelProviderId: scope?.modelProviderId ?? null,
        modelProviderBuiltInId: scope?.modelProviderBuiltInId ?? null
    })
    return {
        model,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        firstTokenMs: tFirstToken !== null ? tFirstToken - tStart : null,
        totalMs: Date.now() - tStart
    }
}
