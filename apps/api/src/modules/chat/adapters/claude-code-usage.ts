import {
    compareSemverPrecedence,
    resolveClaudeCodeProviderModel,
    type ChatUsage,
    type ClaudeCodeModelMap
} from '@manyfold/shared'
import type {
    ModelPriceScopeContext,
    UsagePricingService
} from '../../usage/usage-pricing.service'

export interface ClaudeModelUsage {
    input_tokens?: number
    inputTokens?: number
    output_tokens?: number
    outputTokens?: number
    cache_creation_input_tokens?: number
    cacheCreationInputTokens?: number
    cache_read_input_tokens?: number
    cacheReadInputTokens?: number
}

export interface ClaudeResultUsage {
    input_tokens?: number
    inputTokens?: number
    output_tokens?: number
    outputTokens?: number
    cache_creation_input_tokens?: number
    cacheCreationInputTokens?: number
    cache_read_input_tokens?: number
    cacheReadInputTokens?: number
}

export interface StreamJsonLine {
    type?: string
    subtype?: string
    session_id?: string
    // system/init: the model the run resolved, and the CLI's version.
    model?: string
    claude_code_version?: string
    message?: {
        id?: string
        model?: string
        content?: Array<{ type: string } & Record<string, unknown>>
    }
    tool_use_id?: string
    result?: string
    is_error?: boolean
    total_cost_usd?: number
    usage?: ClaudeResultUsage
    modelUsage?: Record<string, ClaudeModelUsage>
    // --include-partial-messages lines: type 'stream_event' carrying the raw
    // Anthropic streaming event; parent_tool_use_id is non-null on subagent
    // streams (their text still arrives via complete assistant lines).
    parent_tool_use_id?: string | null
    event?: {
        type?: string
        delta?: {
            type?: string
            text?: string
            thinking?: string
        }
    }
}

// From this version on, a resumed headless run restores its session's cost
// ledger: the result line's total_cost_usd and modelUsage are the session's
// running totals, and the first modelUsage key is the session's first
// model. Its `usage` still counts the run alone (the main loop).
export const CLAUDE_RESUMED_COST_LEDGER_VERSION = '2.1.277'

// What the run's own lines say about the model it ran on and its CLI.
export interface ClaudeRunFacts {
    initModel: string | null
    assistantModel: string | null
    cliVersion: string | null
}

export const newClaudeRunFacts = (): ClaudeRunFacts => ({
    initModel: null,
    assistantModel: null,
    cliVersion: null
})

export const observeClaudeRun = (
    facts: ClaudeRunFacts,
    parsed: StreamJsonLine
): void => {
    if (parsed.type === 'system' && parsed.subtype === 'init') {
        if (typeof parsed.model === 'string' && parsed.model)
            facts.initModel = parsed.model
        if (typeof parsed.claude_code_version === 'string')
            facts.cliVersion = parsed.claude_code_version
    }
    // A subagent's messages carry the subagent's model.
    if (
        parsed.type === 'assistant' &&
        parsed.parent_tool_use_id == null &&
        !facts.assistantModel &&
        typeof parsed.message?.model === 'string' &&
        parsed.message.model
    )
        facts.assistantModel = parsed.message.model
}

export interface ClaudeTurnUsage {
    facts: ClaudeRunFacts
    // Whether the run resumed a session; null when not known (a re-attach).
    resumed: boolean | null
    // The --model the run was given, and the mapping its alias resolves by.
    requestedModel: string | null
    modelMap?: ClaudeCodeModelMap
    pricing: Pick<UsagePricingService, 'computeCost'> | null
    scope?: ModelPriceScopeContext
}

const restoresLedger = (turn: ClaudeTurnUsage): boolean =>
    turn.resumed !== false &&
    compareSemverPrecedence(
        turn.facts.cliVersion,
        CLAUDE_RESUMED_COST_LEDGER_VERSION
    ) !== -1

// Without `turn` (callers that know nothing of the run) the result line is
// read as it stands.
export const extractClaudeCodeUsage = (
    parsed: StreamJsonLine,
    fallbackModel: string | null,
    tStart: number,
    tFirstToken: number | null,
    turn?: ClaudeTurnUsage
): ChatUsage | null => {
    const modelEntries = parsed.modelUsage
        ? Object.entries(parsed.modelUsage)
        : []
    const [firstModel, firstModelUsage] = modelEntries[0] ?? []
    const rawUsage = parsed.usage ?? firstModelUsage
    if (!rawUsage) return null

    const input = toInt(rawUsage.input_tokens ?? rawUsage.inputTokens)
    const output = toInt(rawUsage.output_tokens ?? rawUsage.outputTokens)
    const cacheRead = toInt(
        rawUsage.cache_read_input_tokens ?? rawUsage.cacheReadInputTokens
    )
    const cacheCreation = toInt(
        rawUsage.cache_creation_input_tokens ??
            rawUsage.cacheCreationInputTokens
    )

    const model =
        turn?.facts.initModel ??
        turn?.facts.assistantModel ??
        (turn?.requestedModel
            ? resolveClaudeCodeProviderModel(turn.requestedModel, turn.modelMap)
            : null) ??
        (firstModel || fallbackModel)
    // The ledger's total covers the session's earlier runs too, so the run
    // is priced from its own tokens instead.
    const cost =
        turn && restoresLedger(turn)
            ? (turn.pricing?.computeCost({
                  model,
                  inputTokens: input,
                  outputTokens: output,
                  cacheReadTokens: cacheRead,
                  cacheCreationTokens: cacheCreation,
                  // Anthropic counts cache tokens apart from input_tokens.
                  inputTokensIncludeCache: false,
                  modelProviderId: turn.scope?.modelProviderId ?? null,
                  modelProviderBuiltInId:
                      turn.scope?.modelProviderBuiltInId ?? null,
                  modelProviderManagedBrand:
                      turn.scope?.modelProviderManagedBrand ?? null
              }) ?? { costUsd: null, costSource: 'unknown' as const })
            : typeof parsed.total_cost_usd === 'number'
              ? {
                    costUsd: parsed.total_cost_usd,
                    costSource: 'upstream' as const
                }
              : { costUsd: null, costSource: 'unknown' as const }

    return {
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        costUsd: cost.costUsd,
        costSource: cost.costSource,
        firstTokenMs: tFirstToken !== null ? tFirstToken - tStart : null,
        totalMs: Date.now() - tStart
    }
}

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
