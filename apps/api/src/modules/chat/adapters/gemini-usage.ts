import type { ChatUsage } from '@manyfold/shared'
import type {
    ModelPriceScopeContext,
    UsagePricingService
} from '../../usage/usage-pricing.service'

// Parses the stream-json `result` event stats (gemini-cli JsonFormatter →
// convertToStreamStats, verified against gemini-cli 0.41.2):
//   stats: {
//     total_tokens, input_tokens, output_tokens, cached, input, duration_ms,
//     tool_calls,
//     models: { [modelName]: { total_tokens, input_tokens, output_tokens,
//                              cached, input } }
//   }
// One ChatUsage per model breakdown so Auto routing, fallbacks and subagents
// are billed against the model that actually served the tokens. input_tokens
// (prompt) includes cached tokens, matching computeCost's default handling.
// output_tokens counts candidate tokens only; thought tokens are not broken
// out per model in this shape.
export const extractGeminiUsage = (
    parsed: Record<string, unknown>,
    fallbackModel: string | null,
    tStart: number,
    tFirstToken: number | null,
    pricing: UsagePricingService,
    scope?: ModelPriceScopeContext
): ChatUsage[] => {
    const stats = isRecord(parsed.stats) ? parsed.stats : null
    if (!stats) return []
    const breakdowns: Array<{ model: string | null; tokens: TokenCounts }> = []
    const models = isRecord(stats.models) ? stats.models : null
    if (models) {
        for (const [model, raw] of Object.entries(models)) {
            if (!isRecord(raw)) continue
            breakdowns.push({ model: model.trim() || null, tokens: counts(raw) })
        }
    }
    if (breakdowns.length === 0) breakdowns.push({ model: null, tokens: counts(stats) })

    const out: ChatUsage[] = []
    for (const { model, tokens } of breakdowns) {
        if (tokens.input === 0 && tokens.output === 0 && tokens.cached === 0)
            continue
        const usageModel = model ?? fallbackModel
        const cost = pricing.computeCost({
            model: usageModel,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadTokens: tokens.cached,
            cacheCreationTokens: 0,
            modelProviderId: scope?.modelProviderId ?? null,
            modelProviderBuiltInId: scope?.modelProviderBuiltInId ?? null
        })
        out.push({
            model: usageModel,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadTokens: tokens.cached,
            cacheCreationTokens: 0,
            costUsd: cost.costUsd,
            costSource: cost.costSource,
            isFallbackModel: !model && !!fallbackModel,
            firstTokenMs: tFirstToken !== null ? tFirstToken - tStart : null,
            totalMs: Date.now() - tStart
        })
    }
    return out
}

interface TokenCounts {
    input: number
    output: number
    cached: number
}

const counts = (raw: Record<string, unknown>): TokenCounts => ({
    input: toInt(raw.input_tokens),
    output: toInt(raw.output_tokens),
    cached: toInt(raw.cached)
})

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null
