import {
    AgentModelConfig,
    AgentModelConfigSource,
    AgentModelConfigView,
    AgentRuntime,
    ClaudeCodeAgentModelConfig,
    ClaudeCodeEffort,
    ClaudeCodeModelAlias,
    CodexAgentModelConfig,
    CodexIntelligence,
    CodexSpeed,
    GeminiCliAgentModelConfig,
    UserModelProvider,
    UserModelProviderSummary,
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
    claudeCodeDefaultEffort,
    claudeCodeEffortsForModel,
    claudeCodeModelAliasMapKey,
    claudeCodeModelAliases,
    claudeCodeModelSelectionMapKey,
    codexCanonicalModelId,
    codexDefaultIntelligence,
    codexDefaultIntelligenceForModel,
    codexDefaultSpeed,
    codexIntelligenceLevelsForModel,
    codexModelSupportsFast,
    codexModels,
    codexSpeeds,
    geminiCanonicalModelId,
    geminiProviderModelByCanonical,
    isClaudeCodeModelAlias,
    isClaudeCodeOneMillionModelAlias,
    isGeminiAutoModel,
    normalizeClaudeCodeEffortForModel,
    preferredClaudeCodeModelAlias,
    providerModelIdsForProtocol,
    providerProtocolForTarget,
    resolveClaudeCodeModelOptions,
    resolveClaudeCodeProviderModel,
    resolveCodexModelOptions,
    resolveGeminiProviderModel,
    uniqueTrimmedModelIds
} from '@manyfold/shared'
import type { TFn } from '@/lib/i18n'

const modelConfigViewCachePrefix = 'nca.agentModelConfigView.'
const modelConfigViewCacheVersion = 1
export const agentModelConfigViewUpdatedEvent =
    'nca.agentModelConfigView.updated'

export interface AgentModelConfigViewUpdatedDetail {
    agentId: string
    view: AgentModelConfigView
}

export const frameworkUsesModelConfig = (
    framework: string | null | undefined,
    _runtime?: AgentRuntime | null
): boolean =>
    framework === 'claude-code' ||
    framework === 'codex' ||
    framework === 'gemini-cli'

export const modelConfigViewCacheKey = (agentId: string): string =>
    `${modelConfigViewCachePrefix}${agentId}`

export const readCachedModelConfigView = (
    agentId: string | null | undefined
): AgentModelConfigView | null => {
    if (!agentId) return null
    const storage = localStorageOrNull()
    if (!storage) return null
    const key = modelConfigViewCacheKey(agentId)
    try {
        const raw = storage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw) as unknown
        if (!isObject(parsed)) {
            storage.removeItem(key)
            return null
        }
        const version = parsed.version
        const view = parsed.view
        if (
            version !== modelConfigViewCacheVersion ||
            !isCachedModelConfigView(view, agentId)
        ) {
            storage.removeItem(key)
            return null
        }
        return view
    } catch {
        try {
            storage.removeItem(key)
        } catch {
            // Ignore quota/security errors from unavailable storage.
        }
        return null
    }
}

export const writeCachedModelConfigView = (
    view: AgentModelConfigView | null | undefined
): void => {
    if (!view?.agentId) return
    const storage = localStorageOrNull()
    if (storage) {
        try {
            storage.setItem(
                modelConfigViewCacheKey(view.agentId),
                JSON.stringify({
                    version: modelConfigViewCacheVersion,
                    storedAt: new Date().toISOString(),
                    view
                })
            )
        } catch {
            // localStorage is a best-effort UX cache only.
        }
    }
    dispatchModelConfigViewUpdated(view)
}

export const subscribeModelConfigViewUpdates = (
    agentId: string,
    onUpdate: (view: AgentModelConfigView) => void
): (() => void) => {
    if (typeof window === 'undefined') return () => {}
    const handleCustom = (event: Event): void => {
        const detail = (event as CustomEvent<AgentModelConfigViewUpdatedDetail>)
            .detail
        if (detail?.agentId !== agentId) return
        if (!isCachedModelConfigView(detail.view, agentId)) return
        onUpdate(detail.view)
    }
    const handleStorage = (event: StorageEvent): void => {
        if (event.key !== modelConfigViewCacheKey(agentId)) return
        const cached = readCachedModelConfigView(agentId)
        if (cached) onUpdate(cached)
    }
    window.addEventListener(agentModelConfigViewUpdatedEvent, handleCustom)
    window.addEventListener('storage', handleStorage)
    return () => {
        window.removeEventListener(
            agentModelConfigViewUpdatedEvent,
            handleCustom
        )
        window.removeEventListener('storage', handleStorage)
    }
}

export const mergeCachedRuntimeLocalModelConfigView = (
    view: AgentModelConfigView,
    cached: AgentModelConfigView | null
): AgentModelConfigView => {
    if (
        !cached ||
        cached.agentId !== view.agentId ||
        cached.framework !== view.framework ||
        !cached.runtimeLocal
    ) {
        return view
    }

    const cachedCheckedAt = timeValue(cached.runtimeLocal.lastCheckedAt)
    const viewCheckedAt = timeValue(view.runtimeLocal?.lastCheckedAt ?? null)
    const cachedIsNewer =
        cachedCheckedAt !== null &&
        (viewCheckedAt === null || cachedCheckedAt >= viewCheckedAt)
    // Only fills a gap, never overrules a verdict: the server now refuses a
    // runtime-local turn whose credentials it judged unusable, and a stale
    // `ready` cache winning here would show a picker for a source the next
    // send is going to reject.
    const cachedFillsAGap =
        Boolean(cached.runtimeLocal.ready) && !view.runtimeLocal?.lastCheckedAt

    if (!cachedIsNewer && !cachedFillsAGap) return view

    return {
        ...view,
        source: cached.source,
        availableSources: cached.runtimeLocal.ready
            ? withSource(view.availableSources, 'runtime-local')
            : view.availableSources,
        runtimeLocal: cached.runtimeLocal
    }
}

export const draftFromModelConfigView = (
    view: AgentModelConfigView | null
): AgentModelConfig | null => {
    if (!view) return null
    if (view.framework === 'claude-code') {
        const existing =
            view.config?.framework === 'claude-code' ? view.config : null
        const modelMap = existing?.modelMap ?? {}
        return normalizeClaudeModelConfigDraft({
            framework: 'claude-code',
            model: existing?.model ?? null,
            effort: existing?.effort ?? claudeCodeDefaultEffort,
            modelMap
        })
    }
    if (view.framework === 'codex') {
        const existing = view.config?.framework === 'codex' ? view.config : null
        return {
            framework: 'codex',
            model: existing?.model ?? null,
            speed: existing?.speed ?? codexDefaultSpeed,
            intelligence: existing?.intelligence ?? codexDefaultIntelligence
        }
    }
    if (view.framework === 'gemini-cli') {
        const existing =
            view.config?.framework === 'gemini-cli' ? view.config : null
        return {
            framework: 'gemini-cli',
            model: existing?.model ?? null
        }
    }
    return null
}

export const normalizeDraftForView = (
    view: AgentModelConfigView | null,
    draft: AgentModelConfig | null
): AgentModelConfig | null => {
    if (!view) return null
    if (draft?.framework === view.framework) {
        if (draft.framework === 'claude-code')
            return normalizeClaudeModelConfigDraft(draft)
        return draft
    }
    return draftFromModelConfigView(view)
}

export const normalizeClaudeModelConfigDraft = (
    draft: ClaudeCodeAgentModelConfig
): ClaudeCodeAgentModelConfig => ({
    ...draft,
    effort: normalizeClaudeCodeEffortForModel(
        draft.effort ?? claudeCodeDefaultEffort,
        resolveClaudeCodeProviderModel(draft.model, draft.modelMap)
    )
})

export const claudeEffortOptionsForDraft = (
    draft: Extract<AgentModelConfig, { framework: 'claude-code' }> | null
): readonly ClaudeCodeEffort[] =>
    claudeCodeEffortsForModel(
        resolveClaudeCodeProviderModel(draft?.model, draft?.modelMap)
    )

export type AgentModelSupportStatus = 'supported' | 'unsupported' | 'needs_test'

export interface AgentModelSupportRow {
    key: string
    value: string
    label: string
    detail: string | null
    providerModel: string | null
    canonicalModel: string | null
    enabled: boolean
    status: AgentModelSupportStatus
    reason: string | null
}

export interface AgentModelSupportMatrix {
    framework: 'claude-code' | 'codex'
    ready: boolean
    rows: AgentModelSupportRow[]
    supportedCount: number
    totalCount: number
}

export const modelConfigViewForProviderModels = (
    view: AgentModelConfigView,
    providerModels: readonly string[] | null,
    draft: AgentModelConfig | null,
    source: AgentModelConfigSource = 'platform'
): AgentModelConfigView => {
    const models =
        providerModels === null ? [] : uniqueTrimmedModelIds(providerModels)
    const modelMap =
        draft?.framework === 'claude-code'
            ? draft.modelMap
            : view.config?.framework === 'claude-code'
              ? view.config.modelMap
              : undefined
    return {
        ...view,
        source,
        providerModelsStatus:
            providerModels === null ? 'needs_refresh' : 'ready',
        providerModels: models,
        options:
            providerModels === null
                ? []
                : view.framework === 'claude-code'
                  ? resolveClaudeCodeModelOptions(models, modelMap)
                  : view.framework === 'codex'
                    ? resolveCodexModelOptions(models)
                    : view.framework === 'gemini-cli'
                      ? view.options
                      : []
    }
}

export const buildAgentModelSupportMatrix = (
    view: AgentModelConfigView,
    draft: AgentModelConfig | null,
    providerModels: readonly string[] | null
): AgentModelSupportMatrix | null => {
    if (view.framework === 'codex')
        return buildCodexSupportMatrix(providerModels)
    if (view.framework === 'claude-code')
        return buildClaudeSupportMatrix(draft, providerModels)
    return null
}

export const reconcileModelConfigDraftForProviderModels = (
    view: AgentModelConfigView | null,
    draft: AgentModelConfig | null,
    providerModels: readonly string[] | null
): AgentModelConfig | null => {
    if (!view || !frameworkUsesModelConfig(view.framework)) return draft
    if (providerModels === null) return normalizeDraftForView(view, draft)
    const models = uniqueTrimmedModelIds(providerModels)

    if (view.framework === 'codex')
        return buildCodexDefaultModelConfig(
            models,
            draft?.framework === 'codex' ? draft : null
        )
    if (view.framework === 'claude-code')
        return reconcileClaudeDraftForProviderModels(draft, models)
    if (view.framework === 'gemini-cli')
        return reconcileGeminiDraftForProviderModels(view, draft, models)
    return draft
}

export const isAgentModelSupportRowActive = (
    view: AgentModelConfigView,
    draft: AgentModelConfig | null,
    row: AgentModelSupportRow
): boolean => {
    if (view.framework === 'codex') {
        if (!draft || draft.framework !== 'codex' || !draft.model) return false
        return row.canonicalModel === codexCanonicalModelId(draft.model)
    }
    if (view.framework === 'claude-code') {
        return draft?.framework === 'claude-code' && draft.model === row.value
    }
    return false
}

export const withAgentModelSupportSelection = (
    view: AgentModelConfigView,
    draft: AgentModelConfig | null,
    row: AgentModelSupportRow
): AgentModelConfig => {
    if (view.framework === 'codex') {
        const next = withCodexModel(draft, row.providerModel ?? row.value)
        if (next.speed === 'fast' && !codexModelSupportsFast(next.model ?? ''))
            next.speed = codexDefaultSpeed
        return next
    }

    const value = row.value as ClaudeCodeModelAlias
    const mapKey = claudeCodeModelAliasMapKey(value)
    const existing = draft?.framework === 'claude-code' ? draft : null
    return normalizeClaudeModelConfigDraft({
        framework: 'claude-code',
        model: value,
        effort: existing?.effort ?? claudeCodeDefaultEffort,
        modelMap: {
            ...(existing?.modelMap ?? {}),
            [mapKey]: row.providerModel ?? undefined
        }
    })
}

export const providerModelIdsForSummary = (
    provider: UserModelProviderSummary,
    fallbackProvider: UserModelProvider
): string[] | null => {
    const protocol = providerProtocolForTarget(provider, fallbackProvider)
    if (!protocol) return null
    return providerModelIdsForProtocol(
        provider.lastTestModels,
        provider.enabledModels,
        protocol
    )
}

// Configurable frameworks (hermes/openclaw) auto-fill a primary model from the
// provider's list. Default to the economical tier per family instead of the
// first arbitrary id: gpt-5.x-mini for OpenAI, Haiku for Anthropic.
const economicalPrimaryModelDefaults: Partial<
    Record<UserModelProvider, { exact: string; keyword: string }>
> = {
    anthropic: { exact: 'claude-haiku-4-5', keyword: 'haiku' },
    openai: { exact: 'gpt-5.4-mini', keyword: 'mini' }
}

export const preferredPrimaryModelDefault = (
    options: readonly string[],
    provider: UserModelProvider
): string | undefined => {
    if (options.length === 0) return undefined
    const preference = economicalPrimaryModelDefaults[provider]
    if (preference) {
        const exact = options.find((o) => o === preference.exact)
        if (exact) return exact
        const keyword = preference.keyword.toLowerCase()
        const partial = options.find((o) =>
            o.toLowerCase().includes(keyword)
        )
        if (partial) return partial
    }
    return options[0]
}

// Maps the server's credential verdict onto a localized string. `unknown` gets
// none on purpose: it means "we could not judge", which is the normal state on
// a macOS host whose token lives in the keychain, and a warning there would be
// permanent noise.
export const runtimeLocalCredentialMessage = (
    view: AgentModelConfigView | null,
    t: TFn
): string | null => {
    const status = view?.runtimeLocal?.credentialStatus
    if (status === 'expired')
        return t('web.credentials.runtimeLocal.credentialsExpired')
    if (status === 'missing')
        return t('web.credentials.runtimeLocal.credentialsMissing')
    return null
}

// Aliases first: they are what the CLI's own picker shows, and a concrete id
// below is the escape hatch for a pinned version.
export const runtimeLocalModelOptions = (
    view: AgentModelConfigView | null
): string[] => {
    const runtimeLocal = view?.runtimeLocal
    if (!runtimeLocal) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const value of [...runtimeLocal.aliases, ...runtimeLocal.models]) {
        const trimmed = value.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
    }
    return out
}

// Runtime-local drafts keep every unset knob null. The with* helpers above
// fill in platform defaults, which would push a Manyfold-chosen effort onto a
// CLI the user asked to run on its own config.
export const patchRuntimeLocalDraft = (
    framework: AgentModelConfigView['framework'],
    draft: AgentModelConfig | null,
    patch: {
        model?: string | null
        effort?: ClaudeCodeEffort | null
        speed?: CodexSpeed | null
        intelligence?: CodexIntelligence | null
    }
): AgentModelConfig => {
    const model =
        patch.model !== undefined ? patch.model : (draft?.model ?? null)
    if (framework === 'claude-code')
        return {
            framework: 'claude-code',
            model,
            effort:
                patch.effort !== undefined
                    ? patch.effort
                    : draft?.framework === 'claude-code'
                      ? (draft.effort ?? null)
                      : null,
            modelMap:
                draft?.framework === 'claude-code' ? (draft.modelMap ?? {}) : {}
        }
    if (framework === 'codex')
        return {
            framework: 'codex',
            model,
            speed:
                patch.speed !== undefined
                    ? patch.speed
                    : draft?.framework === 'codex'
                      ? (draft.speed ?? null)
                      : null,
            intelligence:
                patch.intelligence !== undefined
                    ? patch.intelligence
                    : draft?.framework === 'codex'
                      ? (draft.intelligence ?? null)
                      : null
        }
    return { framework: 'gemini-cli', model }
}

export const validateModelConfigDraft = (
    view: AgentModelConfigView | null,
    draft: AgentModelConfig | null,
    t: TFn
): { valid: boolean; message: string | null } => {
    const message = (key: Parameters<TFn>[0]): string => t(key)
    if (!view || !frameworkUsesModelConfig(view.framework))
        return { valid: true, message: null }
    if (view.source === 'runtime-local') {
        // Never inspected: the server inspects before it refuses, so blocking
        // the composer here would punish users for not clicking refresh.
        if (!view.runtimeLocal?.lastCheckedAt || view.runtimeLocal.ready)
            return { valid: true, message: null }
        return {
            valid: false,
            message:
                runtimeLocalCredentialMessage(view, t) ??
                message('web.composer.validation.runtimeLocalNotReady')
        }
    }
    if (view.providerModelsStatus !== 'ready')
        return {
            valid: false,
            message: message('web.composer.validation.testProvider')
        }
    if (view.framework === 'claude-code') {
        if (!draft || draft.framework !== 'claude-code')
            return {
                valid: false,
                message: message('web.composer.validation.configureClaudeMapping')
            }
        if (!draft.model)
            return {
                valid: false,
                message: message('web.composer.validation.configureClaudeMapping')
            }
        const providerSet = new Set(view.providerModels)
        if (isClaudeCodeModelAlias(draft.model)) {
            const mappedModel =
                draft.modelMap?.[
                    claudeCodeModelAliasMapKey(draft.model)
                ]?.trim()
            if (!mappedModel || !providerSet.has(mappedModel))
                return {
                    valid: false,
                    message: message('web.composer.validation.configureClaudeMapping')
                }
        } else if (
            !providerSet.has(draft.model) ||
            !claudeCodeModelSelectionMapKey(draft.model)
        ) {
            return {
                valid: false,
                message: message('web.composer.validation.chooseTestedClaudeModel')
            }
        }
        const invalidMapping = Object.values(draft.modelMap ?? {}).some(
            (model) => {
                const id = model?.trim()
                return Boolean(id && !providerSet.has(id))
            }
        )
        if (invalidMapping)
            return {
                valid: false,
                message: message('web.composer.validation.useTestedProviderModels')
            }
        return { valid: true, message: null }
    }
    if (view.framework === 'codex') {
        if (!draft || draft.framework !== 'codex' || !draft.model)
            return {
                valid: false,
                message: message('web.composer.validation.chooseSupportedCodexModel')
            }
        const option = view.options.find((item) => item.value === draft.model)
        if (!option?.enabled)
            return {
                valid: false,
                message: message('web.composer.validation.chooseSupportedCodexModel')
            }
        if (draft.speed === 'fast' && !codexModelSupportsFast(draft.model))
            return {
                valid: false,
                message: message('web.composer.validation.chooseFastCapableModel')
            }
        return { valid: true, message: null }
    }
    if (view.framework === 'gemini-cli') {
        if (!draft || draft.framework !== 'gemini-cli')
            return { valid: true, message: null }
        if (!draft.model) return { valid: true, message: null }
        // Mirror the API's assertGeminiConfig, which is deliberately looser
        // than an exact option match: `auto` is healed server-side (a gateway
        // swaps in its default model) and the tested provider list is the
        // source of truth, so a canonical hit counts even when the option
        // values carry a provider prefix the stored id lacks.
        if (isGeminiAutoModel(draft.model)) return { valid: true, message: null }
        if (
            geminiProviderModelByCanonical(view.providerModels).has(
                geminiCanonicalModelId(draft.model)
            )
        )
            return { valid: true, message: null }
        const option = view.options.find((item) => item.value === draft.model)
        if (!option?.enabled)
            return {
                valid: false,
                message: message('web.composer.validation.chooseSupportedGeminiModel')
            }
        return { valid: true, message: null }
    }
    return { valid: true, message: null }
}

export const modelConfigDisplayLabel = (
    view: AgentModelConfigView | null,
    draft: AgentModelConfig | null,
    fallback: string,
    t: TFn
): string => {
    if (view?.source === 'runtime-local')
        return t('web.composer.runtimeLocalUsingTitle')
    if (!view || !draft) return fallback
    if (draft.framework === 'claude-code') {
        const alias = draft.model ?? null
        if (alias) {
            if (!isClaudeCodeModelAlias(alias))
                return formatClaudeProviderModelLabel(alias)
            const providerModel =
                draft.modelMap?.[claudeCodeModelAliasMapKey(alias)]?.trim()
            if (providerModel)
                return `${formatClaudeAliasLabel(alias)} · ${providerModel}`
            return formatClaudeAliasLabel(alias)
        }
        return fallback
    }
    if (draft.framework === 'codex') {
        const parts = [draft.model ?? fallback]
        if (draft.speed)
            parts.push(formatCodexSpeedLabel(draft.speed, t))
        if (draft.intelligence)
            parts.push(formatCodexIntelligenceLabel(draft.intelligence, t))
        return parts.join(' · ')
    }
    if (draft.framework === 'gemini-cli') {
        return draft.model ?? fallback
    }
    return fallback
}

export const withClaudeModel = (
    draft: AgentModelConfig | null,
    model: string
): ClaudeCodeAgentModelConfig =>
    normalizeClaudeModelConfigDraft({
        framework: 'claude-code',
        model,
        effort:
            draft?.framework === 'claude-code'
                ? draft.effort
                : claudeCodeDefaultEffort,
        modelMap: draft?.framework === 'claude-code' ? draft.modelMap : {}
    })

export const withClaudeEffort = (
    draft: AgentModelConfig | null,
    effort: ClaudeCodeEffort
): ClaudeCodeAgentModelConfig =>
    normalizeClaudeModelConfigDraft({
        framework: 'claude-code',
        model: draft?.framework === 'claude-code' ? draft.model : null,
        effort,
        modelMap: draft?.framework === 'claude-code' ? draft.modelMap : {}
    })

export const withCodexModel = (
    draft: AgentModelConfig | null,
    model: string
): CodexAgentModelConfig => {
    const intelligence =
        draft?.framework === 'codex'
            ? draft.intelligence
            : codexDefaultIntelligence
    return {
        framework: 'codex',
        model,
        speed: draft?.framework === 'codex' ? draft.speed : codexDefaultSpeed,
        intelligence:
            intelligence &&
            codexIntelligenceLevelsForModel(model).includes(intelligence)
                ? intelligence
                : codexDefaultIntelligenceForModel(model)
    }
}

export const withCodexSpeed = (
    draft: AgentModelConfig | null,
    speed: CodexSpeed
): CodexAgentModelConfig => ({
    framework: 'codex',
    model: draft?.framework === 'codex' ? draft.model : null,
    speed,
    intelligence:
        draft?.framework === 'codex' ? draft.intelligence : codexDefaultIntelligence
})

export const withCodexIntelligence = (
    draft: AgentModelConfig | null,
    intelligence: CodexIntelligence
): CodexAgentModelConfig => ({
    framework: 'codex',
    model: draft?.framework === 'codex' ? draft.model : null,
    speed: draft?.framework === 'codex' ? draft.speed : codexDefaultSpeed,
    intelligence
})

export const withGeminiModel = (
    _draft: AgentModelConfig | null,
    model: string | null
): GeminiCliAgentModelConfig => ({
    framework: 'gemini-cli',
    model: model && model.length > 0 ? model : null
})

const buildCodexSupportMatrix = (
    providerModels: readonly string[] | null
): AgentModelSupportMatrix => {
    const ready = providerModels !== null
    const byCanonical = new Map<string, string>()
    if (ready) {
        for (const model of uniqueTrimmedModelIds(providerModels)) {
            const canonical = codexCanonicalModelId(model)
            if (
                codexModels.includes(
                    canonical as (typeof codexModels)[number]
                ) &&
                !byCanonical.has(canonical)
            )
                byCanonical.set(canonical, model)
        }
    }

    const rows: AgentModelSupportRow[] = codexModels.map((model) => {
        const providerModel = byCanonical.get(model) ?? null
        const enabled = ready && !!providerModel
        return {
            key: model,
            value: providerModel ?? model,
            label: model,
            detail:
                providerModel && providerModel !== model ? providerModel : null,
            providerModel,
            canonicalModel: model,
            enabled,
            status: ready
                ? enabled
                    ? 'supported'
                    : 'unsupported'
                : 'needs_test',
            reason: ready
                ? enabled
                    ? null
                    : 'This provider did not report this Codex model.'
                : 'Test this provider to discover supported models.'
        }
    })

    return {
        framework: 'codex',
        ready,
        rows,
        supportedCount: rows.filter((row) => row.enabled).length,
        totalCount: rows.length
    }
}

const buildClaudeSupportMatrix = (
    draft: AgentModelConfig | null,
    providerModels: readonly string[] | null
): AgentModelSupportMatrix => {
    const ready = providerModels !== null
    const modelMap = ready
        ? (buildClaudeCodeDefaultModelConfig(
              providerModels,
              draft?.framework === 'claude-code' ? draft : null
          ).modelMap ?? {})
        : {}
    const providerSet = new Set(
        ready ? uniqueTrimmedModelIds(providerModels) : []
    )
    const rows: AgentModelSupportRow[] = claudeCodeModelAliases.map((alias) => {
        const mapKey = claudeCodeModelAliasMapKey(alias)
        const providerModel = modelMap[mapKey] ?? null
        const enabled =
            ready && !!providerModel && providerSet.has(providerModel)
        return {
            key: alias,
            value: alias,
            label: formatClaudeAliasLabel(alias),
            detail: providerModel,
            providerModel,
            canonicalModel: mapKey,
            enabled,
            status: ready
                ? enabled
                    ? 'supported'
                    : 'unsupported'
                : 'needs_test',
            reason: ready
                ? enabled
                    ? null
                    : `This provider did not report a ${formatClaudeAliasLabel(
                          mapKey
                      )} compatible model.`
                : 'Test this provider to discover supported models.'
        }
    })

    return {
        framework: 'claude-code',
        ready,
        rows,
        supportedCount: rows.filter((row) => row.enabled).length,
        totalCount: rows.length
    }
}

const reconcileClaudeDraftForProviderModels = (
    draft: AgentModelConfig | null,
    providerModels: readonly string[]
): ClaudeCodeAgentModelConfig => {
    const existing = draft?.framework === 'claude-code' ? draft : null
    const defaulted = buildClaudeCodeDefaultModelConfig(
        providerModels,
        existing
    )
    const modelMap = defaulted.modelMap ?? {}
    const providerSet = new Set(uniqueTrimmedModelIds(providerModels))
    const current = existing?.model?.trim() || null
    const currentFamily = current
        ? isClaudeCodeModelAlias(current)
            ? claudeCodeModelAliasMapKey(current)
            : claudeCodeModelSelectionMapKey(current)
        : null
    let model: ClaudeCodeAgentModelConfig['model'] = null

    if (current) {
        if (isClaudeCodeModelAlias(current)) {
            const mapKey = claudeCodeModelAliasMapKey(current)
            if (modelMap[mapKey]) model = current
        } else if (
            providerSet.has(current) &&
            claudeCodeModelSelectionMapKey(current)
        ) {
            model = current
        }
    }

    if (!model && currentFamily && modelMap[currentFamily]) {
        model = currentFamily
    }
    if (!model)
        model = defaulted.model ?? preferredClaudeCodeModelAlias(modelMap)

    return normalizeClaudeModelConfigDraft({
        framework: 'claude-code',
        model,
        effort: defaulted.effort,
        modelMap
    })
}

// Gemini needs the same provider-switch reconciliation claude/codex already do,
// otherwise a draft carried over from the previous provider (an antigravity
// `gemini-3-flash`, a bare id a gateway only serves as `google/…`) is validated
// against the new provider's ids and dead-ends: this dialog has no Gemini model
// picker to correct it with. Map the selection onto the new provider's own id
// first, and fall back to a model it actually serves — options are catalog
// ordered, which is what the API's pickGeminiGatewayDefaultModel walks too.
const reconcileGeminiDraftForProviderModels = (
    view: AgentModelConfigView,
    draft: AgentModelConfig | null,
    providerModels: readonly string[]
): GeminiCliAgentModelConfig => {
    const existing = draft?.framework === 'gemini-cli' ? draft : null
    const models = uniqueTrimmedModelIds(providerModels)
    const providerSet = new Set(models)
    const selected = existing?.model?.trim() || null
    const resolved = selected
        ? (resolveGeminiProviderModel(selected, models) ?? selected)
        : null
    if (resolved && (isGeminiAutoModel(resolved) || providerSet.has(resolved)))
        return { framework: 'gemini-cli', model: resolved }
    const served = view.options.find(
        (option) =>
            option.enabled &&
            !!option.providerModel &&
            providerSet.has(option.providerModel)
    )
    return {
        framework: 'gemini-cli',
        model: served?.value ?? models[0] ?? resolved
    }
}

export const codexSpeedOptions = codexSpeeds
export const codexIntelligenceOptionsForModel = (
    model: string | null | undefined
): readonly CodexIntelligence[] => codexIntelligenceLevelsForModel(model)

export const formatClaudeEffortLabel = (
    effort: ClaudeCodeEffort | string,
    t: TFn
): string => {
    if (effort === 'low') return t('web.composer.intelligence.low')
    if (effort === 'medium') return t('web.composer.intelligence.medium')
    if (effort === 'high') return t('web.composer.intelligence.high')
    if (effort === 'xhigh') return t('web.composer.intelligence.xhigh')
    if (effort === 'max') return t('web.composer.intelligence.max')
    return t('web.composer.intelligence.unknown')
}

export const formatCodexSpeedLabel = (
    speed: CodexSpeed | string,
    t: TFn
): string => {
    if (speed === 'fast') return t('web.composer.speedLabels.fast')
    if (speed === 'standard') return t('web.composer.speedLabels.standard')
    return t('web.composer.speedLabels.unknown')
}

export const formatCodexIntelligenceLabel = (
    intelligence: CodexIntelligence | string,
    t: TFn
): string => {
    if (intelligence === 'low') return t('web.composer.intelligence.low')
    if (intelligence === 'medium')
        return t('web.composer.intelligence.medium')
    if (intelligence === 'high') return t('web.composer.intelligence.high')
    if (intelligence === 'xhigh') return t('web.composer.intelligence.xhigh')
    return t('web.composer.intelligence.unknown')
}

export const formatClaudeAliasLabel = (
    alias: ClaudeCodeModelAlias | string
): string => {
    if (isClaudeCodeOneMillionModelAlias(alias))
        return `${titleCase(claudeCodeModelAliasMapKey(alias))} 1M`
    return titleCase(String(alias))
}

const formatClaudeProviderModelLabel = (model: string): string => {
    const family = claudeCodeModelSelectionMapKey(model)
    const version = claudeModelVersionLabel(model)
    const familyLabel = family ? titleCase(family) : 'Claude'
    return version ? `${familyLabel} ${version}` : familyLabel
}

const claudeModelVersionLabel = (model: string): string | null => {
    const withoutDates = model.toLowerCase().replace(/\d{8}/g, ' ')
    const numbers = [...withoutDates.matchAll(/\d+/g)]
        .map((match) => Number(match[0]))
        .filter((value) => value > 0 && value < 100)
    if (numbers.length >= 2) return `${numbers[0]}.${numbers[1]}`
    if (numbers.length === 1) return String(numbers[0])
    return null
}

const titleCase = (value: string): string =>
    value.slice(0, 1).toUpperCase() + value.slice(1)

const dispatchModelConfigViewUpdated = (view: AgentModelConfigView): void => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
        new CustomEvent<AgentModelConfigViewUpdatedDetail>(
            agentModelConfigViewUpdatedEvent,
            {
                detail: {
                    agentId: view.agentId,
                    view
                }
            }
        )
    )
}

const localStorageOrNull = (): Storage | null => {
    try {
        return globalThis.localStorage ?? null
    } catch {
        return null
    }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object')

const isCachedModelConfigView = (
    value: unknown,
    agentId: string
): value is AgentModelConfigView => {
    if (!isObject(value)) return false
    return (
        value.agentId === agentId &&
        (value.framework === 'claude-code' || value.framework === 'codex') &&
        (value.source === 'platform' || value.source === 'runtime-local') &&
        Array.isArray(value.availableSources)
    )
}

const timeValue = (value: string | null): number | null => {
    if (!value) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
}

const withSource = (
    sources: AgentModelConfigSource[],
    source: AgentModelConfigSource
): AgentModelConfigSource[] =>
    sources.includes(source) ? sources : [...sources, source]
