// The pricing tables a model can be priced from.
export type ModelPriceSource = 'litellm' | 'models_dev' | 'netmind'

export const MODEL_PRICE_SOURCES: readonly ModelPriceSource[] = [
    'litellm',
    'models_dev',
    'netmind'
]

// The tables that may price ANY channel. A channel-owned table (netmind) is
// deliberately absent: it publishes a reseller's rates, so letting the automatic
// matcher reach it would silently reprice a turn that never went through that
// gateway. `BuiltInProviderEntry.priceSource` names the channel that owns one.
export const GLOBAL_MODEL_PRICE_SOURCES: readonly ModelPriceSource[] = [
    'litellm',
    'models_dev'
]

// Which configuration level a resolved price came from. 'provider' = the user's
// own row, 'built_in' = an admin default for that built-in provider, 'global' =
// the managed catalog's platform-wide override/pin, 'auto' = the ranked table
// match found it with no configuration at all.
export type ModelPriceScope = 'provider' | 'built_in' | 'global' | 'auto'

// One entry of a pricing table, in LiteLLM's per-token field names. Both tables
// are normalized to this shape on the way in (models.dev publishes per-million
// costs and is divided down), so the matcher, pins and candidate lists read one
// map type.
export interface ModelPriceTableEntry {
    input_cost_per_token?: number
    output_cost_per_token?: number
    cache_creation_input_token_cost?: number
    cache_read_input_token_cost?: number
}

// Per-token prices as views and edit bodies carry them. null on a field means
// "not set here"; whatever is behind it in the resolution order fills the gap.
export interface ModelPriceAmounts {
    inputCostPerToken: number | null
    outputCostPerToken: number | null
    cacheReadCostPerToken: number | null
    cacheCreationCostPerToken: number | null
}

// 'override' = someone typed the price, a source name = resolved from that
// table, 'missing' = nothing resolves, so turns against it would record tokens
// with no cost at all.
export type ModelPriceStatus = 'override' | ModelPriceSource | 'missing'

// The record the price was read from, so a UI can show the association and link
// out to it. `pinned` distinguishes a deliberate choice from whatever the
// automatic matcher found.
export interface ModelPriceRefView {
    source: ModelPriceSource
    key: string
    pinned: boolean
    url: string
}

// One row of the association picker: a record in a public table that could price
// this model. 'exact' = the id is a key verbatim, 'fuzzy' = the ranked boundary
// match, 'search' = only surfaced because the operator searched for it.
export interface ModelPriceCandidate {
    source: ModelPriceSource
    key: string
    official: boolean
    matchKind: 'exact' | 'fuzzy' | 'search'
    prices: ModelPriceAmounts
    url: string
}

export interface ModelPriceSourceStatusView {
    source: ModelPriceSource
    entryCount: number
    fetchedAt: string | null
}

export interface ModelPriceSourcesView {
    modelId: string
    // The association in force right now, echoed so the picker can mark it.
    priceRef: ModelPriceRefView | null
    candidates: ModelPriceCandidate[]
    sources: ModelPriceSourceStatusView[]
}

// One model's price as a scope surface shows it: what is configured AT this
// scope (`prices`, all-null when nothing is), what metering would actually
// charge and where that number comes from. `scope` is which configuration
// level answered — orthogonal to priceStatus, which says whose table.
export interface ModelPriceEntryView {
    modelId: string
    prices: ModelPriceAmounts
    resolvedPrice: ModelPriceAmounts | null
    priceStatus: ModelPriceStatus
    scope: ModelPriceScope | null
    priceRef: ModelPriceRefView | null
    // THIS scope's configured pin, verbatim from the row. Distinct from
    // priceRef, which reports whatever resolution used — possibly a lower
    // scope's pin. Upserts are full-replace, so an editor must send this back
    // or saving a price would silently clear the pin.
    pin: { source: ModelPriceSource; key: string } | null
    editable: boolean
}

export interface BuiltInModelPriceEntryView extends ModelPriceEntryView {
    // How many of the users' provider rows currently list this model. 0 = an
    // admin added it by hand before anyone probed it.
    observedCount: number
}

export interface BuiltInModelPricesProviderView {
    builtInId: string
    label: string
    // Rows users have configured for this built-in provider.
    providerRowCount: number
    unpricedCount: number
    models: BuiltInModelPriceEntryView[]
}

export interface BuiltInModelPricesView {
    providers: BuiltInModelPricesProviderView[]
    sources: ModelPriceSourceStatusView[]
}

// PUT is full-replace for the (scope, model) row: an omitted or null price
// field clears it, and the pin is set only when both ref fields are present.
// A body configuring nothing at all is the admin "manual add" — the model id
// becomes visible without being priced.
export interface UpsertBuiltInModelPriceBody {
    builtInId: string
    modelId: string
    inputCostPerToken?: number | null
    outputCostPerToken?: number | null
    cacheReadCostPerToken?: number | null
    cacheCreationCostPerToken?: number | null
    priceRefSource?: ModelPriceSource | null
    priceRefKey?: string | null
}

export interface ProviderModelPricesView {
    providerId: string
    // false on a managed row: those prices are the platform's, shown for
    // transparency and rejected on write.
    editable: boolean
    models: ModelPriceEntryView[]
    sources: ModelPriceSourceStatusView[]
}

export interface UpsertProviderModelPriceBody {
    modelId: string
    inputCostPerToken?: number | null
    outputCostPerToken?: number | null
    cacheReadCostPerToken?: number | null
    cacheCreationCostPerToken?: number | null
    priceRefSource?: ModelPriceSource | null
    priceRefKey?: string | null
}

// LiteLLM has no per-model page — its own browser (models.litellm.ai) reads
// nothing from the URL — so link the file the engine actually fetches. models.dev
// does have one, keyed by the lab that publishes the model, which is the prefix
// its snapshot keys already carry.
const LITELLM_SOURCE_URL =
    'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json'

// NetMind's rates come from a POST endpoint, which a browser cannot open, and
// its models have no per-model price page. Link the published price list.
const NETMIND_SOURCE_URL = 'https://www.netmind.ai/pricing'

// The labs models.dev renders /models/<lab>/<id> pages for. Every other first
// segment is a provider, whose records only have a /providers/<id> page — the
// /models form for those bounces to the homepage.
const MODELS_DEV_LABS = new Set(['anthropic', 'openai', 'google'])

export const modelPriceSourceUrl = (
    source: ModelPriceSource,
    key: string
): string => {
    if (source === 'litellm') return LITELLM_SOURCE_URL
    if (source === 'netmind') return NETMIND_SOURCE_URL
    const slash = key.indexOf('/')
    if (slash === -1) return `https://models.dev/models/${key}/`
    const first = key.slice(0, slash)
    if (MODELS_DEV_LABS.has(first))
        return `https://models.dev/models/${first}/${key.slice(slash + 1)}/`
    return `https://models.dev/providers/${first}/`
}

export const modelPriceAmountsFrom = (
    entry: ModelPriceTableEntry
): ModelPriceAmounts => ({
    inputCostPerToken: entry.input_cost_per_token ?? null,
    outputCostPerToken: entry.output_cost_per_token ?? null,
    cacheReadCostPerToken: entry.cache_read_input_token_cost ?? null,
    cacheCreationCostPerToken: entry.cache_creation_input_token_cost ?? null
})
