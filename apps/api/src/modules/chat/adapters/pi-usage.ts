import type { ChatUsage } from '@manyfold/shared'
import { piBareModelId } from '@manyfold/shared'
import type {
    ModelPriceScopeContext,
    UsagePricingService
} from '../../usage/usage-pricing.service'

// pi reports usage per assistant message ({input, output, cacheRead,
// cacheWrite, totalTokens, cost}) and a tool-using turn has several, so the
// adapter sums them and prices the total once through the platform's own
// price table — pi's `cost` is its notion of list price, not what the bound
// provider bills.
export interface PiUsageTotals {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    messages: number
}

export const emptyPiUsageTotals = (): PiUsageTotals => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messages: 0
})

export const addPiUsage = (
    totals: PiUsageTotals,
    raw: unknown
): PiUsageTotals => {
    if (!isRecord(raw)) return totals
    return {
        inputTokens: totals.inputTokens + toInt(raw.input),
        outputTokens: totals.outputTokens + toInt(raw.output),
        cacheReadTokens: totals.cacheReadTokens + toInt(raw.cacheRead),
        cacheCreationTokens: totals.cacheCreationTokens + toInt(raw.cacheWrite),
        messages: totals.messages + 1
    }
}

export const piUsageToChatUsage = (
    totals: PiUsageTotals,
    model: string | null,
    tStart: number,
    tFirstToken: number | null,
    pricing: UsagePricingService,
    opts: {
        fallbackModelIsAssumed?: boolean
        scope?: ModelPriceScopeContext
    } = {}
): ChatUsage => {
    const priceModel = model ? piBareModelId(model) : null
    const cost = pricing.computeCost({
        model: priceModel,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
        modelProviderId: opts.scope?.modelProviderId ?? null,
        modelProviderBuiltInId: opts.scope?.modelProviderBuiltInId ?? null
    })
    return {
        model: priceModel,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreationTokens: totals.cacheCreationTokens,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        isFallbackModel: opts.fallbackModelIsAssumed ?? false,
        firstTokenMs: tFirstToken !== null ? tFirstToken - tStart : null,
        totalMs: Date.now() - tStart
    }
}

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null
