import type { ChatUsage } from '@manyfold/shared'
import type {
    ModelPriceScopeContext,
    UsagePricingService
} from '../../usage/usage-pricing.service'

export const extractCodexUsage = (
    parsed: Record<string, unknown>,
    fallbackModel: string | null,
    tStart: number,
    tFirstToken: number | null,
    pricing: UsagePricingService,
    opts: {
        fallbackModelIsAssumed?: boolean
        scope?: ModelPriceScopeContext
    } = {}
): ChatUsage | null => {
    const raw = parsed.usage ?? (parsed as { turn?: { usage?: unknown } }).turn
    const usage = unwrapUsage(raw) ?? unwrapUsage(parsed.usage)
    if (!usage) return null
    const parsedModel = extractCodexModel(parsed, usage)
    const model = parsedModel ?? fallbackModel
    const isFallbackModel =
        !parsedModel && !!fallbackModel && (opts.fallbackModelIsAssumed ?? true)
    const input = toInt(usage.input_tokens ?? usage.prompt_tokens)
    const output = toInt(usage.output_tokens ?? usage.completion_tokens)
    const cacheRead = toInt(
        usage.cached_input_tokens ?? usage.cache_read_input_tokens
    )
    const cacheCreation = toInt(usage.cache_creation_input_tokens)
    const cost = pricing.computeCost({
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        modelProviderId: opts.scope?.modelProviderId ?? null,
        modelProviderBuiltInId: opts.scope?.modelProviderBuiltInId ?? null
    })
    return {
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        isFallbackModel,
        firstTokenMs: tFirstToken !== null ? tFirstToken - tStart : null,
        totalMs: Date.now() - tStart
    }
}

const extractCodexModel = (
    parsed: Record<string, unknown>,
    usage: Record<string, unknown>
): string | null => {
    const turn = isRecord(parsed.turn) ? parsed.turn : null
    const response = isRecord(parsed.response) ? parsed.response : null
    const item = isRecord(parsed.item) ? parsed.item : null
    const payload = isRecord(parsed.payload) ? parsed.payload : null
    const turnUsage = turn && isRecord(turn.usage) ? turn.usage : null
    const turnResponse = turn && isRecord(turn.response) ? turn.response : null
    const turnItem = turn && isRecord(turn.item) ? turn.item : null
    const payloadTurn = payload && isRecord(payload.turn) ? payload.turn : null
    const payloadUsage =
        payload && isRecord(payload.usage) ? payload.usage : null
    const payloadResponse =
        payload && isRecord(payload.response) ? payload.response : null
    const payloadItem = payload && isRecord(payload.item) ? payload.item : null
    const candidates = [
        parsed.model,
        parsed.model_name,
        turn?.model,
        turn?.model_name,
        usage.model,
        usage.model_name,
        turnUsage?.model,
        turnUsage?.model_name,
        response?.model,
        response?.model_name,
        item?.model,
        item?.model_name,
        turnResponse?.model,
        turnResponse?.model_name,
        turnItem?.model,
        turnItem?.model_name,
        payload?.model,
        payload?.model_name,
        payloadTurn?.model,
        payloadTurn?.model_name,
        payloadUsage?.model,
        payloadUsage?.model_name,
        payloadResponse?.model,
        payloadResponse?.model_name,
        payloadItem?.model,
        payloadItem?.model_name
    ]
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue
        const trimmed = candidate.trim()
        if (trimmed) return trimmed
    }
    return null
}

const unwrapUsage = (raw: unknown): Record<string, unknown> | null => {
    if (!isRecord(raw)) return null
    if (isRecord(raw.usage)) return raw.usage
    return raw
}

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null
