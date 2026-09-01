import {
    CostSource,
    GLOBAL_MODEL_PRICE_SOURCES,
    MODEL_PRICE_SOURCES,
    ModelPriceScope,
    ModelPriceSource,
    ModelPriceTableEntry,
    lookupBuiltIn
} from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnModuleInit
} from '@nestjs/common'
import { isNotNull, or } from 'drizzle-orm'
import { scopedModelPrices, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    MANAGED_PRICING_PORT,
    noManagedPricingPort,
    type ManagedPricingPort
} from '@/common/ports/managed-models.ports'
import { ModelPriceSnapshotRepository } from './model-price-snapshot.repository'

const LITELLM_PRICING_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const MODELS_DEV_PRICING_URL = 'https://models.dev/api.json'
const NETMIND_PRICING_URL = 'https://inference.api.netmind.ai/v1/price/model'
const FETCH_TIMEOUT_MS = 15_000

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
// Admin price edits should land on live metering in a minute, not a day.
const DEFAULT_OVERRIDE_TTL_MS = 60_000

export { MODEL_PRICE_SOURCES }
export type { ModelPriceSource }

// Bumped when a parser changes what it stores. The persisted etag carries this
// prefix so a deploy that changes the parse cannot stay pinned to the old
// payload — a fresh fetchedAt would skip the fetch and a matching origin etag
// would 304 it, either way keeping the stale rows forever. A version mismatch
// keeps serving the stored prices but forces one full refetch immediately.
const SNAPSHOT_PARSE_VERSIONS: Record<ModelPriceSource, number> = {
    litellm: 1,
    // 2: every models.dev provider is ingested, not just the official labs.
    models_dev: 2,
    // 2: the rates moved to NetMind's new gateway. The parse result is
    // unchanged, but a snapshot row written from the old origin still carries a
    // fresh fetchedAt, which would skip the fetch for up to a day and leave the
    // dead endpoint's table in place; the bump forces one refetch at boot.
    netmind: 2
}

const wrapSnapshotEtag = (
    source: ModelPriceSource,
    etag: string | null
): string => `${SNAPSHOT_PARSE_VERSIONS[source]}:${etag ?? ''}`

// Origin etags are quoted ("…" / W/"…"), so a digits-then-colon prefix can only
// be ours; an unprefixed value is a legacy row from before versioning (= 1).
const unwrapSnapshotEtag = (
    source: ModelPriceSource,
    stored: string | null
): { current: boolean; etag: string | null } => {
    const match = /^(\d+):([\s\S]*)$/.exec(stored ?? '')
    const version = match ? Number(match[1]) : 1
    const etag = match ? match[2] || null : stored
    return { current: version === SNAPSHOT_PARSE_VERSIONS[source], etag }
}

// Candidate prefixes tried when the bare id is not a key, official first: a model
// must be priced by whoever makes it before anyone who resells it. The azure and
// bedrock entries stay because MODEL_ALIASES deliberately points the codex ids at
// `azure/…`, which is the only place LiteLLM prices them.
const PROVIDER_PREFIXES = [
    'anthropic/',
    'openai/',
    'gemini/',
    'google/',
    'vertex_ai/',
    'azure/',
    'azure/global/',
    'azure/eu/',
    'azure/us/',
    'bedrock/',
    'bedrock/us.',
    'bedrock/eu.',
    'bedrock/apac.',
    'openrouter/openai/'
]

// Keys a fuzzy match may consider: bare ids and the official namespaces only.
// An allowlist rather than a denylist of resellers, because the reseller list
// grows every week and a missed entry silently reprices a model.
const OFFICIAL_KEY_PREFIXES = [
    'anthropic/',
    'openai/',
    'gemini/',
    'google/',
    'vertex_ai/'
]

// `us.anthropic.claude-…`, `global.anthropic.…`: bedrock's regional ids, priced
// per region and never the official rate.
const REGIONAL_KEY = /^(global|us|eu|apac|au|jp|ca|me|sa)\.|^anthropic\./

// Reasoning budgets the gateway exposes as their own model ids. None of them is
// priced anywhere upstream: they bill at the base model's token rate, so the base
// id is tried as a candidate too.
//
// Direction-A matching already covers the easy half of this (`gemini-3.5-flash-low`
// finds the `gemini-3.5-flash` key it contains). Stripping is what covers the rest:
// `gemini-3-pro-high` has no `gemini-3-pro` key to contain, but `gemini-3-pro`
// itself resolves to `gemini-3-pro-preview`, so the tier can ride that.
const REASONING_TIER_SUFFIXES = [
    'extra-low',
    'minimal',
    'tiered',
    'high',
    'medium',
    'low'
]

const stripReasoningTier = (model: string): string | null => {
    for (const suffix of REASONING_TIER_SUFFIXES)
        if (model.endsWith(`-${suffix}`))
            return model.slice(0, -(suffix.length + 1))
    return null
}

const MODEL_ALIASES: Record<string, string> = {
    'gpt-5-codex': 'gpt-5',
    'gpt-5.1-codex': 'azure/gpt-5.1-codex',
    'gpt-5.1-codex-mini': 'azure/gpt-5.1-codex-mini',
    'gpt-5.2-codex': 'azure/gpt-5.2-codex',
    'gpt-5.3-codex': 'azure/gpt-5.3-codex',
    'claude-sonnet-4-6': 'claude-sonnet-4-20250514',
    'claude-sonnet-4-7': 'claude-sonnet-4-20250514',
    'claude-haiku-4-5': 'claude-haiku-4-5'
}

// Words that make an id a DIFFERENT priced product rather than a variant of the
// same one: modalities and size tiers. A fuzzy match whose extra text contains
// any of them is rejected outright — this is what stops `gemini-3-pro` from being
// priced off `gemini-3-pro-image`, and `gpt-5.4-mini` off `gpt-5.4`.
//
// Reasoning budgets (`-high`, `-medium`, `-low`, `-tiered`) are deliberately NOT
// here: the gateway exposes those as their own ids and they bill at the base
// model's token rate, so they must keep resolving off it. Unknown words are
// treated as variants, which keeps a brand-new suffix behaving as it does today
// instead of dropping a model to unpriced.
const PRODUCT_TOKENS = new Set([
    'image',
    'images',
    'imagen',
    'tts',
    'audio',
    'speech',
    'voice',
    'live',
    'realtime',
    'embedding',
    'embeddings',
    'embed',
    'rerank',
    'moderation',
    'guard',
    'ocr',
    'transcribe',
    'translate',
    'translation',
    'vision',
    'video',
    'veo',
    'lyria',
    'robotics',
    'search',
    'computer',
    'codex',
    'mini',
    'nano',
    'lite',
    'small',
    'pro',
    'max',
    'ultra',
    'flash',
    'opus',
    'sonnet',
    'haiku',
    'chat'
])

export type LiteLlmModelPricing = ModelPriceTableEntry

// Which provider row served the turn, when the caller knows. Prices configured
// for that row (or its built-in provider) win over the global tables.
export interface ModelPriceScopeContext {
    modelProviderId?: string | null
    modelProviderBuiltInId?: string | null
}

export interface UsagePricingInput extends ModelPriceScopeContext {
    model: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    inputTokensIncludeCache?: boolean
}

export interface ComputedCost {
    costUsd: number | null
    costSource: CostSource
}

// null `raw` means the origin answered 304: whatever is cached is still current.
export interface PricingFetch {
    raw: Record<string, unknown> | null
    etag: string | null
}

export type PricingFetcher = (etag: string | null) => Promise<PricingFetch>

export interface ModelPriceSnapshotPayload {
    prices: Record<string, LiteLlmModelPricing>
    etag: string | null
    fetchedAt: Date
}

export interface ModelPriceRef {
    source: ModelPriceSource
    key: string
}

// One scope's configuration for one model id. Within a scope a typed price
// beats that scope's pin.
export interface ScopeModelConfig {
    override?: LiteLlmModelPricing
    pin?: ModelPriceRef
}

export type ScopeEntryMap = Map<string, ScopeModelConfig>

// Everything operators and users have configured, in resolution order:
// `scopes` holds the provider rows (`row:<providerId>`) and built-in defaults
// (`builtin:<builtInId>`); `overrides`/`pins` are the managed catalog's global
// layer, unchanged from when they were the only one.
export interface ModelPriceConfigIndex {
    overrides: Map<string, LiteLlmModelPricing>
    pins: Map<string, ModelPriceRef>
    scopes: Map<string, ScopeEntryMap>
}

export interface UsagePricingOptions {
    fetchPricing?: PricingFetcher
    fetchModelsDev?: PricingFetcher
    fetchNetmind?: PricingFetcher
    ttlMs?: number
    // Configured per-token prices and source pins — the managed catalog's global
    // layer plus the per-provider and per-built-in scopes. All matched EXACTLY
    // (never fuzzily): every key is a real upstream model id, so exact is both
    // complete and predictable for whoever set the number.
    loadPriceConfig?: () => Promise<ModelPriceConfigIndex>
    overrideTtlMs?: number
    loadSnapshot?: (
        source: ModelPriceSource
    ) => Promise<ModelPriceSnapshotPayload | null>
    saveSnapshot?: (
        source: ModelPriceSource,
        payload: ModelPriceSnapshotPayload
    ) => Promise<void>
}

export interface ModelPriceConfigRow {
    modelId: string
    inputCostPerToken: string | null
    outputCostPerToken: string | null
    cacheReadCostPerToken: string | null
    cacheCreationCostPerToken: string | null
    priceRefSource?: ModelPriceSource | null
    priceRefKey?: string | null
}

export interface ScopedModelPriceConfigRow extends ModelPriceConfigRow {
    builtInId: string | null
    providerId: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

const toFiniteNumber = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined

const normalizeModel = (model: string): string => model.trim().toLowerCase()

const toPriceNumber = (v: string | null): number | undefined => {
    if (v === null) return undefined
    const parsed = Number(v)
    return Number.isFinite(parsed) ? parsed : undefined
}

const hasBasePrice = (pricing: LiteLlmModelPricing): boolean =>
    pricing.input_cost_per_token !== undefined ||
    pricing.output_cost_per_token !== undefined

const rowPricing = (row: ModelPriceConfigRow): LiteLlmModelPricing => ({
    input_cost_per_token: toPriceNumber(row.inputCostPerToken),
    output_cost_per_token: toPriceNumber(row.outputCostPerToken),
    cache_creation_input_token_cost: toPriceNumber(
        row.cacheCreationCostPerToken
    ),
    cache_read_input_token_cost: toPriceNumber(row.cacheReadCostPerToken)
})

// Last row wins when two brands carry the same model id: an id is priced by
// what it costs, not by which channel routes it, so a disagreement is an
// operator error rather than something to average.
export const overridePricingFromRows = (
    rows: readonly ModelPriceConfigRow[]
): Map<string, LiteLlmModelPricing> => {
    const out = new Map<string, LiteLlmModelPricing>()
    for (const row of rows) {
        const pricing = rowPricing(row)
        if (!hasBasePrice(pricing)) continue
        out.set(normalizeModel(row.modelId), pricing)
    }
    return out
}

// Same last-row-wins rule as the price overrides, for the same reason.
export const pinsFromRows = (
    rows: readonly ModelPriceConfigRow[]
): Map<string, ModelPriceRef> => {
    const out = new Map<string, ModelPriceRef>()
    for (const row of rows) {
        if (!row.priceRefSource || !row.priceRefKey) continue
        out.set(normalizeModel(row.modelId), {
            source: row.priceRefSource,
            key: row.priceRefKey
        })
    }
    return out
}

// Scoped rows are unique per (scope, model), so there is no last-row-wins here:
// each row simply lands in its scope's map. A row with neither a usable price
// nor a pin (the admin "manual add") configures nothing and is skipped, so it
// can never shadow a scope below it.
export const scopedPricesFromRows = (
    rows: readonly ScopedModelPriceConfigRow[]
): Map<string, ScopeEntryMap> => {
    const out = new Map<string, ScopeEntryMap>()
    for (const row of rows) {
        const scopeKey = row.providerId
            ? `row:${row.providerId}`
            : row.builtInId
              ? `builtin:${row.builtInId}`
              : null
        if (!scopeKey) continue
        const entry: ScopeModelConfig = {}
        const pricing = rowPricing(row)
        if (hasBasePrice(pricing)) entry.override = pricing
        if (row.priceRefSource && row.priceRefKey)
            entry.pin = { source: row.priceRefSource, key: row.priceRefKey }
        if (!entry.override && !entry.pin) continue
        const scope = out.get(scopeKey) ?? new Map<string, ScopeModelConfig>()
        scope.set(normalizeModel(row.modelId), entry)
        out.set(scopeKey, scope)
    }
    return out
}

// Fuzzy fallback matching is boundary-aware so version-suffixed ids cannot
// collapse onto a shorter base id: `gpt-5.5` must NOT match the `gpt-5` key
// (boundary `.` is part of the version), while `claude-sonnet-5-20260610`
// still matches `claude-sonnet-5` (boundary `-` separates a date suffix).
const PRICING_MATCH_BOUNDARY = /[-/:@\s]/

interface BoundaryMatch {
    // Text of the haystack past the needle, minus the separator.
    trailing: string
}

const boundaryMatch = (
    haystack: string,
    needle: string
): BoundaryMatch | null => {
    if (needle.length === 0 || haystack.length <= needle.length) return null
    const idx = haystack.indexOf(needle)
    if (idx === -1) return null
    const before = idx === 0 ? null : haystack[idx - 1]
    const afterIdx = idx + needle.length
    const after = afterIdx >= haystack.length ? null : haystack[afterIdx]
    if (before !== null && !PRICING_MATCH_BOUNDARY.test(before)) return null
    if (after !== null && !PRICING_MATCH_BOUNDARY.test(after)) return null
    return { trailing: haystack.slice(afterIdx).replace(/^[-/:@\s]+/, '') }
}

// Whether the extra text past the shared part still describes the same priced
// model. Any product word disqualifies the pair; everything else (dates, version
// stamps, reasoning budgets, unknown words) is treated as a variant.
const isVariantTrailing = (trailing: string): boolean => {
    if (trailing.length === 0) return true
    return !trailing
        .split(/[-/._:@\s]+/)
        .some((token) => PRODUCT_TOKENS.has(token))
}

export const parseLiteLlmPricing = (
    raw: Record<string, unknown>
): Map<string, LiteLlmModelPricing> => {
    const out = new Map<string, LiteLlmModelPricing>()
    for (const [model, value] of Object.entries(raw)) {
        if (!isRecord(value)) continue
        const pricing: LiteLlmModelPricing = {
            input_cost_per_token: toFiniteNumber(value.input_cost_per_token),
            output_cost_per_token: toFiniteNumber(value.output_cost_per_token),
            cache_creation_input_token_cost: toFiniteNumber(
                value.cache_creation_input_token_cost
            ),
            cache_read_input_token_cost: toFiniteNumber(
                value.cache_read_input_token_cost
            )
        }
        if (
            pricing.input_cost_per_token !== undefined ||
            pricing.output_cost_per_token !== undefined ||
            pricing.cache_creation_input_token_cost !== undefined ||
            pricing.cache_read_input_token_cost !== undefined
        )
            out.set(model, pricing)
    }
    return out
}

// models.dev publishes per-MILLION-token costs; everything downstream of here is
// per token. Tiered long-context rates (`tiers`, `context_over_200k`) are ignored
// for the same reason LiteLLM's `*_above_200k_tokens` fields are: the base rate is
// what the whole codebase meters with today.
// models.dev keys models under the provider that serves them. EVERY provider is
// ingested (~170 of them) so a pin or a search can reach any record, including a
// reseller whose rate is what a BYO key really pays. The automatic matcher still
// cannot land on a reseller's markup: exact candidates only try official
// namespaces and the fuzzy filter drops non-official keys outright.
export const parseModelsDevPricing = (
    raw: Record<string, unknown>
): Map<string, LiteLlmModelPricing> => {
    const perToken = (v: unknown): number | undefined => {
        const parsed = toFiniteNumber(v)
        return parsed === undefined ? undefined : parsed / 1_000_000
    }
    const out = new Map<string, LiteLlmModelPricing>()
    for (const [providerId, provider] of Object.entries(raw)) {
        if (!isRecord(provider) || !isRecord(provider.models)) continue
        for (const [modelId, value] of Object.entries(provider.models)) {
            if (!isRecord(value) || !isRecord(value.cost)) continue
            const pricing: LiteLlmModelPricing = {
                input_cost_per_token: perToken(value.cost.input),
                output_cost_per_token: perToken(value.cost.output),
                cache_read_input_token_cost: perToken(value.cost.cache_read),
                cache_creation_input_token_cost: perToken(
                    value.cost.cache_write
                )
            }
            if (!hasBasePrice(pricing)) continue
            out.set(`${providerId}/${modelId}`, pricing)
        }
    }
    return out
}

// NetMind's own rates, grouped by product category (`Chat`, `Embedding`, `Image`,
// `Video`, …) and published per MILLION tokens. Only `1M Tokens` rows are a token
// rate at all — the rest bill per Asset / Image / Second / Page / Call, which
// `costFromPrice` cannot express — so billing_type, not the category name, is the
// filter: a new token-billed category then needs no code change.
//
// The new gateway returns those groups at the top level; the old one wrapped
// them in `data`. Both are accepted because the rows inside are identical, so
// the URL can be pointed back without a matching code revert.
//
// Every rate is read from the FOUR NAMED KEYS of price_details[0] and nothing
// else. Each detail also nests `member_price` (a membership discount we cannot
// attribute — the endpoint never says whether an account has it) and one block
// per competing platform (`openai`, `google`, `openrouter`, `aliyun`, …) holding
// THAT platform's rate; a generic walk would meter NetMind turns at a
// competitor's price.
//
// price_details[0] is the base tier. Models with long-context tiers list the
// dearer band as a second entry, ignored for the same reason LiteLLM's
// `*_above_200k_tokens` and models.dev's `tiers` are: the base rate is what the
// whole codebase meters with today.
export const parseNetmindPricing = (
    raw: Record<string, unknown>
): Map<string, LiteLlmModelPricing> => {
    const data = isRecord(raw.data) ? raw.data : raw
    const perToken = (v: unknown): number | undefined => {
        const parsed = toFiniteNumber(v)
        return parsed === undefined ? undefined : parsed / 1_000_000
    }
    const out = new Map<string, LiteLlmModelPricing>()
    for (const group of Object.values(data)) {
        if (!Array.isArray(group)) continue
        for (const entry of group) {
            if (!isRecord(entry)) continue
            if (entry.billing_type !== '1M Tokens') continue
            const model =
                typeof entry.model === 'string' ? entry.model.trim() : ''
            if (!model) continue
            const detail = Array.isArray(entry.price_details)
                ? entry.price_details[0]
                : null
            if (!isRecord(detail)) continue
            const pricing: LiteLlmModelPricing = {
                input_cost_per_token: perToken(
                    detail.usd_input_token_price_unit
                ),
                output_cost_per_token: perToken(
                    detail.usd_output_token_price_unit
                ),
                cache_read_input_token_cost: perToken(
                    detail.usd_cache_read_token_price_unit
                ),
                cache_creation_input_token_cost: perToken(
                    detail.usd_cache_write_token_price_unit
                )
            }
            if (!hasBasePrice(pricing)) continue
            out.set(model, pricing)
        }
    }
    return out
}

const SOURCE_PARSERS: Record<
    ModelPriceSource,
    (raw: Record<string, unknown>) => Map<string, LiteLlmModelPricing>
> = {
    litellm: parseLiteLlmPricing,
    models_dev: parseModelsDevPricing,
    netmind: parseNetmindPricing
}

export interface PricingIndexEntry {
    key: string
    pricing: LiteLlmModelPricing
    official: boolean
}

export interface PricingIndex {
    byKey: Map<string, PricingIndexEntry>
}

const isOfficialKey = (key: string): boolean => {
    if (REGIONAL_KEY.test(key)) return false
    if (!key.includes('/')) return true
    return OFFICIAL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
}

// Rows carrying only a cache rate are dropped: `costFromPrice` cannot bill from
// them, so leaving them in the index would let one shadow a row that actually
// prices the model.
export const buildPricingIndex = (
    prices: Map<string, LiteLlmModelPricing>
): PricingIndex => {
    const byKey = new Map<string, PricingIndexEntry>()
    for (const [key, pricing] of prices) {
        if (!hasBasePrice(pricing)) continue
        byKey.set(normalizeModel(key), {
            key,
            pricing,
            official: isOfficialKey(normalizeModel(key))
        })
    }
    return { byKey }
}

// Ordered most-specific first: the exact pass returns on the first hit, so the id
// as written always beats its alias, and both beat the tier-stripped base.
const candidatesFor = (model: string): string[] => {
    const normalized = normalizeModel(model)
    const seeds = [normalized]
    const alias = MODEL_ALIASES[normalized]
    if (alias) seeds.push(normalizeModel(alias))
    const base = stripReasoningTier(normalized)
    if (base) {
        seeds.push(base)
        const baseAlias = MODEL_ALIASES[base]
        if (baseAlias) seeds.push(normalizeModel(baseAlias))
    }
    const out: string[] = [...seeds]
    for (const seed of seeds)
        for (const prefix of PROVIDER_PREFIXES)
            out.push(normalizeModel(`${prefix}${seed}`))
    return Array.from(new Set(out))
}

const prefixRank = (key: string): number => {
    if (!key.includes('/')) return 0
    const found = OFFICIAL_KEY_PREFIXES.findIndex((prefix) =>
        key.startsWith(prefix)
    )
    return found === -1 ? OFFICIAL_KEY_PREFIXES.length + 1 : found + 1
}

export interface ModelPriceMatch {
    key: string
    pricing: LiteLlmModelPricing
    exact: boolean
}

interface FuzzyCandidate extends ModelPriceMatch {
    matched: number
    // 0 = the model id extends a base price row, 1 = the key extends the model id.
    direction: number
    prefix: number
}

// Ordered, deterministic replacement for "longest substring wins, ties broken by
// whatever order the upstream JSON happened to be in". Insertion order used to
// decide which reseller priced a model, so the answer changed whenever LiteLLM
// reordered its file.
//
// Namespace outranks match length, and deliberately so: a candidate is compared
// against provider-prefixed spellings of the id too, which makes a match on
// `vertex_ai/<id>` look longer than the same match on the bare `<id>` purely
// because the prefix is counted. Length only decides between keys of equal
// standing.
const better = (a: FuzzyCandidate, b: FuzzyCandidate): boolean => {
    if (a.prefix !== b.prefix) return a.prefix < b.prefix
    if (a.matched !== b.matched) return a.matched > b.matched
    if (a.direction !== b.direction) return a.direction < b.direction
    if (a.key.length !== b.key.length) return a.key.length < b.key.length
    return a.key < b.key
}

export const matchModelPricing = (
    index: PricingIndex,
    model: string | null
): ModelPriceMatch | null => {
    if (!model) return null
    const candidates = candidatesFor(model)

    for (const candidate of candidates) {
        const hit = index.byKey.get(candidate)
        if (hit) return { key: hit.key, pricing: hit.pricing, exact: true }
    }

    let best: FuzzyCandidate | null = null
    for (const [lowerKey, entry] of index.byKey) {
        if (!entry.official) continue
        for (const candidate of candidates) {
            const forward = boundaryMatch(candidate, lowerKey)
            const relation =
                forward && isVariantTrailing(forward.trailing)
                    ? { matched: lowerKey.length, direction: 0 }
                    : null
            const reverse = relation ? null : boundaryMatch(lowerKey, candidate)
            const resolved =
                relation ??
                (reverse && isVariantTrailing(reverse.trailing)
                    ? { matched: candidate.length, direction: 1 }
                    : null)
            if (!resolved) continue
            const next: FuzzyCandidate = {
                key: entry.key,
                pricing: entry.pricing,
                exact: false,
                matched: resolved.matched,
                direction: resolved.direction,
                prefix: prefixRank(lowerKey)
            }
            if (!best || better(next, best)) best = next
        }
    }

    return best ? { key: best.key, pricing: best.pricing, exact: false } : null
}

export const costFromPrice = (
    price: LiteLlmModelPricing | null,
    usage: UsagePricingInput
): ComputedCost => {
    if (!price) return { costUsd: null, costSource: 'unknown' }

    const inputPrice = price.input_cost_per_token
    const outputPrice = price.output_cost_per_token
    if (inputPrice === undefined && outputPrice === undefined)
        return { costUsd: null, costSource: 'unknown' }

    const cacheReadPrice = price.cache_read_input_token_cost ?? inputPrice ?? 0
    const cacheCreationPrice =
        price.cache_creation_input_token_cost ?? inputPrice ?? 0
    const inputTokens =
        usage.inputTokensIncludeCache === false
            ? usage.inputTokens
            : Math.max(
                  usage.inputTokens -
                      usage.cacheReadTokens -
                      usage.cacheCreationTokens,
                  0
              )
    const total =
        inputTokens * (inputPrice ?? 0) +
        usage.outputTokens * (outputPrice ?? 0) +
        usage.cacheReadTokens * cacheReadPrice +
        usage.cacheCreationTokens * cacheCreationPrice

    return { costUsd: Number(total.toFixed(6)), costSource: 'table' }
}

export interface ResolvedModelPricing {
    pricing: LiteLlmModelPricing
    source: 'override' | ModelPriceSource
    // The record the price came from, so admin can show and link the association.
    // null for an override, which is a number an operator typed rather than a
    // row in someone else's table.
    key: string | null
    pinned: boolean
    // Which configuration level answered. Orthogonal to `source`: a provider-
    // scope pin reads scope 'provider' with source 'models_dev'.
    scope: ModelPriceScope
}

export interface ModelPriceSourceStatus {
    source: ModelPriceSource
    entryCount: number
    fetchedAt: string | null
}

interface SourceState {
    // Kept alongside the index so a snapshot write can serialize exactly what was
    // loaded, without reconstructing it from the index.
    prices: Map<string, LiteLlmModelPricing>
    index: PricingIndex
    etag: string | null
    fetchedAt: number | null
    // A DB read has been attempted, so an empty index means "genuinely empty"
    // rather than "not looked at yet".
    seeded: boolean
    inFlight: Promise<void> | null
    settled: Promise<void> | null
}

const emptySource = (): SourceState => ({
    prices: new Map(),
    index: buildPricingIndex(new Map()),
    etag: null,
    fetchedAt: null,
    seeded: false,
    inFlight: null,
    settled: null
})

export class UsagePricingEngine {
    private readonly logger = new Logger(UsagePricingEngine.name)
    private readonly sources: Record<ModelPriceSource, SourceState> = {
        litellm: emptySource(),
        models_dev: emptySource(),
        netmind: emptySource()
    }
    private config: ModelPriceConfigIndex = {
        overrides: new Map(),
        pins: new Map(),
        scopes: new Map()
    }
    private overrideRefreshPromise: Promise<void> | null = null
    private lastOverrideRefreshAttempt = 0
    private readonly fetchers: Record<ModelPriceSource, PricingFetcher>
    private readonly ttlMs: number
    private readonly loadPriceConfig:
        | (() => Promise<ModelPriceConfigIndex>)
        | null
    private readonly overrideTtlMs: number
    private readonly loadSnapshot:
        | ((
              source: ModelPriceSource
          ) => Promise<ModelPriceSnapshotPayload | null>)
        | null
    private readonly saveSnapshot:
        | ((
              source: ModelPriceSource,
              payload: ModelPriceSnapshotPayload
          ) => Promise<void>)
        | null

    constructor(options: UsagePricingOptions = {}) {
        this.fetchers = {
            litellm: options.fetchPricing ?? fetchLiteLlmPricing,
            models_dev: options.fetchModelsDev ?? fetchModelsDevPricing,
            netmind: options.fetchNetmind ?? fetchNetmindPricing
        }
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
        this.loadPriceConfig = options.loadPriceConfig ?? null
        this.overrideTtlMs = options.overrideTtlMs ?? DEFAULT_OVERRIDE_TTL_MS
        this.loadSnapshot = options.loadSnapshot ?? null
        this.saveSnapshot = options.saveSnapshot ?? null
    }

    computeCost(usage: UsagePricingInput): ComputedCost {
        const resolved = this.resolvePricing(usage.model, usage)
        return costFromPrice(resolved?.pricing ?? null, usage)
    }

    // Whether a model would record a real cost. Drives the catalog's
    // "only auto-enable a priced model" gate, so an unpriced model can never
    // start serving turns that silently bill nothing.
    hasPricing(model: string | null): boolean {
        return this.resolvePricing(model) !== null
    }

    // Most specific configured scope wins: the provider row that served the
    // turn, then its built-in provider's default, then the managed catalog's
    // global layer, then the ranked table match. A scope that has an entry for
    // the model OWNS it — a broken pin there reads as unpriced rather than
    // sliding down to a scope whose number the pinner deliberately replaced.
    resolvePricing(
        model: string | null,
        scope?: ModelPriceScopeContext
    ): ResolvedModelPricing | null {
        this.refreshSourcesIfNeeded()
        this.refreshConfigIfNeeded()
        if (!model) return null
        const normalized = normalizeModel(model)

        const scopeKeys: Array<{ key: string; scope: ModelPriceScope }> = []
        if (scope?.modelProviderId)
            scopeKeys.push({
                key: `row:${scope.modelProviderId}`,
                scope: 'provider'
            })
        if (scope?.modelProviderBuiltInId)
            scopeKeys.push({
                key: `builtin:${scope.modelProviderBuiltInId}`,
                scope: 'built_in'
            })
        for (const candidate of scopeKeys) {
            const entry = this.config.scopes.get(candidate.key)?.get(normalized)
            if (!entry) continue
            if (entry.override)
                return {
                    pricing: entry.override,
                    source: 'override',
                    key: null,
                    pinned: false,
                    scope: candidate.scope
                }
            return entry.pin
                ? this.resolvePin(entry.pin, candidate.scope)
                : null
        }

        const override = this.config.overrides.get(normalized)
        if (override)
            return {
                pricing: override,
                source: 'override',
                key: null,
                pinned: false,
                scope: 'global'
            }

        const pin = this.config.pins.get(normalized)
        if (pin) return this.resolvePin(pin, 'global')

        return this.autoResolve(model, scope?.modelProviderBuiltInId ?? null)
    }

    // Whether a table really carries this record, looked up exactly the way
    // resolvePin will look it up — so a pin that validates is a pin that
    // resolves. Every pin validator wants this rather than a candidate list: a
    // candidate list is ranked and budget-capped for a picker, so probing it for
    // existence can miss a real key, and it deliberately hides tables that
    // belong to another channel.
    hasPriceRecord(source: ModelPriceSource, key: string): boolean {
        return this.sources[source].index.byKey.has(normalizeModel(key))
    }

    // Exact only. A pin whose key stopped existing upstream must read as
    // unpriced, not quietly slide onto whatever the matcher finds next.
    private resolvePin(
        pin: ModelPriceRef,
        scope: ModelPriceScope
    ): ResolvedModelPricing | null {
        const hit = this.sources[pin.source].index.byKey.get(
            normalizeModel(pin.key)
        )
        if (!hit) return null
        return {
            pricing: hit.pricing,
            source: pin.source,
            key: hit.key,
            pinned: true,
            scope
        }
    }

    // A channel that publishes its own rates is priced from THAT table and
    // nothing else, in both directions: the public tables describe what the model
    // maker charges, which is not what a gateway resells it for, and the
    // gateway's markup must never leak onto a channel that did not serve the
    // turn. EXACT only, for the reason the configured layers are exact — the
    // table IS this channel's model list, so exact is complete, and a fuzzy
    // neighbour would silently meter one model at another's price. A model the
    // channel does not price reads unpriced, where the admin price surface shows
    // it in red and an override or pin fixes it.
    private autoResolve(
        model: string,
        builtInId: string | null
    ): ResolvedModelPricing | null {
        const channel = builtInId ? lookupBuiltIn(builtInId)?.priceSource : null
        if (channel) {
            const hit = matchModelPricing(this.sources[channel].index, model)
            return hit?.exact ? this.toResolved(channel, hit) : null
        }
        return this.autoResolveGlobal(model)
    }

    // Quality-major rather than source-major: an EXACT models.dev record beats a
    // fuzzy LiteLLM guess. `gemini-3.1-flash-lite-image` is the case that forces
    // it — LiteLLM has no such key and would stretch the text-model
    // `gemini-3.1-flash-lite` over an image model, while models.dev prices the id
    // outright. When LiteLLM does know the model it still wins.
    private autoResolveGlobal(model: string): ResolvedModelPricing | null {
        const litellm = matchModelPricing(this.sources.litellm.index, model)
        if (litellm?.exact) return this.toResolved('litellm', litellm)
        const modelsDev = matchModelPricing(
            this.sources.models_dev.index,
            model
        )
        if (modelsDev?.exact) return this.toResolved('models_dev', modelsDev)
        if (litellm) return this.toResolved('litellm', litellm)
        if (modelsDev) return this.toResolved('models_dev', modelsDev)
        return null
    }

    private toResolved(
        source: ModelPriceSource,
        match: ModelPriceMatch
    ): ResolvedModelPricing {
        return {
            pricing: match.pricing,
            source,
            key: match.key,
            pinned: false,
            scope: 'auto'
        }
    }

    // Ranked candidates for one model id, for the price association UI.
    //
    // What this scope PROPOSES is scoped the way resolution is scoped: a channel
    // that publishes its own rates is offered its own record, and no other
    // channel is ever offered that channel's markup — a gateway's resale price
    // is the wrong number everywhere else, so it must not be sitting in the
    // picker next to the right one. An explicit `query` is the exception: a typed
    // search is operator intent, reaches every table, and is how a deliberate
    // cross-table pin gets found.
    priceCandidates(
        model: string,
        query?: string,
        builtInId?: string | null
    ): Array<{
        source: ModelPriceSource
        key: string
        pricing: LiteLlmModelPricing
        official: boolean
        matchKind: 'exact' | 'fuzzy' | 'search'
    }> {
        const out: Array<{
            source: ModelPriceSource
            key: string
            pricing: LiteLlmModelPricing
            official: boolean
            matchKind: 'exact' | 'fuzzy' | 'search'
        }> = []
        const seen = new Set<string>()
        const push = (
            source: ModelPriceSource,
            entry: PricingIndexEntry,
            matchKind: 'exact' | 'fuzzy' | 'search'
        ): void => {
            const dedupe = `${source}:${entry.key}`
            if (seen.has(dedupe)) return
            seen.add(dedupe)
            out.push({
                source,
                key: entry.key,
                pricing: entry.pricing,
                official: entry.official,
                matchKind
            })
        }

        const channel = builtInId ? lookupBuiltIn(builtInId)?.priceSource : null
        const proposed = channel ? [channel] : GLOBAL_MODEL_PRICE_SOURCES
        for (const source of proposed) {
            const index = this.sources[source].index
            const match = matchModelPricing(index, model)
            if (match) {
                const entry = index.byKey.get(normalizeModel(match.key))
                if (entry) push(source, entry, match.exact ? 'exact' : 'fuzzy')
            }
        }

        // Each source gets its own budget: LiteLLM has ~25x more keys than the
        // models.dev snapshot, so a shared cap filled in source order would
        // exhaust itself on LiteLLM alone and models.dev could never appear in
        // a search. Ranked before taking the budget — insertion order is just
        // whatever the upstream JSON listed first, which put arbitrary
        // resellers ahead of official records.
        const needle = normalizeModel(query ?? model)
        if (needle.length > 0) {
            for (const source of query ? MODEL_PRICE_SOURCES : proposed) {
                const matches: PricingIndexEntry[] = []
                for (const [lowerKey, entry] of this.sources[source].index
                    .byKey) {
                    if (lowerKey.includes(needle)) matches.push(entry)
                }
                matches.sort(
                    (a, b) =>
                        Number(b.official) - Number(a.official) ||
                        a.key.length - b.key.length ||
                        a.key.localeCompare(b.key)
                )
                for (const entry of matches.slice(0, 25))
                    push(source, entry, 'search')
            }
        }

        return out.slice(0, 50)
    }

    sourceStatuses(): ModelPriceSourceStatus[] {
        return MODEL_PRICE_SOURCES.map((source) => {
            const { index, fetchedAt } = this.sources[source]
            return {
                source,
                entryCount: index.byKey.size,
                fetchedAt:
                    fetchedAt === null
                        ? null
                        : new Date(fetchedAt).toISOString()
            }
        })
    }

    // Resolves once every source has settled one load attempt, success or
    // failure. Callers that must not report "no price" against a cold engine —
    // the admin catalog list and the auto-enable gate — await this; the metering
    // path never does, so a slow origin cannot stall a turn.
    async ensureLoaded(): Promise<void> {
        this.refreshSourcesIfNeeded()
        await Promise.all(
            MODEL_PRICE_SOURCES.map((source) => this.sources[source].settled)
        )
    }

    // Reload the configured prices now instead of waiting out the TTL. Called
    // right after someone edits a price so the response they get back — and the
    // "no price" badge — already reflects the edit.
    async refreshOverridesNow(): Promise<void> {
        if (!this.loadPriceConfig) return
        await this.overrideRefreshPromise
        this.lastOverrideRefreshAttempt = 0
        this.refreshConfigIfNeeded()
        await this.overrideRefreshPromise
    }

    private refreshConfigIfNeeded(): void {
        const load = this.loadPriceConfig
        if (!load) return
        const now = Date.now()
        if (this.overrideRefreshPromise) return
        if (now - this.lastOverrideRefreshAttempt < this.overrideTtlMs) return
        this.lastOverrideRefreshAttempt = now
        this.overrideRefreshPromise = load()
            .then((next) => {
                this.config = next
            })
            .catch((err) => {
                this.logger.warn(
                    `model price config refresh failed; keeping current config: ${(err as Error).message}`
                )
            })
            .finally(() => {
                this.overrideRefreshPromise = null
            })
    }

    private refreshSourcesIfNeeded(): void {
        for (const source of MODEL_PRICE_SOURCES) this.refreshSource(source)
    }

    private refreshSource(source: ModelPriceSource): void {
        const state = this.sources[source]
        if (state.inFlight) return
        if (
            state.seeded &&
            state.fetchedAt !== null &&
            Date.now() - state.fetchedAt < this.ttlMs
        )
            return
        const run = this.loadSource(source)
            .catch((err) => {
                this.logger.warn(
                    `${source} pricing load failed; keeping current table: ${(err as Error).message}`
                )
            })
            .finally(() => {
                state.inFlight = null
            })
        state.inFlight = run
        // The first attempt is what ensureLoaded waits on; later refreshes must
        // not re-arm it, or a caller could block on a periodic reload.
        state.settled ??= run
    }

    private async loadSource(source: ModelPriceSource): Promise<void> {
        const state = this.sources[source]
        if (!state.seeded) {
            state.seeded = true
            if (this.loadSnapshot) {
                const stored = await this.loadSnapshot(source)
                if (stored) {
                    this.applyPrices(
                        source,
                        new Map(Object.entries(stored.prices))
                    )
                    const { current, etag } = unwrapSnapshotEtag(
                        source,
                        stored.etag
                    )
                    // A row from an older parser keeps serving what it has,
                    // but leaves etag and fetchedAt unset so the fetch below
                    // runs now and pulls the full body.
                    if (current) {
                        state.etag = etag
                        state.fetchedAt = stored.fetchedAt.getTime()
                    }
                }
            }
            if (
                state.fetchedAt !== null &&
                Date.now() - state.fetchedAt < this.ttlMs
            )
                return
        }

        const result = await this.fetchers[source](state.etag)
        const now = new Date()
        if (!result.raw) {
            state.etag = result.etag ?? state.etag
            state.fetchedAt = now.getTime()
            await this.persist(source, now)
            return
        }
        const parsed = SOURCE_PARSERS[source](result.raw)
        if (parsed.size === 0) {
            this.logger.warn(
                `${source} pricing refresh returned no usable rows; keeping current table`
            )
            return
        }
        this.applyPrices(source, parsed)
        state.etag = result.etag
        state.fetchedAt = now.getTime()
        await this.persist(source, now)
    }

    private applyPrices(
        source: ModelPriceSource,
        prices: Map<string, LiteLlmModelPricing>
    ): void {
        this.sources[source].index = buildPricingIndex(prices)
        this.sources[source].prices = prices
    }

    private async persist(
        source: ModelPriceSource,
        fetchedAt: Date
    ): Promise<void> {
        const save = this.saveSnapshot
        const prices = this.sources[source].prices
        if (!save || prices.size === 0) return
        try {
            await save(source, {
                prices: Object.fromEntries(prices),
                etag: wrapSnapshotEtag(source, this.sources[source].etag),
                fetchedAt
            })
        } catch (err) {
            this.logger.warn(
                `${source} pricing snapshot write failed; the table is live in memory only: ${(err as Error).message}`
            )
        }
    }
}

@Injectable()
export class UsagePricingService
    extends UsagePricingEngine
    implements OnModuleInit
{
    constructor(
        @Inject(DRIZZLE) db: Database,
        snapshots: ModelPriceSnapshotRepository,
        // Appended last + @Optional so positional test construction keeps
        // working; absence means no managed price rows (BYO/scoped only). The
        // closure below captures the parameter, not `this` — field access is
        // illegal in arguments to super().
        @Optional()
        @Inject(MANAGED_PRICING_PORT)
        managedPricing: ManagedPricingPort = noManagedPricingPort
    ) {
        super({
            loadPriceConfig: async () => {
                const [rows, scopedRows] = await Promise.all([
                    managedPricing.loadManagedPriceRows(db),
                    db
                        .select({
                            builtInId: scopedModelPrices.builtInId,
                            providerId: scopedModelPrices.providerId,
                            modelId: scopedModelPrices.modelId,
                            inputCostPerToken:
                                scopedModelPrices.inputCostPerToken,
                            outputCostPerToken:
                                scopedModelPrices.outputCostPerToken,
                            cacheReadCostPerToken:
                                scopedModelPrices.cacheReadCostPerToken,
                            cacheCreationCostPerToken:
                                scopedModelPrices.cacheCreationCostPerToken,
                            priceRefSource: scopedModelPrices.priceRefSource,
                            priceRefKey: scopedModelPrices.priceRefKey
                        })
                        .from(scopedModelPrices)
                        .where(
                            or(
                                isNotNull(scopedModelPrices.inputCostPerToken),
                                isNotNull(scopedModelPrices.outputCostPerToken),
                                isNotNull(scopedModelPrices.priceRefSource)
                            )
                        )
                        .catch((err: unknown) => {
                            // 42P01 = the 0149 migration has not run here yet;
                            // scoped prices simply do not exist, which must not
                            // take global pricing down with it.
                            if ((err as { code?: string }).code === '42P01')
                                return []
                            throw err
                        })
                ])
                return {
                    overrides: overridePricingFromRows(rows),
                    pins: pinsFromRows(rows),
                    scopes: scopedPricesFromRows(scopedRows)
                }
            },
            loadSnapshot: (source) => snapshots.read(source),
            saveSnapshot: (source, payload) => snapshots.upsert(source, payload)
        })
    }

    // Kicked off, never awaited: boot must not depend on three third-party
    // origins being reachable. Until a source lands, affected models record
    // `costSource: 'unknown'`, which is the same thing an unknown model has
    // always recorded.
    onModuleInit(): void {
        void this.ensureLoaded()
    }
}

const fetchJson = async (
    url: string,
    etag: string | null,
    init: RequestInit = {}
): Promise<PricingFetch> => {
    const res = await fetch(url, {
        ...init,
        headers: {
            ...init.headers,
            ...(etag ? { 'if-none-match': etag } : {})
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (res.status === 304) return { raw: null, etag }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const body = (await res.json()) as unknown
    if (!isRecord(body)) throw new Error(`${url} body is not an object`)
    return { raw: body, etag: res.headers.get('etag') }
}

const fetchLiteLlmPricing = (etag: string | null): Promise<PricingFetch> =>
    fetchJson(LITELLM_PRICING_URL, etag)

const fetchModelsDevPricing = (etag: string | null): Promise<PricingFetch> =>
    fetchJson(MODELS_DEV_PRICING_URL, etag)

// An endpoint that sends no etag and no cache-control, so the stored etag is
// deliberately not offered: an If-None-Match against an origin that never
// validates would be dead weight, and echoing one back would let a 304 branch
// pin an empty table. Measured on prod [2026-09-01]: each refresh transfers the
// whole body (~95KB, once a day).
const fetchNetmindPricing = (): Promise<PricingFetch> =>
    fetchJson(NETMIND_PRICING_URL, null)
