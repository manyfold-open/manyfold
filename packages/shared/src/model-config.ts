import { OFFICIAL_PROVIDER_BASE_URL, type AgentFramework } from './constants'
import type {
    InferenceProtocol,
    ProtocolModelMap,
    UserModelProvider
} from './dtos'
import type {
    RuntimeLocalCredentialReason,
    RuntimeLocalCredentialStatus
} from './runtime-local-credentials'

export const agentModelConfigSources = ['platform', 'runtime-local'] as const
export type AgentModelConfigSource = (typeof agentModelConfigSources)[number]

export const agentRuntimeLocalModelConfigSources = [
    'daemon-local',
    'sprites-local',
    'k8s-local'
] as const
export type AgentRuntimeLocalModelConfigSource =
    (typeof agentRuntimeLocalModelConfigSources)[number]

export const claudeCodeModelMapAliases = [
    'fable',
    'opus',
    'sonnet',
    'haiku'
] as const
export type ClaudeCodeModelMapAlias = (typeof claudeCodeModelMapAliases)[number]

export const claudeCodeOneMillionModelAliases = [
    'opus[1m]',
    'sonnet[1m]'
] as const

export const claudeCodeModelAliases = [
    'fable',
    'opus',
    'opus[1m]',
    'sonnet',
    'sonnet[1m]',
    'haiku'
] as const
export type ClaudeCodeModelAlias = (typeof claudeCodeModelAliases)[number]

// Known Claude provider model ids surfaced by runtime-local inspect (API
// sprite/k8s inspect script and CLI daemon inspect both consume this list).
// Fable 5 / Opus 4.8 / Sonnet 5 are native 1M so they have no -1m variant.
export const claudeLocalModelCatalog = [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-7-1m',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-sonnet-4-6-1m',
    'claude-sonnet-4-5',
    'claude-haiku-4-5'
] as const

export const claudeCodeEfforts = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
] as const
export type ClaudeCodeEffort = (typeof claudeCodeEfforts)[number]
export const claudeCodeDefaultEffort: ClaudeCodeEffort = 'medium'

const claudeCodeStandardEfforts = [
    'low',
    'medium',
    'high'
] as const satisfies readonly ClaudeCodeEffort[]
const claudeCodeMaxEfforts = [
    'low',
    'medium',
    'high',
    'max'
] as const satisfies readonly ClaudeCodeEffort[]
const claudeCodeFullEfforts = [
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
] as const satisfies readonly ClaudeCodeEffort[]

// Ordered by default preference: the first provider-available model wins
// (GPT-5.6 Sol → Terra → Luna → GPT-5.5 → …). gpt-5.3-codex-spark is a
// ChatGPT Pro research preview (supported_in_api=false upstream) and stays
// out of this list until the product decision to expose it; its catalog row
// is seeded inactive.
export const codexModels = [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.2'
] as const
export type CodexSupportedModel = (typeof codexModels)[number]

export const codexSpeeds = ['standard', 'fast'] as const
export type CodexSpeed = (typeof codexSpeeds)[number]

// `none` was removed: no current model supports it and the official
// model_reasoning_effort enum never had it. max/ultra exist upstream on the
// GPT-5.6 family but stay unexposed pending a product decision (ultra
// auto-delegates work to subagents).
export const codexIntelligenceLevels = [
    'low',
    'medium',
    'high',
    'xhigh'
] as const
export type CodexIntelligence = (typeof codexIntelligenceLevels)[number]

export const codexDefaultModel: CodexSupportedModel = 'gpt-5.5'
export const codexDefaultSpeed: CodexSpeed = 'standard'
export const codexDefaultIntelligence: CodexIntelligence = 'medium'

interface CodexModelSpec {
    intelligence: readonly CodexIntelligence[]
    defaultIntelligence: CodexIntelligence
    fast: boolean
    deprecated?: boolean
}

// Capability metadata per canonical model (codex debug models @ 0.144.1).
const codexModelSpecs: Record<CodexSupportedModel, CodexModelSpec> = {
    'gpt-5.6-sol': {
        intelligence: codexIntelligenceLevels,
        defaultIntelligence: 'medium',
        fast: true
    },
    'gpt-5.6-terra': {
        intelligence: codexIntelligenceLevels,
        defaultIntelligence: 'medium',
        fast: true
    },
    'gpt-5.6-luna': {
        intelligence: codexIntelligenceLevels,
        defaultIntelligence: 'medium',
        fast: true
    },
    'gpt-5.5': {
        intelligence: codexIntelligenceLevels,
        defaultIntelligence: 'medium',
        fast: true
    },
    'gpt-5.4': {
        intelligence: codexIntelligenceLevels,
        defaultIntelligence: 'medium',
        fast: true
    },
    'gpt-5.4-mini': {
        intelligence: codexIntelligenceLevels,
        defaultIntelligence: 'medium',
        fast: false
    },
    'gpt-5.3-codex': {
        intelligence: codexIntelligenceLevels,
        defaultIntelligence: 'medium',
        fast: false,
        deprecated: true
    },
    'gpt-5.2': {
        intelligence: codexIntelligenceLevels,
        defaultIntelligence: 'medium',
        fast: false,
        deprecated: true
    }
}

const codexModelSpecFor = (
    model: string | null | undefined
): CodexModelSpec | null => {
    const trimmed = model?.trim()
    if (!trimmed) return null
    return (
        codexModelSpecs[
            codexCanonicalModelId(trimmed) as CodexSupportedModel
        ] ?? null
    )
}

export const codexIntelligenceLevelsForModel = (
    model: string | null | undefined
): readonly CodexIntelligence[] =>
    codexModelSpecFor(model)?.intelligence ?? codexIntelligenceLevels

export const codexDefaultIntelligenceForModel = (
    model: string | null | undefined
): CodexIntelligence =>
    codexModelSpecFor(model)?.defaultIntelligence ?? codexDefaultIntelligence

export interface ClaudeCodeModelMap {
    fable?: string
    opus?: string
    sonnet?: string
    haiku?: string
}

export interface ClaudeCodeAgentModelConfig {
    framework: 'claude-code'
    model?: string | null
    effort?: ClaudeCodeEffort | null
    modelMap?: ClaudeCodeModelMap
}

export interface CodexAgentModelConfig {
    framework: 'codex'
    model?: string | null
    speed?: CodexSpeed | null
    intelligence?: CodexIntelligence | null
}

export interface GeminiCliAgentModelConfig {
    framework: 'gemini-cli'
    model?: string | null
}

// Gemini CLI routing alias: with no explicit model the CLI defaults to its
// Auto router, so `auto` is the platform default for new agents and must
// never be passed through as a concrete --model / GEMINI_MODEL value.
export const geminiAutoModelKey = 'auto'

export const isGeminiAutoModel = (
    model: string | null | undefined
): boolean => (model?.trim() ?? '') === geminiAutoModelKey

// Known Gemini provider model ids surfaced by runtime-local inspect when the
// runtime cannot enumerate models itself (mirrors the active DB catalog).
export const geminiLocalModelCatalog = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
] as const

export type AgentModelConfig =
    | ClaudeCodeAgentModelConfig
    | CodexAgentModelConfig
    | GeminiCliAgentModelConfig

export type AgentModelProviderModelsStatus =
    | 'ready'
    | 'needs_refresh'
    | 'unsupported'

export interface AgentModelProviderModelsCache {
    provider: UserModelProvider | null
    baseUrl: string | null
    models: string[]
    testedAt: string
    source: 'saved-provider' | 'agent-refresh' | 'inline-test' | 'daemon-local'
}

export interface AgentRuntimeLocalModelConfigStatus {
    available: boolean
    ready: boolean
    source: AgentRuntimeLocalModelConfigSource | null
    framework: AgentFramework
    cliVersion: string | null
    credentialReady: boolean | null
    credentialStatus: RuntimeLocalCredentialStatus
    credentialReason: RuntimeLocalCredentialReason
    configReadable: boolean | null
    current: string | null
    models: string[]
    aliases: string[]
    speeds: string[]
    intelligence: string[]
    lastCheckedAt: string | null
    error: string | null
}

export interface AgentModelConfigOption {
    value: string
    label: string
    providerModel?: string | null
    canonicalModel?: string | null
    supportsFast?: boolean
    enabled: boolean
    reason?: string | null
}

export interface AgentModelConfigValidation {
    valid: boolean
    messages: string[]
    cta?:
        | 'test-provider'
        | 'configure-claude-mapping'
        | 'choose-codex-model'
        | 'refresh-runtime-local'
}

export interface AgentModelConfigView {
    agentId: string
    framework: AgentFramework
    source: AgentModelConfigSource
    availableSources: AgentModelConfigSource[]
    provider: UserModelProvider | null
    providerBaseUrl: string | null
    providerModelsStatus: AgentModelProviderModelsStatus
    providerModelsSource: AgentModelProviderModelsCache['source'] | null
    providerModels: string[]
    runtimeLocal: AgentRuntimeLocalModelConfigStatus | null
    config: AgentModelConfig | null
    options: AgentModelConfigOption[]
    validation: AgentModelConfigValidation
}

export interface UpdateAgentModelConfigBody {
    modelConfigSource?: AgentModelConfigSource
    model?: string | null
    modelConfig?: AgentModelConfig | null
}

export interface RefreshAgentModelConfigModelsBody {
    source?: AgentModelConfigSource
}

export interface RefreshAgentModelConfigModelsResponse {
    ok: boolean
    message?: string | null
    latencyMs?: number
    models: string[]
    view: AgentModelConfigView
}

export const isClaudeCodeModelAlias = (
    value: unknown
): value is ClaudeCodeModelAlias =>
    typeof value === 'string' &&
    claudeCodeModelAliases.includes(value as ClaudeCodeModelAlias)

export const isAgentModelConfigSource = (
    value: unknown
): value is AgentModelConfigSource =>
    typeof value === 'string' &&
    agentModelConfigSources.includes(value as AgentModelConfigSource)

export const isClaudeCodeOneMillionModelAlias = (
    value: unknown
): value is (typeof claudeCodeOneMillionModelAliases)[number] =>
    typeof value === 'string' &&
    claudeCodeOneMillionModelAliases.includes(
        value as (typeof claudeCodeOneMillionModelAliases)[number]
    )

export const claudeCodeModelAliasMapKey = (
    alias: ClaudeCodeModelAlias
): ClaudeCodeModelMapAlias => {
    if (alias.startsWith('fable')) return 'fable'
    if (alias.startsWith('opus')) return 'opus'
    if (alias.startsWith('sonnet')) return 'sonnet'
    return 'haiku'
}

export const claudeCodeModelSelectionMapKey = (
    model: string
): ClaudeCodeModelMapAlias | null => {
    const trimmed = model.trim()
    if (isClaudeCodeModelAlias(trimmed))
        return claudeCodeModelAliasMapKey(trimmed)
    return (
        claudeCodeModelMapAliases.find((alias) =>
            claudeModelMatchesAlias(trimmed, alias)
        ) ?? null
    )
}

export const isClaudeCodeEffort = (value: unknown): value is ClaudeCodeEffort =>
    typeof value === 'string' &&
    claudeCodeEfforts.includes(value as ClaudeCodeEffort)

export const resolveClaudeCodeProviderModel = (
    model: string | null | undefined,
    modelMap: ClaudeCodeModelMap | undefined
): string | null => {
    const selected = model?.trim()
    if (!selected) return null
    if (!isClaudeCodeModelAlias(selected)) return selected
    const mapped =
        modelMap?.[claudeCodeModelAliasMapKey(selected)]?.trim() ?? ''
    return mapped || null
}

export const claudeCodeEffortsForModel = (
    model: string | null | undefined
): readonly ClaudeCodeEffort[] =>
    claudeCodeEffortProfileForModel(model)?.efforts ?? []

export const claudeCodeDefaultEffortForModel = (
    model: string | null | undefined
): ClaudeCodeEffort | null =>
    claudeCodeEffortProfileForModel(model)?.defaultEffort ?? null

export const normalizeClaudeCodeEffortForModel = (
    effort: ClaudeCodeEffort | null | undefined,
    model: string | null | undefined
): ClaudeCodeEffort | null => {
    const profile = claudeCodeEffortProfileForModel(model)
    if (!profile) return null
    return effort && profile.efforts.includes(effort)
        ? effort
        : profile.defaultEffort
}

export const codexCanonicalModelId = (model: string): string => {
    const trimmed = model.trim().toLowerCase()
    const segments = trimmed.split(/[/:]/).filter(Boolean)
    return segments.at(-1) ?? trimmed
}

// Gemini needs its own canonicalizer, NOT codexCanonicalModelId: codex splits
// on `/` and `:` together and takes the last segment, so a tagged id like
// `gemini-2.5-pro:latest` would collapse to `latest`. Here we strip the
// provider prefix (last `/`-segment: `google/`, `models/`, any `owner/…`) and
// then the `:tag` suffix, leaving the versioned model id intact (hyphens/dots
// are preserved so `gemini-2.5-flash-lite` stays distinct).
export const geminiCanonicalModelId = (model: string): string => {
    const trimmed = model.trim().toLowerCase()
    if (!trimmed) return trimmed
    const withoutPrefix = trimmed.split('/').filter(Boolean).at(-1) ?? trimmed
    const [base] = withoutPrefix.split(':')
    return base || withoutPrefix
}

export const isCodexSupportedModel = (model: string): boolean =>
    codexModels.includes(codexCanonicalModelId(model) as CodexSupportedModel)

export const codexModelSupportsFast = (model: string): boolean =>
    codexModelSpecFor(model)?.fast === true

export const uniqueTrimmedModelIds = (models: readonly string[]): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of models) {
        const id = raw.trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push(id)
    }
    return out
}

export const geminiProviderModelByCanonical = (
    providerModels: readonly string[]
): Map<string, string> => {
    const out = new Map<string, string>()
    for (const id of uniqueTrimmedModelIds(providerModels)) {
        const canonical = geminiCanonicalModelId(id)
        if (canonical && !out.has(canonical)) out.set(canonical, id)
    }
    return out
}

export const resolveGeminiProviderModel = (
    model: string | null | undefined,
    providerModels: readonly string[]
): string | null => {
    const selected = model?.trim()
    if (!selected) return null
    if (isGeminiAutoModel(selected)) return geminiAutoModelKey
    return (
        geminiProviderModelByCanonical(providerModels).get(
            geminiCanonicalModelId(selected)
        ) ?? selected
    )
}

// gemini-cli's own Auto router and internal utility calls target hardcoded
// `gemini-3-*` ids that only Google's official endpoint serves, so anything
// with a different base URL is a "gateway" and needs a concrete model plus
// the settings-level neutralization written by the chat adapter.
export const isGeminiGatewayBaseUrl = (
    baseUrl: string | null | undefined
): boolean => {
    const trimmed = (baseUrl?.trim() ?? '').replace(/\/+$/, '')
    return trimmed.length > 0 && trimmed !== OFFICIAL_PROVIDER_BASE_URL.google
}

// Default model for a gateway-bound gemini agent (auto is banned there): walk
// the catalog in its own order and take the first entry the provider actually
// serves, so operators steer the default through catalog sort_order. Iterating
// the provider list instead would hand the default to whatever its listing
// happened to sort first — gateways commonly return ids alphabetically, which
// lands on the oldest model. Falls back to the first tested model when the
// catalog and the provider have nothing in common.
export const pickGeminiGatewayDefaultModel = (
    providerModels: readonly string[],
    catalogModelKeys: ReadonlySet<string>
): string | null => {
    const models = uniqueTrimmedModelIds(providerModels)
    const providerByCanonical = geminiProviderModelByCanonical(models)
    for (const key of catalogModelKeys) {
        const match = providerByCanonical.get(key)
        if (match) return match
    }
    return models[0] ?? null
}

export const providerModelIdsForProtocol = (
    lastTestModels: ProtocolModelMap | null | undefined,
    enabledModels: ProtocolModelMap | null | undefined,
    protocol: InferenceProtocol | null | undefined
): string[] | null => {
    const testedAll = flattenProtocolModelMap(lastTestModels)
    if (testedAll.length === 0) return null

    const testedForProtocol = protocol ? (lastTestModels?.[protocol] ?? []) : []
    const tested =
        testedForProtocol.length > 0
            ? uniqueTrimmedModelIds(testedForProtocol)
            : testedAll

    if (enabledModels == null) return tested

    const enabledForProtocol =
        protocol && hasProtocolModels(enabledModels, protocol)
            ? (enabledModels[protocol] ?? [])
            : testedForProtocol.length > 0
              ? tested
              : flattenProtocolModelMap(enabledModels)
    const enabledSet = new Set(uniqueTrimmedModelIds(enabledForProtocol))
    return tested.filter((model) => enabledSet.has(model))
}

export const suggestClaudeCodeModelMap = (
    providerModels: readonly string[]
): ClaudeCodeModelMap => {
    const models = uniqueTrimmedModelIds(providerModels)
    const out: ClaudeCodeModelMap = {}
    for (const alias of claudeCodeModelMapAliases) {
        const best = models
            .filter((model) => claudeModelMatchesAlias(model, alias))
            .sort((a, b) => compareClaudeModelRecency(b, a))[0]
        if (best) out[alias] = best
    }
    return out
}

export const mergeClaudeCodeModelMapWithSuggestions = (
    modelMap: ClaudeCodeModelMap | undefined,
    providerModels: readonly string[]
): ClaudeCodeModelMap => {
    const suggested = suggestClaudeCodeModelMap(providerModels)
    return {
        ...suggested,
        ...(modelMap ?? {})
    }
}

export const buildClaudeCodeDefaultModelConfig = (
    providerModels: readonly string[],
    existing?: ClaudeCodeAgentModelConfig | null
): ClaudeCodeAgentModelConfig => {
    const modelMap = mergeClaudeCodeModelMapWithSuggestions(
        existing?.modelMap,
        providerModels
    )
    const model =
        existing?.model?.trim() || preferredClaudeCodeModelAlias(modelMap)
    const providerModel = resolveClaudeCodeProviderModel(model, modelMap)
    return {
        framework: 'claude-code',
        model,
        effort: normalizeClaudeCodeEffortForModel(
            existing?.effort ?? claudeCodeDefaultEffort,
            providerModel
        ),
        modelMap
    }
}

export const buildCodexDefaultModelConfig = (
    providerModels: readonly string[],
    existing?: CodexAgentModelConfig | null
): CodexAgentModelConfig => {
    const providerModelByCanonical = new Map<string, string>()
    for (const id of uniqueTrimmedModelIds(providerModels)) {
        const canonical = codexCanonicalModelId(id)
        if (
            codexModels.includes(canonical as CodexSupportedModel) &&
            !providerModelByCanonical.has(canonical)
        )
            providerModelByCanonical.set(canonical, id)
    }
    const currentCanonical = existing?.model
        ? codexCanonicalModelId(existing.model)
        : null
    const canonical =
        (currentCanonical && providerModelByCanonical.has(currentCanonical)
            ? currentCanonical
            : null) ??
        codexModels.find((model) => providerModelByCanonical.has(model)) ??
        null
    const model = canonical
        ? (providerModelByCanonical.get(canonical) ?? null)
        : null
    const speed =
        existing?.speed === 'fast' && (!model || !codexModelSupportsFast(model))
            ? codexDefaultSpeed
            : (existing?.speed ?? codexDefaultSpeed)
    const intelligence =
        existing?.intelligence &&
        codexIntelligenceLevelsForModel(model).includes(existing.intelligence)
            ? existing.intelligence
            : codexDefaultIntelligenceForModel(model)
    return {
        framework: 'codex',
        model,
        speed,
        intelligence
    }
}

export const preferredClaudeCodeModelAlias = (
    modelMap: ClaudeCodeModelMap
): ClaudeCodeModelAlias | null => {
    if (modelMap.sonnet) return 'sonnet'
    if (modelMap.opus) return 'opus'
    if (modelMap.haiku) return 'haiku'
    if (modelMap.fable) return 'fable'
    return null
}

export const resolveCodexModelOptions = (
    providerModels: readonly string[]
): AgentModelConfigOption[] =>
    uniqueTrimmedModelIds(providerModels)
        .filter(isCodexSupportedModel)
        .map((model) => {
            const canonical = codexCanonicalModelId(model)
            return {
                value: model,
                label: model,
                providerModel: model,
                canonicalModel: canonical,
                supportsFast: codexModelSupportsFast(model),
                enabled: true,
                reason: null
            }
        })

export const resolveClaudeCodeModelOptions = (
    providerModels: readonly string[],
    modelMap: ClaudeCodeModelMap | undefined
): AgentModelConfigOption[] => {
    const models = uniqueTrimmedModelIds(providerModels)
    const providerSet = new Set(models)
    const mappedProviderModels = new Set<string>()
    const mappedClaudeFamilies = new Set<ClaudeCodeModelMapAlias>()
    for (const familyKey of claudeCodeModelMapAliases) {
        const mapped = modelMap?.[familyKey]?.trim()
        if (mapped && claudeCodeModelSelectionMapKey(mapped) === familyKey)
            mappedClaudeFamilies.add(familyKey)
    }
    const aliasOptions = claudeCodeModelAliases.map((alias) => {
        const mapAlias = claudeCodeModelAliasMapKey(alias)
        const providerModel = modelMap?.[mapAlias]?.trim() || null
        if (providerModel) mappedProviderModels.add(providerModel)
        const enabled = !!providerModel && providerSet.has(providerModel)
        return {
            value: alias,
            label: providerModel
                ? formatClaudeProviderModelLabel(providerModel, alias)
                : `${formatClaudeAliasLabel(alias)} · not mapped`,
            providerModel,
            canonicalModel: mapAlias,
            enabled,
            reason: enabled
                ? null
                : `Map ${titleCase(mapAlias)} to a tested provider model`
        } satisfies AgentModelConfigOption
    })
    const versionOptions = models
        .filter((model) => !mappedProviderModels.has(model))
        .flatMap((model): AgentModelConfigOption[] => {
            const mapAlias = claudeCodeModelSelectionMapKey(model)
            if (!mapAlias) return []
            if (!mappedClaudeFamilies.has(mapAlias)) return []
            return [
                {
                    value: model,
                    label: formatClaudeProviderModelLabel(model),
                    providerModel: model,
                    canonicalModel: mapAlias,
                    enabled: true,
                    reason: null
                }
            ]
        })
        .sort((a, b) => {
            const familyDelta =
                claudeFamilySortRank(a.canonicalModel) -
                claudeFamilySortRank(b.canonicalModel)
            if (familyDelta !== 0) return familyDelta
            return compareClaudeModelRecency(
                b.providerModel ?? b.value,
                a.providerModel ?? a.value
            )
        })
    return [...aliasOptions, ...versionOptions].sort(compareClaudeOptions)
}

const titleCase = (value: string): string =>
    value.slice(0, 1).toUpperCase() + value.slice(1)

const flattenProtocolModelMap = (
    map: ProtocolModelMap | null | undefined
): string[] => {
    if (!map) return []
    return uniqueTrimmedModelIds(Object.values(map).flat())
}

const hasProtocolModels = (
    map: ProtocolModelMap,
    protocol: InferenceProtocol
): boolean => Object.prototype.hasOwnProperty.call(map, protocol)

const formatClaudeAliasLabel = (alias: ClaudeCodeModelAlias): string => {
    const label = titleCase(claudeCodeModelAliasMapKey(alias))
    return isClaudeCodeOneMillionModelAlias(alias) ? `${label} 1M` : label
}

const formatClaudeProviderModelLabel = (
    model: string,
    alias?: ClaudeCodeModelAlias
): string => {
    const claudeFamily = claudeCodeModelSelectionMapKey(model)
    if (alias && !claudeFamily) {
        const aliasLabel = formatClaudeAliasLabel(alias)
        return `${aliasLabel} · ${model}`
    }
    const family = titleCase(
        claudeFamily ?? (alias ? claudeCodeModelAliasMapKey(alias) : 'haiku')
    )
    const version = claudeModelVersionLabel(model)
    const context =
        alias && isClaudeCodeOneMillionModelAlias(alias) ? ' 1M' : ''
    return version ? `${family} ${version}${context}` : `${family}${context}`
}

const claudeModelVersionLabel = (model: string): string | null => {
    const numbers = claudeModelVersionParts(model)
    if (numbers.length >= 2) return `${numbers[0]}.${numbers[1]}`
    if (numbers.length === 1) return String(numbers[0])
    return null
}

const claudeModelVersionParts = (model: string): number[] => {
    const withoutDates = model.toLowerCase().replace(/\d{8}/g, ' ')
    return [...withoutDates.matchAll(/\d+/g)]
        .map((match) => Number(match[0]))
        .filter((value) => value > 0 && value < 100)
}

const claudeCodeEffortProfileForModel = (
    model: string | null | undefined
): {
    defaultEffort: ClaudeCodeEffort
    efforts: readonly ClaudeCodeEffort[]
} | null => {
    const trimmed = model?.trim()
    if (!trimmed) return null
    const normalized = trimmed.toLowerCase()
    // Mythos Preview supports max but is absent from the official xhigh model
    // list; Mythos 5 is covered by the family branch below.
    if (normalized.includes('mythos-preview')) {
        return { defaultEffort: 'high', efforts: claudeCodeMaxEfforts }
    }
    if (claudeModelMatchesFamily(normalized, 'mythos')) {
        return { defaultEffort: 'high', efforts: claudeCodeFullEfforts }
    }

    const family = claudeCodeModelMapAliases.find((alias) =>
        claudeModelMatchesAlias(normalized, alias)
    )
    const version = claudeModelVersionParts(normalized)
    const major = version[0] ?? null
    const minor = version[1] ?? null

    if (family === 'fable') {
        return { defaultEffort: 'high', efforts: claudeCodeFullEfforts }
    }

    if (family === 'opus') {
        if (major === 4 && minor === 7)
            return { defaultEffort: 'high', efforts: claudeCodeFullEfforts }
        if (major === 4 && minor === 6)
            return { defaultEffort: 'high', efforts: claudeCodeMaxEfforts }
        if (major === 4 && minor === 5)
            return { defaultEffort: 'high', efforts: claudeCodeStandardEfforts }
        if (isFutureClaudeModelVersion(major, minor, 4, 7))
            return { defaultEffort: 'high', efforts: claudeCodeFullEfforts }
    }

    if (family === 'sonnet') {
        if (major === 4 && minor === 6)
            return {
                defaultEffort: 'medium',
                efforts: claudeCodeMaxEfforts
            }
        if (isFutureClaudeModelVersion(major, minor, 4, 6))
            return { defaultEffort: 'high', efforts: claudeCodeFullEfforts }
    }

    return null
}

const claudeFamilySortRank = (family: string | null | undefined): number => {
    if (family === 'fable') return 0
    if (family === 'opus') return 1
    if (family === 'sonnet') return 2
    if (family === 'haiku') return 3
    return 4
}

const compareClaudeOptions = (
    a: AgentModelConfigOption,
    b: AgentModelConfigOption
): number => {
    const familyDelta =
        claudeFamilySortRank(a.canonicalModel) -
        claudeFamilySortRank(b.canonicalModel)
    if (familyDelta !== 0) return familyDelta
    const aliasDelta =
        claudeAliasSortRank(a.value) - claudeAliasSortRank(b.value)
    if (aliasDelta !== 0) return aliasDelta
    return compareClaudeModelRecency(
        b.providerModel ?? b.value,
        a.providerModel ?? a.value
    )
}

const claudeAliasSortRank = (value: string): number => {
    if (isClaudeCodeOneMillionModelAlias(value)) return 1
    if (isClaudeCodeModelAlias(value)) return 0
    return 2
}

const claudeModelMatchesAlias = (
    model: string,
    alias: ClaudeCodeModelMapAlias
): boolean => {
    return claudeModelMatchesFamily(model, alias)
}

const claudeModelMatchesFamily = (model: string, family: string): boolean => {
    const normalized = model.toLowerCase()
    return new RegExp(`(^|[^a-z])${family}([^a-z]|$)`).test(normalized)
}

const isFutureClaudeModelVersion = (
    major: number | null,
    minor: number | null,
    minimumMajor: number,
    minimumMinor: number
): boolean => {
    if (major === null) return false
    if (minor === null) return major > minimumMajor
    return (
        major > minimumMajor || (major === minimumMajor && minor > minimumMinor)
    )
}

const compareClaudeModelRecency = (a: string, b: string): number => {
    const left = claudeModelSortKey(a)
    const right = claudeModelSortKey(b)
    return (
        left.major - right.major ||
        left.minor - right.minor ||
        left.patch - right.patch ||
        left.latest - right.latest ||
        left.date - right.date
    )
}

const claudeModelSortKey = (
    model: string
): {
    major: number
    minor: number
    patch: number
    latest: number
    date: number
} => {
    const lower = model.toLowerCase()
    const withoutProviderSuffix = lower
        .replace(/\d{8}/g, ' ')
        .replace(/-v\d+(?::\d+)?\b/g, ' ')
    const numbers = [...withoutProviderSuffix.matchAll(/\d+/g)].map((match) =>
        Number(match[0])
    )
    const versionNumbers = numbers.filter((num) => num >= 0 && num < 100)
    const dateNumbers = [...lower.matchAll(/\d{8}/g)].map((match) =>
        Number(match[0])
    )
    return {
        major: versionNumbers[0] ?? 0,
        minor: versionNumbers[1] ?? 0,
        patch: versionNumbers[2] ?? 0,
        latest: /\blatest\b/.test(lower) ? 1 : 0,
        date: Math.max(0, ...dateNumbers)
    }
}

export const claudeModelMapEnv = (
    config: ClaudeCodeAgentModelConfig | null
): Record<string, string> => {
    const map = config?.modelMap ?? {}
    const env: Record<string, string> = {}
    if (map.fable) env.ANTHROPIC_DEFAULT_FABLE_MODEL = map.fable
    if (map.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = map.opus
    if (map.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = map.sonnet
    if (map.haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = map.haiku
    if (!config?.model) return env
    if (isClaudeCodeModelAlias(config.model)) {
        if (isClaudeCodeOneMillionModelAlias(config.model)) {
            const mapKey = claudeCodeModelAliasMapKey(config.model)
            const mapped = map[mapKey]
            if (mapped)
                setClaudeDefaultModel(
                    env,
                    mapKey,
                    withoutOneMillionContext(mapped)
                )
        }
        return env
    }
    const mapKey = claudeCodeModelSelectionMapKey(config.model)
    if (mapKey) setClaudeDefaultModel(env, mapKey, config.model)
    return env
}

export const claudeCliModel = (
    config: ClaudeCodeAgentModelConfig | null,
    fallbackModel: string | null
): string | null => {
    const selected = config?.model?.trim() || fallbackModel?.trim() || null
    if (!selected) return null
    if (isClaudeCodeModelAlias(selected)) return selected
    return claudeCodeModelSelectionMapKey(selected)
}

const setClaudeDefaultModel = (
    env: Record<string, string>,
    mapKey: ClaudeCodeModelMapAlias,
    model: string
): void => {
    if (mapKey === 'fable') env.ANTHROPIC_DEFAULT_FABLE_MODEL = model
    else if (mapKey === 'opus') env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
    else if (mapKey === 'sonnet') env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    else if (mapKey === 'haiku') env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
}

const withoutOneMillionContext = (model: string): string =>
    model.trim().replace(/(\[1m\])+$/i, '')
