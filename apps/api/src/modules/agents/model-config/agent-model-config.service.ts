import {
    AgentModelConfig,
    AgentModelConfigOption,
    AgentModelConfigSource,
    AgentModelConfigView,
    AgentModelProviderModelsCache,
    AgentRuntimeLocalModelConfigSource,
    AgentRuntimeLocalModelConfigStatus,
    ClaudeCodeAgentModelConfig,
    ClaudeCodeModelMap,
    ClaudeCodeModelMapAlias,
    CodexAgentModelConfig,
    DaemonFrameworkModelCapability,
    DaemonModelInspectResponse,
    GeminiCliAgentModelConfig,
    InferenceProtocol,
    OFFICIAL_PROVIDER_BASE_URL,
    RefreshAgentModelConfigModelsResponse,
    UpdateAgentModelConfigBody,
    UserModelProvider,
    agentModelConfigSources,
    buildClaudeCodeDefaultModelConfig,
    claudeCodeModelAliasMapKey,
    claudeCodeModelMapAliases,
    claudeCodeModelSelectionMapKey,
    claudeLocalModelCatalog,
    codexCanonicalModelId,
    codexDefaultIntelligenceForModel,
    codexIntelligenceLevels,
    codexIntelligenceLevelsForModel,
    type CodexIntelligence,
    type RuntimeLocalTuning,
    defaultProtocolForProvider,
    geminiAutoModelKey,
    geminiCanonicalModelId,
    geminiProviderModelByCanonical,
    isAgentModelConfigSource,
    isClaudeCodeEffort,
    isClaudeCodeOneMillionModelAlias,
    isGeminiAutoModel,
    isGeminiGatewayBaseUrl,
    normalizeClaudeCodeEffortForModel,
    pickGeminiGatewayDefaultModel,
    providerModelIdsForProtocol,
    resolveClaudeCodeProviderModel,
    resolveGeminiProviderModel,
    uniqueTrimmedModelIds,
    isRuntimeLocalCredentialUsable,
    parseRuntimeLocalCredentialFacts,
    runtimeLocalCredentialStatus,
    type RuntimeLocalCredentialFacts,
    type RuntimeLocalCredentialStatus
} from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    jsonbMerge,
    type Agent,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { ModelProvidersService } from '@/modules/model-providers/model-providers.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { FrameworkCatalogService } from '@/modules/framework-catalog/framework-catalog.service'
import {
    isConfigurableFramework,
    type ConfigurableFramework,
    type FrameworkModelView
} from '@/modules/framework-catalog/framework-catalog.types'

type ModelConfigExtras = {
    source?: unknown
    claudeCode?: {
        effort?: unknown
        modelMap?: unknown
    }
    codex?: {
        speed?: unknown
        intelligence?: unknown
    }
    gemini?: {
        model?: unknown
    }
}

interface ProviderDetail {
    provider: UserModelProvider | null
    inferenceProtocol: InferenceProtocol | null
    apiKey: string | null
    baseUrl: string | null
}

interface ProviderModelsState {
    provider: UserModelProvider | null
    baseUrl: string | null
    status: AgentModelConfigView['providerModelsStatus']
    source: AgentModelProviderModelsCache['source'] | null
    models: string[]
}

interface RuntimeLocalModelConfigCache extends AgentRuntimeLocalModelConfigStatus {
    source: AgentRuntimeLocalModelConfigSource
    credentialFacts: RuntimeLocalCredentialFacts | null
}

export interface ResolvedTurnModelConfig {
    model: string | null
    modelConfig: AgentModelConfig | null
    runtimeLocalTuning?: RuntimeLocalTuning
}

@Injectable()
export class AgentModelConfigService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly modelProviders: ModelProvidersService,
        private readonly catalog: FrameworkCatalogService,
        @Optional()
        private readonly daemonRegistry?: DaemonRegistryService,
        @Optional()
        private readonly execDrivers?: ExecDriverFactory
    ) {}

    async getForAgent(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentModelConfigView> {
        const agent = await this.requireAgent(callerUserId, agentId, isAdmin)
        return this.buildView(agent)
    }

    async updateForAgent(
        callerUserId: string,
        agentId: string,
        body: UpdateAgentModelConfigBody,
        isAdmin: boolean
    ): Promise<AgentModelConfigView> {
        const agent = await this.requireAgent(callerUserId, agentId, isAdmin)
        const source = this.resolveIncomingSource(agent, body.modelConfigSource)
        if (source === 'runtime-local') {
            const requested =
                body.model === undefined
                    ? normalizeNullable(agent.model)
                    : normalizeNullable(body.model)
            if (requested) this.assertRuntimeLocalModel(agent, requested)
            const next = await this.persistRuntimeLocalSelection(
                agent,
                requested,
                this.runtimeLocalTuning(agent, body.modelConfig)
            )
            return this.buildView(next)
        }
        const config = await this.resolveIncomingConfig(agent, body, true)
        const next = await this.persistConfig(agent, config, source)
        return this.buildView(next)
    }

    async refreshProviderModels(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean,
        requestedSource?: AgentModelConfigSource | null
    ): Promise<RefreshAgentModelConfigModelsResponse> {
        const agent = await this.requireAgent(callerUserId, agentId, isAdmin)
        const source = this.resolveIncomingSource(agent, requestedSource)
        if (source === 'runtime-local')
            return this.refreshRuntimeLocalModelCapability(agent)

        const detail = await this.providerDetail(agent)
        if (!detail.provider || !detail.apiKey)
            throw new BadRequestException(
                `model provider credentials are unavailable for framework ${agent.framework}`
            )
        const saved = await this.modelProviders.findByApiKey({
            userId: agent.userId,
            apiKey: detail.apiKey
        })
        const result = saved
            ? await this.modelProviders.testSaved(agent.userId, saved.id)
            : await this.modelProviders.testInline({
                  inferenceProtocol:
                      detail.inferenceProtocol ??
                      defaultProtocolForProvider(detail.provider),
                  apiKey: detail.apiKey,
                  baseUrl:
                      detail.baseUrl ??
                      OFFICIAL_PROVIDER_BASE_URL[detail.provider]
              })
        const models = result.ok ? result.models.map((m) => m.id) : []
        const nextExtras = {
            modelProviderModels: {
                provider: detail.provider,
                baseUrl: detail.baseUrl,
                models,
                testedAt: new Date().toISOString(),
                source: saved ? 'saved-provider' : 'agent-refresh'
            } satisfies AgentModelProviderModelsCache
        }
        const [updated] = await this.db
            .update(agents)
            .set({
                extras: jsonbMerge(agents.extras, nextExtras),
                updatedAt: new Date()
            })
            .where(eq(agents.id, agent.id))
            .returning()
        const updatedWithDefaults = result.ok
            ? await this.persistClaudeDefaultsIfReady(updated, {
                  provider: detail.provider,
                  baseUrl: detail.baseUrl,
                  status: models.length > 0 ? 'ready' : 'needs_refresh',
                  source: saved ? 'saved-provider' : 'agent-refresh',
                  models: uniqueTrimmedModelIds(models)
              })
            : updated
        const view = await this.buildView(updatedWithDefaults)
        return {
            ok: result.ok,
            message: result.message ?? null,
            latencyMs: result.latencyMs,
            models: view.providerModels,
            view
        }
    }

    async ensureProviderModelsReady(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean,
        modelConfigSource?: AgentModelConfigSource | null
    ): Promise<AgentModelConfigView> {
        const agent = await this.requireAgent(callerUserId, agentId, isAdmin)
        const source = this.resolveIncomingSource(agent, modelConfigSource)
        if (source === 'runtime-local') {
            return this.buildView(agent)
        }
        const providerModels = await this.providerModels(agent)
        if (providerModels.status === 'ready') {
            const next = await this.persistClaudeDefaultsIfReady(
                agent,
                providerModels
            )
            return this.buildView(next)
        }
        return (
            await this.refreshProviderModels(
                callerUserId,
                agentId,
                isAdmin,
                'platform'
            )
        ).view
    }

    async resolveTurnConfig(input: {
        callerUserId: string
        agentId: string
        model?: string | null
        modelConfigSource?: AgentModelConfigSource | null
        modelConfig?: AgentModelConfig | null
        saveAsDefault?: boolean
    }): Promise<ResolvedTurnModelConfig> {
        const agent = await this.requireAgent(
            input.callerUserId,
            input.agentId,
            false
        )
        if (!isFrameworkModelConfigurable(agent.framework)) {
            const model = normalizeNullable(input.model) ?? agent.model ?? null
            return { model, modelConfig: null }
        }

        const source = this.resolveIncomingSource(
            agent,
            input.modelConfigSource
        )
        if (source === 'runtime-local') {
            const usable = await this.assertRuntimeLocalUsable(agent)
            const incomingModel =
                normalizeNullable(input.model) ??
                normalizeNullable(input.modelConfig?.model)
            const requested = incomingModel ?? normalizeNullable(usable.model)
            if (requested) this.assertRuntimeLocalModel(usable, requested)
            const tuning = this.runtimeLocalTuning(usable, input.modelConfig)
            if (
                input.saveAsDefault &&
                (input.modelConfigSource || incomingModel || input.modelConfig)
            )
                await this.persistRuntimeLocalSelection(
                    usable,
                    requested,
                    tuning
                )
            // modelConfig stays null on purpose: the adapters read it as "the
            // platform owns this turn" and inject platform credentials when it
            // is set. Local tuning travels in its own field.
            return {
                model: requested,
                modelConfig: null,
                runtimeLocalTuning: tuning
            }
        }

        const hasIncoming =
            input.modelConfigSource !== undefined ||
            input.modelConfig !== undefined ||
            (typeof input.model === 'string' && input.model.trim().length > 0)
        const config = await this.resolveIncomingConfig(
            agent,
            {
                model: input.model ?? undefined,
                modelConfig: input.modelConfig ?? undefined
            },
            true
        )
        if (input.saveAsDefault && hasIncoming)
            await this.persistConfig(agent, config, source)
        return { model: modelFromConfig(config), modelConfig: config }
    }

    private async resolveIncomingConfig(
        agent: Agent,
        body: UpdateAgentModelConfigBody,
        requireSelected: boolean
    ): Promise<AgentModelConfig> {
        if (agent.framework === 'claude-code') {
            const config = await this.mergeClaudeConfig(agent, body)
            await this.assertClaudeConfig(agent, config, requireSelected)
            return config
        }
        if (agent.framework === 'codex') {
            const config = await this.mergeCodexConfig(agent, body)
            await this.assertCodexConfig(agent, config, requireSelected)
            return config
        }
        if (agent.framework === 'gemini-cli') {
            const config = await this.mergeGeminiConfig(agent, body)
            await this.assertGeminiConfig(agent, config, requireSelected)
            return config
        }
        throw new BadRequestException(
            `model config is not supported for framework ${agent.framework}`
        )
    }

    private async mergeClaudeConfig(
        agent: Agent,
        body: UpdateAgentModelConfigBody
    ): Promise<ClaudeCodeAgentModelConfig> {
        const existing = this.configFromAgent(
            agent
        ) as ClaudeCodeAgentModelConfig | null
        const raw = asRecord(body.modelConfig)
        if (raw?.framework !== undefined && raw.framework !== 'claude-code')
            throw new BadRequestException(
                `modelConfig.framework must be claude-code for agent ${agent.id}`
            )
        const providerModels =
            await this.providerModelsForPlatformValidation(agent)
        const defaulted =
            providerModels.status === 'ready'
                ? buildClaudeCodeDefaultModelConfig(
                      providerModels.models,
                      existing
                  )
                : existing
        const modelRaw = raw?.model ?? body.model ?? defaulted?.model ?? null
        const effortRaw = raw?.effort ?? defaulted?.effort ?? null
        const model = normalizeNullable(modelRaw)
        const effort = normalizeNullable(effortRaw)
        const mapPatch = sanitizeClaudeModelMap(raw?.modelMap)
        const modelMap = {
            ...(defaulted?.modelMap ?? {}),
            ...mapPatch
        }
        if (effort && !isClaudeCodeEffort(effort))
            throw new BadRequestException('invalid Claude Code effort')
        return {
            framework: 'claude-code',
            model,
            effort: normalizeClaudeCodeEffortForModel(
                effort as ClaudeCodeAgentModelConfig['effort'],
                resolveClaudeCodeProviderModel(model, modelMap)
            ),
            modelMap
        }
    }

    private async mergeCodexConfig(
        agent: Agent,
        body: UpdateAgentModelConfigBody
    ): Promise<CodexAgentModelConfig> {
        const existing = this.configFromAgent(
            agent
        ) as CodexAgentModelConfig | null
        const raw = asRecord(body.modelConfig)
        if (raw?.framework !== undefined && raw.framework !== 'codex')
            throw new BadRequestException(
                `modelConfig.framework must be codex for agent ${agent.id}`
            )
        const model = normalizeNullable(
            raw?.model ?? body.model ?? existing?.model
        )
        const defaultSpeed =
            (await this.catalog.getDefaultEnumValue('codex', 'speed'))?.value ??
            'standard'
        const defaultIntelligence =
            (await this.catalog.getDefaultEnumValue('codex', 'intelligence'))
                ?.value ?? codexDefaultIntelligenceForModel(model)
        const speed =
            normalizeNullable(raw?.speed ?? existing?.speed) ?? defaultSpeed
        const intelligence =
            normalizeCodexIntelligence(
                normalizeNullable(raw?.intelligence ?? existing?.intelligence)
            ) ?? defaultIntelligence
        return {
            framework: 'codex',
            model,
            speed: speed as CodexAgentModelConfig['speed'],
            intelligence: intelligence as CodexAgentModelConfig['intelligence']
        }
    }

    private async mergeGeminiConfig(
        agent: Agent,
        body: UpdateAgentModelConfigBody
    ): Promise<GeminiCliAgentModelConfig> {
        const existing = this.configFromAgent(
            agent
        ) as GeminiCliAgentModelConfig | null
        const raw = asRecord(body.modelConfig)
        if (raw?.framework !== undefined && raw.framework !== 'gemini-cli')
            throw new BadRequestException(
                `modelConfig.framework must be gemini-cli for agent ${agent.id}`
            )
        const requested =
            normalizeNullable(raw?.model ?? body.model ?? existing?.model) ??
            geminiAutoModelKey
        const providerModels =
            await this.providerModelsForPlatformValidation(agent)
        if (isGeminiAutoModel(requested)) {
            // Auto is the CLI's own router and only works against the
            // official endpoint; on a gateway substitute the default provider
            // model so existing auto agents heal instead of dying silently.
            if (
                isGeminiGatewayBaseUrl(providerModels.baseUrl) &&
                providerModels.status === 'ready'
            ) {
                const fallback = pickGeminiGatewayDefaultModel(
                    providerModels.models,
                    await this.geminiCatalogModelKeys()
                )
                if (fallback)
                    return { framework: 'gemini-cli', model: fallback }
            }
            return { framework: 'gemini-cli', model: geminiAutoModelKey }
        }
        const model =
            providerModels.status === 'ready'
                ? (resolveGeminiProviderModel(
                      requested,
                      providerModels.models
                  ) ?? requested)
                : requested
        return {
            framework: 'gemini-cli',
            model
        }
    }

    private async geminiCatalogModelKeys(): Promise<Set<string>> {
        const rows = await this.catalog.listModels('gemini-cli', {
            activeOnly: true
        })
        return new Set(
            rows.filter((m) => m.kind === 'model').map((m) => m.modelKey)
        )
    }

    private async assertClaudeConfig(
        agent: Agent,
        config: ClaudeCodeAgentModelConfig,
        requireSelected: boolean
    ): Promise<void> {
        const aliasModels = (
            await this.catalog.listModels('claude-code', { activeOnly: true })
        ).filter((m) => m.kind === 'alias')
        const aliasKeys = aliasModels.map((m) => m.modelKey)
        if (
            config.effort &&
            !(await this.catalog.isEnumValueActive(
                'claude-code',
                'effort',
                config.effort
            ))
        )
            throw new BadRequestException('invalid Claude Code effort')
        if (requireSelected && !config.model)
            throw new BadRequestException('Claude Code model is required')
        const providerModels =
            await this.providerModelsForPlatformValidation(agent)
        if (providerModels.status !== 'ready')
            throw new BadRequestException(
                'Test provider before configuring Claude Code models'
            )
        const providerSet = new Set(providerModels.models)
        for (const [alias, providerModel] of Object.entries(
            config.modelMap ?? {}
        )) {
            if (
                !claudeCodeModelMapAliases.includes(
                    alias as ClaudeCodeModelMapAlias
                )
            )
                continue
            if (providerModel && !providerSet.has(providerModel))
                throw new BadRequestException(
                    `Claude ${alias} mapping must use a tested provider model`
                )
        }
        if (config.model) {
            if (aliasKeys.includes(config.model)) {
                const mapped =
                    config.modelMap?.[
                        claudeCodeModelAliasMapKey(
                            config.model as ClaudeCodeModelMapAlias
                        )
                    ]?.trim()
                if (!mapped || !providerSet.has(mapped))
                    throw new BadRequestException(
                        `Configure Claude model mapping for ${config.model}`
                    )
            } else if (
                !providerSet.has(config.model) ||
                !claudeCodeModelSelectionMapKey(config.model)
            ) {
                throw new BadRequestException(
                    `Claude Code model must be a supported alias (${aliasKeys.join(
                        ', '
                    )}) or a tested Claude provider model`
                )
            }
        }
    }

    private async assertCodexConfig(
        agent: Agent,
        config: CodexAgentModelConfig,
        requireSelected: boolean
    ): Promise<void> {
        if (
            config.speed &&
            !(await this.catalog.isEnumValueActive(
                'codex',
                'speed',
                config.speed
            ))
        )
            throw new BadRequestException('invalid Codex speed')
        if (
            config.intelligence &&
            !(await this.catalog.isEnumValueActive(
                'codex',
                'intelligence',
                config.intelligence
            ))
        )
            throw new BadRequestException('invalid Codex intelligence')
        if (requireSelected && !config.model)
            throw new BadRequestException('Codex model is required')
        const providerModels =
            await this.providerModelsForPlatformValidation(agent)
        if (providerModels.status !== 'ready')
            throw new BadRequestException(
                'Test provider before configuring Codex models'
            )
        const options = await this.resolveOptionsForFramework(
            'codex',
            providerModels.models,
            undefined
        )
        if (config.model && !options.some((o) => o.value === config.model))
            throw new BadRequestException('Choose a supported Codex model')
        if (
            config.model &&
            config.intelligence &&
            !codexIntelligenceLevelsForModel(config.model).includes(
                config.intelligence
            )
        )
            throw new BadRequestException(
                `Codex model ${config.model} does not support intelligence ${config.intelligence}`
            )
        if (config.model && config.speed === 'fast') {
            const canonical = codexCanonicalModelId(config.model)
            const supportsFast =
                (await this.catalog.modelHasCapability(
                    'codex',
                    canonical,
                    'fast'
                )) ||
                (await this.catalog.modelHasCapability(
                    'codex',
                    config.model,
                    'fast'
                ))
            if (!supportsFast)
                throw new BadRequestException(
                    'Codex fast speed requires a model that supports the fast tier'
                )
        }
    }

    private async assertGeminiConfig(
        agent: Agent,
        config: GeminiCliAgentModelConfig,
        requireSelected: boolean
    ): Promise<void> {
        if (requireSelected && !config.model)
            throw new BadRequestException('Gemini CLI model is required')
        if (!config.model || isGeminiAutoModel(config.model)) return
        // The provider's tested generateContent model list is the source of
        // truth: gateways (NetMind, managed antigravity) serve ids the static
        // catalog never knew (`google/…` prefixes, `-low` variants). The
        // catalog check only remains as fallback when discovery never ran.
        const providerModels =
            await this.providerModelsForPlatformValidation(agent)
        if (providerModels.status === 'ready') {
            const providerSet = new Set(providerModels.models)
            const canonicalHit = geminiProviderModelByCanonical(
                providerModels.models
            ).get(geminiCanonicalModelId(config.model))
            if (providerSet.has(config.model) || canonicalHit) return
            throw new BadRequestException(
                `Gemini CLI model "${config.model}" is not in the tested provider model list. Pick one of: ${providerModels.models.join(', ')}`
            )
        }
        const active = await this.catalog.isModelKeyActive(
            'gemini-cli',
            geminiCanonicalModelId(config.model)
        )
        if (!active)
            throw new BadRequestException(
                `Gemini CLI model "${config.model}" is not in the supported model catalog. Pick one of: ${(
                    await this.catalog.listModels('gemini-cli', {
                        activeOnly: true
                    })
                )
                    .map((m) => m.modelKey)
                    .join(', ')}`
            )
    }

    private async persistConfig(
        agent: Agent,
        config: AgentModelConfig,
        source: AgentModelConfigSource = 'platform'
    ): Promise<Agent> {
        const latest = await this.reloadAgent(agent)
        const existingExtras = safeRecord(latest.extras)
        const existingModelConfig = (asRecord(existingExtras.modelConfig) ??
            {}) as ModelConfigExtras
        const nextModelConfig: ModelConfigExtras = {
            ...existingModelConfig,
            source
        }
        if (config.framework === 'claude-code') {
            nextModelConfig.claudeCode = {
                effort: config.effort ?? null,
                modelMap: config.modelMap ?? {}
            }
        } else if (config.framework === 'codex') {
            nextModelConfig.codex = {
                speed: config.speed ?? 'standard',
                intelligence: config.intelligence ?? 'medium'
            }
        } else {
            nextModelConfig.gemini = {
                model: config.model ?? null
            }
        }
        const [updated] = await this.db
            .update(agents)
            .set({
                model: modelFromConfig(config),
                extras: jsonbMerge(agents.extras, {
                    modelConfig: nextModelConfig
                }),
                updatedAt: new Date()
            })
            .where(eq(agents.id, agent.id))
            .returning()
        return updated
    }

    private async persistRuntimeLocalSelection(
        agent: Agent,
        model: string | null,
        tuning: RuntimeLocalTuning
    ): Promise<Agent> {
        const latest = await this.reloadAgent(agent)
        const existingExtras = safeRecord(latest.extras)
        const existingModelConfig = (asRecord(existingExtras.modelConfig) ??
            {}) as ModelConfigExtras
        const nextModelConfig: ModelConfigExtras = {
            ...existingModelConfig,
            source: 'runtime-local'
        }
        // Only the tuning knobs are stored, never a modelMap: that one exists
        // to point aliases at a platform provider and has no meaning against a
        // CLI running on its own login.
        if (agent.framework === 'claude-code')
            nextModelConfig.claudeCode = {
                ...(existingModelConfig.claudeCode ?? {}),
                effort: tuning.effort ?? null
            }
        else if (agent.framework === 'codex')
            nextModelConfig.codex = {
                speed: tuning.speed ?? null,
                intelligence: tuning.intelligence ?? null
            }
        const [updated] = await this.db
            .update(agents)
            .set({
                model,
                extras: jsonbMerge(agents.extras, {
                    modelConfig: nextModelConfig
                }),
                updatedAt: new Date()
            })
            .where(eq(agents.id, agent.id))
            .returning()
        return updated
    }

    // A cached refusal can be stale in the one direction that matters: the user
    // may have just signed in on the runtime host. Re-inspect before refusing
    // so the gate never blocks a machine that works. The happy path never
    // reaches here, so a live turn pays nothing for this.
    private async assertRuntimeLocalUsable(agent: Agent): Promise<Agent> {
        const cached = this.runtimeLocalConfigFromAgent(agent)
        if (!cached?.lastCheckedAt || cached.ready) return agent
        let refreshed: Agent
        try {
            await this.refreshRuntimeLocalModelCapability(agent)
            refreshed = await this.reloadAgent(agent)
        } catch (err) {
            // The inspect transport failed rather than the credentials: let the
            // turn run and report its own error instead of inventing one.
            if (agent.runtime !== 'daemon') return agent
            throw new BadRequestException((err as Error).message)
        }
        const next = this.runtimeLocalConfigFromAgent(refreshed)
        if (next?.ready) return refreshed
        throw new BadRequestException(
            next?.error ?? 'Runtime local config is not ready'
        )
    }

    private assertRuntimeLocalModel(agent: Agent, model: string): void {
        const runtimeLocal = this.runtimeLocalConfigFromAgent(agent)
        const known = [
            ...(runtimeLocal?.models ?? []),
            ...(runtimeLocal?.aliases ?? [])
        ]
        // An empty list means nothing has enumerated this runtime yet (or the
        // daemon predates the models field); refusing there would make the
        // picker unusable for exactly the agents it should help.
        if (known.length === 0) return
        if (agent.framework === 'gemini-cli' && isGeminiAutoModel(model)) return
        if (!known.includes(model))
            throw new BadRequestException(
                `${model} is not available in the local config for ${agent.framework}`
            )
    }

    // Only what the user explicitly picked survives here. Defaulting an unset
    // knob would push a platform default onto a CLI that was asked to use its
    // own config — the exact thing this source exists to avoid.
    private runtimeLocalTuning(
        agent: Agent,
        incoming: AgentModelConfig | null | undefined
    ): RuntimeLocalTuning {
        const stored = (asRecord(safeRecord(agent.extras).modelConfig) ??
            {}) as ModelConfigExtras
        if (agent.framework === 'claude-code') {
            const requested =
                incoming?.framework === 'claude-code'
                    ? incoming.effort
                    : normalizeNullable(asRecord(stored.claudeCode)?.effort)
            return {
                effort: isClaudeCodeEffort(requested) ? requested : null
            }
        }
        if (agent.framework === 'codex') {
            const raw = asRecord(stored.codex)
            const speed =
                incoming?.framework === 'codex'
                    ? incoming.speed
                    : normalizeNullable(raw?.speed)
            const intelligence = normalizeCodexIntelligence(
                incoming?.framework === 'codex'
                    ? (incoming.intelligence ?? null)
                    : normalizeNullable(raw?.intelligence)
            )
            return {
                speed: speed === 'fast' ? 'fast' : null,
                intelligence: codexIntelligenceLevels.includes(
                    intelligence as CodexIntelligence
                )
                    ? (intelligence as CodexIntelligence)
                    : null
            }
        }
        return {}
    }

    private async reloadAgent(agent: Agent): Promise<Agent> {
        const [latest] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agent.id))
            .limit(1)
        return latest ?? agent
    }

    private async persistClaudeDefaultsIfReady(
        agent: Agent,
        providerModels: ProviderModelsState
    ): Promise<Agent> {
        if (
            agent.framework !== 'claude-code' ||
            providerModels.status !== 'ready'
        )
            return agent
        const existing = this.configFromAgent(
            agent
        ) as ClaudeCodeAgentModelConfig | null
        const config = buildClaudeCodeDefaultModelConfig(
            providerModels.models,
            existing
        )
        if (!config.model || claudeConfigsEqual(existing, config)) return agent
        return this.persistConfig(agent, config, 'platform')
    }

    private async resolveOptionsForFramework(
        framework: ConfigurableFramework,
        providerModels: readonly string[],
        modelMap: ClaudeCodeModelMap | undefined,
        geminiGateway = false
    ): Promise<AgentModelConfigOption[]> {
        const catalogModels = await this.catalog.listModels(framework, {
            activeOnly: true
        })
        if (framework === 'codex')
            return resolveCodexOptionsFromCatalog(providerModels, catalogModels)
        if (framework === 'gemini-cli')
            return resolveGeminiOptionsFromCatalog(
                providerModels,
                catalogModels,
                geminiGateway
            )
        return resolveClaudeOptionsFromCatalog(
            providerModels,
            catalogModels,
            modelMap
        )
    }

    private async buildView(agent: Agent): Promise<AgentModelConfigView> {
        const detail = await this.providerDetail(agent)
        const providerModels = await this.providerModels(agent, detail)
        const storedConfig = this.configFromAgent(agent)
        const geminiGateway =
            agent.framework === 'gemini-cli' &&
            isGeminiGatewayBaseUrl(providerModels.baseUrl)
        const config = this.effectiveConfigFromAgent(
            agent,
            providerModels,
            storedConfig,
            geminiGateway ? await this.geminiCatalogModelKeys() : undefined
        )
        const source = this.configSourceFromAgent(agent)
        const availableSources = this.availableSourcesForAgent(agent)
        const runtimeLocal = this.runtimeLocalConfigFromAgent(agent)
        const options = isFrameworkModelConfigurable(agent.framework)
            ? await this.resolveOptionsForFramework(
                  agent.framework,
                  providerModels.models,
                  config?.framework === 'claude-code'
                      ? config.modelMap
                      : undefined,
                  geminiGateway
              )
            : []
        const codexFastModelKeys = isFrameworkModelConfigurable(agent.framework)
            ? new Set(
                  (
                      await this.catalog.listModels(agent.framework, {
                          activeOnly: true
                      })
                  )
                      .filter((m) => m.capabilities?.fast === true)
                      .map((m) => m.modelKey)
              )
            : new Set<string>()
        const validation = this.validateView({
            agent,
            config,
            providerModels,
            options,
            codexFastModelKeys,
            runtimeLocal
        })
        return {
            agentId: agent.id,
            framework: agent.framework,
            source,
            availableSources,
            provider: detail.provider,
            providerBaseUrl: detail.baseUrl,
            providerModelsStatus: providerModels.status,
            providerModelsSource: providerModels.source,
            providerModels: providerModels.models,
            runtimeLocal,
            config,
            options,
            validation
        }
    }

    private effectiveConfigFromAgent(
        agent: Agent,
        providerModels: ProviderModelsState,
        storedConfig: AgentModelConfig | null,
        geminiCatalogKeys?: Set<string>
    ): AgentModelConfig | null {
        if (
            agent.framework === 'claude-code' &&
            providerModels.status === 'ready'
        ) {
            return buildClaudeCodeDefaultModelConfig(
                providerModels.models,
                storedConfig?.framework === 'claude-code' ? storedConfig : null
            )
        }
        if (
            agent.framework === 'gemini-cli' &&
            providerModels.status === 'ready'
        ) {
            const stored =
                storedConfig?.framework === 'gemini-cli' ? storedConfig : null
            const model =
                resolveGeminiProviderModel(
                    stored?.model ?? geminiAutoModelKey,
                    providerModels.models
                ) ?? geminiAutoModelKey
            if (
                isGeminiAutoModel(model) &&
                isGeminiGatewayBaseUrl(providerModels.baseUrl)
            ) {
                const fallback = pickGeminiGatewayDefaultModel(
                    providerModels.models,
                    geminiCatalogKeys ?? new Set()
                )
                if (fallback)
                    return { framework: 'gemini-cli', model: fallback }
            }
            return {
                framework: 'gemini-cli',
                model
            }
        }
        return storedConfig
    }

    private validateView(input: {
        agent: Agent
        config: AgentModelConfig | null
        providerModels: ProviderModelsState
        options: AgentModelConfigView['options']
        codexFastModelKeys: Set<string>
        runtimeLocal: AgentRuntimeLocalModelConfigStatus | null
    }): AgentModelConfigView['validation'] {
        const {
            agent,
            config,
            providerModels,
            options,
            codexFastModelKeys,
            runtimeLocal
        } = input
        const messages: string[] = []
        if (!isFrameworkModelConfigurable(agent.framework)) {
            return { valid: true, messages }
        }
        if (this.configSourceFromAgent(agent) === 'runtime-local') {
            // An agent nobody has inspected yet stays valid: the turn-time gate
            // inspects before it refuses, so blocking here would only punish
            // users for not having clicked refresh.
            if (!runtimeLocal?.lastCheckedAt || runtimeLocal.ready)
                return { valid: true, messages }
            messages.push(
                runtimeLocal.error ?? 'Runtime local config is not ready'
            )
            return { valid: false, messages, cta: 'refresh-runtime-local' }
        }
        if (providerModels.status !== 'ready') {
            messages.push('Test provider before selecting a model.')
            return { valid: false, messages, cta: 'test-provider' }
        }
        if (agent.framework === 'claude-code') {
            if (!config || config.framework !== 'claude-code') {
                messages.push('Configure Claude model mapping.')
                return {
                    valid: false,
                    messages,
                    cta: 'configure-claude-mapping'
                }
            }
            const invalidMapped = Object.entries(config.modelMap ?? {}).find(
                ([alias, providerModel]) =>
                    claudeCodeModelMapAliases.includes(
                        alias as ClaudeCodeModelMapAlias
                    ) &&
                    !!providerModel &&
                    !providerModels.models.includes(providerModel)
            )
            if (invalidMapped)
                messages.push(
                    `Claude ${invalidMapped[0]} mapping is not in the tested provider model list.`
                )
            const active = config.model
                ? options.find((o) => o.value === config.model)
                : null
            if (!config.model || !active?.enabled)
                messages.push('Configure Claude model mapping.')
            return {
                valid: messages.length === 0,
                messages,
                cta:
                    messages.length > 0 ? 'configure-claude-mapping' : undefined
            }
        }
        if (agent.framework === 'codex') {
            if (options.length === 0) {
                messages.push(
                    'The provider model list has no supported Codex models.'
                )
                return {
                    valid: false,
                    messages,
                    cta: 'choose-codex-model'
                }
            }
            if (!config || config.framework !== 'codex' || !config.model) {
                messages.push('Choose a supported Codex model.')
                return {
                    valid: false,
                    messages,
                    cta: 'choose-codex-model'
                }
            }
            if (!options.some((o) => o.value === config.model))
                messages.push('Choose a supported Codex model.')
            const canonical = codexCanonicalModelId(config.model)
            if (
                config.speed === 'fast' &&
                !codexFastModelKeys.has(canonical) &&
                !codexFastModelKeys.has(config.model)
            )
                messages.push(
                    'Codex fast speed requires a model that supports the fast tier.'
                )
            return {
                valid: messages.length === 0,
                messages,
                cta: messages.length > 0 ? 'choose-codex-model' : undefined
            }
        }
        if (agent.framework === 'gemini-cli') {
            if (options.length === 0) {
                messages.push('No Gemini models are configured in the catalog.')
                return { valid: false, messages, cta: 'choose-codex-model' }
            }
            const selected =
                (config?.framework === 'gemini-cli'
                    ? normalizeNullable(config.model)
                    : null) ?? geminiAutoModelKey
            const active = options.find((o) => o.value === selected)
            if (!active?.enabled)
                messages.push('Choose a supported Gemini model.')
            return {
                valid: messages.length === 0,
                messages,
                cta: messages.length > 0 ? 'choose-codex-model' : undefined
            }
        }
        return { valid: true, messages }
    }

    private configFromAgent(agent: Agent): AgentModelConfig | null {
        const extras = safeRecord(agent.extras)
        const storedRaw = asRecord(extras.modelConfig)
        const stored = (storedRaw ?? {}) as ModelConfigExtras
        if (agent.framework === 'claude-code') {
            const raw = asRecord(stored.claudeCode)
            if (!raw) return null
            const effort = normalizeNullable(raw?.effort)
            const model = normalizeNullable(agent.model)
            const modelMap = sanitizeClaudeModelMap(raw?.modelMap)
            return {
                framework: 'claude-code',
                model,
                effort:
                    effort && isClaudeCodeEffort(effort)
                        ? normalizeClaudeCodeEffortForModel(
                              effort,
                              resolveClaudeCodeProviderModel(model, modelMap)
                          )
                        : (effort as ClaudeCodeAgentModelConfig['effort']),
                modelMap
            }
        }
        if (agent.framework === 'codex') {
            const raw = asRecord(stored.codex)
            return {
                framework: 'codex',
                model: normalizeNullable(agent.model),
                speed:
                    (normalizeNullable(raw?.speed) as
                        | CodexAgentModelConfig['speed']
                        | null) ?? 'standard',
                intelligence:
                    (normalizeCodexIntelligence(
                        normalizeNullable(raw?.intelligence)
                    ) as CodexAgentModelConfig['intelligence'] | null) ??
                    'medium'
            }
        }
        if (agent.framework === 'gemini-cli') {
            const raw = asRecord(stored.gemini)
            const storedModel = normalizeNullable(raw?.model)
            return {
                framework: 'gemini-cli',
                model: normalizeNullable(agent.model) ?? storedModel
            }
        }
        return null
    }

    private configSourceFromAgent(agent: Agent): AgentModelConfigSource {
        const extras = safeRecord(agent.extras)
        const stored = (asRecord(extras.modelConfig) ?? {}) as ModelConfigExtras
        if (
            isAgentModelConfigSource(stored.source) &&
            this.availableSourcesForAgent(agent).includes(stored.source)
        )
            return stored.source
        return defaultModelConfigSource(agent)
    }

    private resolveIncomingSource(
        agent: Agent,
        value: unknown
    ): AgentModelConfigSource {
        const source =
            value === undefined || value === null
                ? this.configSourceFromAgent(agent)
                : isAgentModelConfigSource(value)
                  ? value
                  : null
        if (!source)
            throw new BadRequestException(
                `modelConfigSource must be one of ${agentModelConfigSources.join(
                    ', '
                )}`
            )
        if (!this.availableSourcesForAgent(agent).includes(source))
            throw new BadRequestException(
                `${source} model config source is not available for runtime ${agent.runtime}`
            )
        return source
    }

    private availableSourcesForAgent(agent: Agent): AgentModelConfigSource[] {
        if (!isFrameworkModelConfigurable(agent.framework)) return []
        return ['platform', 'runtime-local']
    }

    private runtimeLocalConfigFromAgent(
        agent: Agent
    ): AgentRuntimeLocalModelConfigStatus | null {
        const cached = readRuntimeLocalModelConfigCache(agent.extras)
        if (!cached)
            return {
                available: true,
                ready: false,
                source: null,
                framework: agent.framework,
                cliVersion: null,
                credentialReady: null,
                credentialStatus: 'unknown',
                credentialReason: 'not-reported',
                configReadable: null,
                current: null,
                models: [],
                aliases: [],
                speeds: [],
                intelligence: [],
                lastCheckedAt: null,
                error: null
            }
        // A cached `ready: true` is only as good as the token it was computed
        // from, so expiry is re-derived here instead of at inspect time: a
        // snapshot taken an hour ago must not keep claiming a live token.
        const evaluated = runtimeLocalCredentialStatus(
            cached.credentialFacts,
            Date.now()
        )
        const usable = isRuntimeLocalCredentialUsable(evaluated.status)
        return {
            ...cached,
            ready: cached.ready && usable,
            credentialStatus: evaluated.status,
            credentialReason: evaluated.reason,
            error:
                cached.error ??
                (usable
                    ? null
                    : credentialStatusMessage(
                          agent.framework,
                          evaluated.status
                      ))
        }
    }

    private async providerModels(
        agent: Agent,
        detail?: ProviderDetail
    ): Promise<ProviderModelsState> {
        const providerDetail = detail ?? (await this.providerDetail(agent))
        if (!providerDetail.provider || !providerDetail.apiKey)
            return {
                provider: providerDetail.provider,
                baseUrl: providerDetail.baseUrl,
                status: 'unsupported',
                source: null,
                models: []
            }
        const saved = await this.modelProviders.findByApiKey({
            userId: agent.userId,
            apiKey: providerDetail.apiKey
        })
        const savedModelsForProtocol = saved
            ? providerModelIdsForProtocol(
                  saved.lastTestModels,
                  saved.enabledModels,
                  providerDetail.inferenceProtocol
              )
            : null
        if (savedModelsForProtocol !== null) {
            return {
                provider: providerDetail.provider,
                baseUrl: providerDetail.baseUrl,
                status: 'ready',
                source: 'saved-provider',
                models: savedModelsForProtocol
            }
        }
        const cached = readProviderModelsCache(agent.extras)
        if (
            cached &&
            cached.provider === providerDetail.provider &&
            normalizeNullable(cached.baseUrl) ===
                normalizeNullable(providerDetail.baseUrl) &&
            cached.models.length > 0
        ) {
            return {
                provider: providerDetail.provider,
                baseUrl: providerDetail.baseUrl,
                status: 'ready',
                source: cached.source,
                models: uniqueTrimmedModelIds(cached.models)
            }
        }
        return {
            provider: providerDetail.provider,
            baseUrl: providerDetail.baseUrl,
            status: 'needs_refresh',
            source: null,
            models: []
        }
    }

    private async providerModelsForPlatformValidation(
        agent: Agent
    ): Promise<ProviderModelsState> {
        return this.providerModels(agent)
    }

    private async refreshRuntimeLocalModelCapability(
        agent: Agent
    ): Promise<RefreshAgentModelConfigModelsResponse> {
        const source = runtimeLocalCacheSource(agent.runtime)
        let capability: DaemonFrameworkModelCapability
        try {
            capability =
                agent.runtime === 'daemon'
                    ? await this.inspectDaemonModelCapability(agent)
                    : await this.inspectExecRuntimeModelCapability(agent)
        } catch (err) {
            capability = {
                framework:
                    agent.framework as DaemonFrameworkModelCapability['framework'],
                cliVersion: null,
                ready: false,
                credentialReady: false,
                configReadable: false,
                current: null,
                models: [],
                aliases: [],
                speeds: [],
                intelligence: [],
                lastCheckedAt: new Date().toISOString(),
                error: (err as Error).message
            }
        }
        return this.persistRuntimeLocalModelCapability(
            agent,
            capability,
            source
        )
    }

    private async inspectDaemonModelCapability(
        agent: Agent
    ): Promise<DaemonFrameworkModelCapability> {
        if (!this.daemonRegistry)
            throw new BadRequestException('daemon RPC is unavailable')
        const daemonId = await this.daemonIdForAgent(agent)
        if (!daemonId)
            throw new BadRequestException('daemon agent is not connected')

        const payload = await this.daemonRegistry.rpc({
            daemonId,
            method: 'model.inspect',
            payload: { framework: agent.framework },
            timeoutMs: 15_000
        })
        const inspect = payload as unknown as DaemonModelInspectResponse
        const capability = inspect?.frameworks?.find(
            (item) => item.framework === agent.framework
        )
        if (!capability)
            throw new BadRequestException(
                `daemon did not report model capability for ${agent.framework}`
            )
        return capability
    }

    private async inspectExecRuntimeModelCapability(
        agent: Agent
    ): Promise<DaemonFrameworkModelCapability> {
        if (!this.execDrivers)
            throw new BadRequestException('runtime exec is unavailable')
        const handle = await this.execDrivers.forAgent(agent.id)
        const inspectCatalog = await this.buildRuntimeInspectCatalog()
        const stream = handle.driver.stream({
            cmd: [
                'bash',
                '-c',
                runtimeInspectScript(agent.framework, inspectCatalog)
            ],
            timeoutMs: 15_000
        })
        const [stdout, stderr, result] = await Promise.all([
            collectText(stream.stdout),
            collectText(stream.stderr),
            stream.result
        ])
        if (result.exitCode !== 0)
            throw new BadRequestException(
                stderr.trim() ||
                    result.stderr?.trim() ||
                    `runtime inspect exited with code ${result.exitCode}`
            )
        const json = lastJsonLine(stdout)
        if (!json)
            throw new BadRequestException('runtime inspect returned no JSON')
        const parsed = JSON.parse(json) as DaemonModelInspectResponse
        const capability = parsed.frameworks?.find(
            (item) => item.framework === agent.framework
        )
        if (!capability)
            throw new BadRequestException(
                `runtime did not report model capability for ${agent.framework}`
            )
        return capability
    }

    private async persistRuntimeLocalModelCapability(
        agent: Agent,
        capability: DaemonFrameworkModelCapability,
        source: AgentRuntimeLocalModelConfigSource
    ): Promise<RefreshAgentModelConfigModelsResponse> {
        const models = uniqueTrimmedModelIds(capability.models ?? [])
        const checkedAt =
            normalizeNullable(capability.lastCheckedAt) ??
            new Date().toISOString()
        const now = Date.now()
        const credentialFacts =
            parseRuntimeLocalCredentialFacts(capability.credentialFacts) ?? null
        const evaluated = runtimeLocalCredentialStatus(credentialFacts, now)
        const ready = runtimeLocalReady(agent.framework, capability, now)
        const error =
            normalizeNullable(capability.error) ??
            (ready
                ? null
                : runtimeLocalNotReadyMessage(agent.framework, capability, now))
        const runtimeLocal: RuntimeLocalModelConfigCache = {
            available: true,
            ready,
            source,
            framework: agent.framework,
            cliVersion: normalizeNullable(capability.cliVersion),
            credentialReady:
                typeof capability.credentialReady === 'boolean'
                    ? capability.credentialReady
                    : null,
            credentialStatus: evaluated.status,
            credentialReason: evaluated.reason,
            credentialFacts,
            configReadable: capability.configReadable === true,
            current: normalizeNullable(capability.current),
            models,
            aliases: uniqueTrimmedModelIds(capability.aliases ?? []),
            speeds: uniqueTrimmedModelIds(capability.speeds ?? []),
            intelligence: uniqueTrimmedModelIds(capability.intelligence ?? []),
            lastCheckedAt: checkedAt,
            error
        }
        const nextExtras = {
            runtimeLocalModelConfig: runtimeLocal
        }
        const [updated] = await this.db
            .update(agents)
            .set({
                extras: jsonbMerge(agents.extras, nextExtras),
                updatedAt: new Date()
            })
            .where(eq(agents.id, agent.id))
            .returning()
        return {
            ok: runtimeLocal.ready,
            message: runtimeLocal.error,
            models,
            view: await this.buildView(updated)
        }
    }

    private async daemonIdForAgent(agent: Agent): Promise<string | null> {
        if (agent.daemonId) return agent.daemonId
        if (!agent.runtimeId) return null
        const [runtime] = await this.db
            .select({ daemonId: agentRuntimes.daemonId })
            .from(agentRuntimes)
            .where(eq(agentRuntimes.id, agent.runtimeId))
            .limit(1)
        return runtime?.daemonId ?? null
    }

    private async providerDetail(agent: Agent): Promise<ProviderDetail> {
        if (
            agent.framework !== 'claude-code' &&
            agent.framework !== 'codex' &&
            agent.framework !== 'gemini-cli'
        )
            return {
                provider: null,
                inferenceProtocol: null,
                apiKey: null,
                baseUrl: null
            }
        const [row] = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, agent.runtimeId))
            .limit(1)
        if (!row)
            return {
                provider: null,
                inferenceProtocol: null,
                apiKey: null,
                baseUrl: null
            }
        const plain = this.crypto.decrypt({
            ciphertext: row.payloadCiphertext,
            keyVersion: row.keyVersion
        })
        const parsed = JSON.parse(plain) as Record<string, unknown>
        const storedProtocol = normalizeNullable(
            parsed.inferenceProtocol
        ) as InferenceProtocol | null
        if (agent.framework === 'claude-code') {
            return {
                provider: 'anthropic',
                inferenceProtocol: storedProtocol ?? 'anthropic_messages',
                apiKey: normalizeNullable(parsed.anthropicAuthToken),
                baseUrl: normalizeNullable(parsed.anthropicBaseUrl)
            }
        }
        if (agent.framework === 'codex') {
            return {
                provider: 'openai',
                inferenceProtocol: storedProtocol ?? 'openai_responses',
                apiKey: normalizeNullable(parsed.openaiApiKey),
                baseUrl: normalizeNullable(parsed.openaiBaseUrl)
            }
        }
        return {
            provider: 'google',
            inferenceProtocol: storedProtocol ?? 'google_generate_content',
            apiKey: normalizeNullable(parsed.googleApiKey),
            baseUrl: normalizeNullable(parsed.googleGeminiBaseUrl)
        }
    }

    private async requireAgent(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<Agent> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent || (!isAdmin && agent.userId !== callerUserId))
            throw new NotFoundException(`agent ${agentId} not found`)
        return agent
    }

    private async buildRuntimeInspectCatalog(): Promise<RuntimeInspectCatalog> {
        const [
            claudeAliases,
            codexModels,
            codexSpeeds,
            codexIntelligence,
            geminiModels
        ] = await Promise.all([
            this.catalog.listModels('claude-code', { activeOnly: true }),
            this.catalog.listModels('codex', { activeOnly: true }),
            this.catalog.listEnums('codex', 'speed', { activeOnly: true }),
            this.catalog.listEnums('codex', 'intelligence', {
                activeOnly: true
            }),
            this.catalog.listModels('gemini-cli', { activeOnly: true })
        ])
        return {
            claudeAliases: claudeAliases
                .filter((m) => m.kind === 'alias')
                .map((m) => m.modelKey),
            codexModels: codexModels.map((m) => m.modelKey),
            codexSpeeds: codexSpeeds.map((e) => e.value),
            codexIntelligence: codexIntelligence.map((e) => e.value),
            geminiModels: geminiModels
                .filter((m) => m.kind === 'model')
                .map((m) => m.modelKey),
            geminiAliases: geminiModels
                .filter((m) => m.kind === 'alias')
                .map((m) => m.modelKey)
        }
    }
}

const isFrameworkModelConfigurable = (
    framework: string
): framework is ConfigurableFramework => isConfigurableFramework(framework)

const defaultModelConfigSource = (agent: Agent): AgentModelConfigSource =>
    agent.runtime === 'daemon' ? 'runtime-local' : 'platform'

const runtimeLocalCacheSource = (
    runtime: Agent['runtime']
): AgentRuntimeLocalModelConfigSource => {
    if (runtime === 'daemon') return 'daemon-local'
    if (runtime === 'k8s') return 'k8s-local'
    return 'sprites-local'
}

const runtimeLocalReady = (
    framework: string,
    capability: DaemonFrameworkModelCapability,
    now: number
): boolean => {
    // Facts beat the daemon's own verdict: it reports `ready` from a presence
    // heuristic that cannot see an expired token, and a daemon too old to send
    // facts evaluates to `unknown`, which stays usable.
    if (
        !isRuntimeLocalCredentialUsable(
            runtimeLocalCredentialStatus(
                parseRuntimeLocalCredentialFacts(capability.credentialFacts),
                now
            ).status
        )
    )
        return false
    if (typeof capability.ready === 'boolean')
        return capability.ready && !normalizeNullable(capability.error)
    if (normalizeNullable(capability.error) || !capability.cliVersion)
        return false
    if (framework === 'codex')
        return (
            capability.configReadable === true &&
            capability.credentialReady === true
        )
    return capability.credentialReady === true
}

const frameworkLabel = (framework: string): string =>
    framework === 'claude-code'
        ? 'Claude Code'
        : framework === 'codex'
          ? 'Codex'
          : framework === 'gemini-cli'
            ? 'Gemini CLI'
            : 'Runtime'

const credentialStatusMessage = (
    framework: string,
    status: RuntimeLocalCredentialStatus
): string | null => {
    const label = frameworkLabel(framework)
    if (status === 'expired')
        return `${label} local credentials have expired — sign in again on the runtime host, then refresh`
    if (status === 'missing')
        return `${label} local credentials were not detected`
    return null
}

const runtimeLocalNotReadyMessage = (
    framework: string,
    capability: DaemonFrameworkModelCapability,
    now: number
): string => {
    const credential = credentialStatusMessage(
        framework,
        runtimeLocalCredentialStatus(
            parseRuntimeLocalCredentialFacts(capability.credentialFacts),
            now
        ).status
    )
    if (credential) return credential
    const label = frameworkLabel(framework)
    if (!capability.cliVersion) return `${label} CLI is not available on PATH`
    if (framework === 'codex' && capability.configReadable !== true)
        return 'Codex local config was not detected'
    if (capability.credentialReady !== true)
        return `${label} local credentials were not detected`
    return 'Runtime local config is not ready'
}

const modelFromConfig = (config: AgentModelConfig): string | null => {
    if (config.framework === 'claude-code') return config.model ?? null
    return config.model ?? null
}

const normalizeNullable = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

// `none` was removed from the intelligence enum (no model ever supported it
// and the official model_reasoning_effort enum never had it); agents that
// stored it keep working by degrading to the lowest supported level.
const normalizeCodexIntelligence = (value: string | null): string | null =>
    value === 'none' ? 'low' : value

const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null

const safeRecord = (value: unknown): Record<string, unknown> =>
    asRecord(value) ?? {}

const sanitizeClaudeModelMap = (value: unknown): ClaudeCodeModelMap => {
    const raw = asRecord(value)
    if (!raw) return {}
    const out: ClaudeCodeModelMap = {}
    for (const alias of claudeCodeModelMapAliases) {
        const model = normalizeNullable(raw[alias])
        if (model) out[alias] = model
    }
    return out
}

const claudeConfigsEqual = (
    left: ClaudeCodeAgentModelConfig | null,
    right: ClaudeCodeAgentModelConfig
): boolean => {
    if (!left) return false
    if ((left.model ?? null) !== (right.model ?? null)) return false
    if ((left.effort ?? null) !== (right.effort ?? null)) return false
    const leftMap = left.modelMap ?? {}
    const rightMap = right.modelMap ?? {}
    return claudeCodeModelMapAliases.every(
        (alias) => (leftMap[alias] ?? null) === (rightMap[alias] ?? null)
    )
}

const titleCase = (value: string): string =>
    value.slice(0, 1).toUpperCase() + value.slice(1)

const resolveCodexOptionsFromCatalog = (
    providerModels: readonly string[],
    catalog: readonly FrameworkModelView[]
): AgentModelConfigOption[] => {
    const catalogByKey = new Map(catalog.map((row) => [row.modelKey, row]))
    return uniqueTrimmedModelIds(providerModels)
        .filter((model) => catalogByKey.has(codexCanonicalModelId(model)))
        .map((model): AgentModelConfigOption => {
            const canonical = codexCanonicalModelId(model)
            const row = catalogByKey.get(canonical)
            return {
                value: model,
                label: row?.displayName || model,
                providerModel: model,
                canonicalModel: canonical,
                supportsFast: row?.capabilities?.fast === true,
                enabled: true,
                reason: null
            }
        })
}

const resolveGeminiOptionsFromCatalog = (
    providerModels: readonly string[],
    catalog: readonly FrameworkModelView[],
    gateway: boolean
): AgentModelConfigOption[] => {
    const models = uniqueTrimmedModelIds(providerModels)
    const catalogByKey = new Map(
        catalog
            .filter((row) => row.kind === 'model')
            .map((row) => [row.modelKey, row])
    )
    // Alias rows (`auto`) are CLI routing values, not backend model ids. The
    // CLI router only calls hardcoded gemini-3-* ids, so auto is only offered
    // against the official endpoint, never a gateway.
    const aliasOptions = gateway
        ? []
        : catalog
              .filter((row) => row.kind === 'alias')
              .map(
                  (row): AgentModelConfigOption => ({
                      value: row.modelKey,
                      label: row.displayName,
                      providerModel: null,
                      canonicalModel: row.modelKey,
                      enabled: true,
                      reason: null
                  })
              )
    if (models.length === 0) {
        // Discovery has not run: keep the catalog rows visible as disabled
        // placeholders so the picker explains what to do next.
        const placeholders = catalog
            .filter((row) => row.kind === 'model')
            .map(
                (row): AgentModelConfigOption => ({
                    value: row.modelKey,
                    label: row.displayName,
                    providerModel: null,
                    canonicalModel: row.modelKey,
                    enabled: false,
                    reason: 'Test provider to discover supported models'
                })
            )
        return [...aliasOptions, ...placeholders]
    }
    // The tested provider list is the source of truth: every discovered model
    // is selectable with the provider's exact id as the wire value. Canonical
    // matches borrow the catalog display name and float to the top in catalog
    // order; the rest keep discovery order under their native id.
    const catalogOrder = [...catalogByKey.keys()]
    const matched: Array<{ option: AgentModelConfigOption; rank: number }> = []
    const unmatched: AgentModelConfigOption[] = []
    for (const model of models) {
        const canonical = geminiCanonicalModelId(model)
        const row = catalogByKey.get(canonical)
        const option: AgentModelConfigOption = {
            value: model,
            label: row
                ? row.modelKey === model
                    ? row.displayName
                    : `${row.displayName} · ${model}`
                : model,
            providerModel: model,
            canonicalModel: canonical,
            enabled: true,
            reason: null
        }
        if (row)
            matched.push({ option, rank: catalogOrder.indexOf(row.modelKey) })
        else unmatched.push(option)
    }
    matched.sort((a, b) => a.rank - b.rank)
    return [...aliasOptions, ...matched.map((m) => m.option), ...unmatched]
}

const resolveClaudeOptionsFromCatalog = (
    providerModels: readonly string[],
    catalog: readonly FrameworkModelView[],
    modelMap: ClaudeCodeModelMap | undefined
): AgentModelConfigOption[] => {
    const aliasRows = catalog.filter((row) => row.kind === 'alias')
    const models = uniqueTrimmedModelIds(providerModels)
    const providerSet = new Set(models)
    const mappedProviderModels = new Set<string>()
    const aliasOptions = aliasRows.map((row): AgentModelConfigOption => {
        const mapAlias = claudeCodeModelAliasMapKey(
            row.modelKey as ClaudeCodeModelMapAlias
        )
        const providerModel = modelMap?.[mapAlias]?.trim() || null
        if (providerModel) mappedProviderModels.add(providerModel)
        const enabled = !!providerModel && providerSet.has(providerModel)
        return {
            value: row.modelKey,
            label: providerModel
                ? `${row.displayName} · ${providerModel}`
                : `${row.displayName} · not mapped`,
            providerModel,
            canonicalModel: mapAlias,
            enabled,
            reason: enabled
                ? null
                : `Map ${titleCase(mapAlias)} to a tested provider model`
        }
    })
    const versionOptions = models
        .filter((model) => !mappedProviderModels.has(model))
        .flatMap((model): AgentModelConfigOption[] => {
            const mapAlias = claudeCodeModelSelectionMapKey(model)
            if (!mapAlias) return []
            const isOneMillion = isClaudeCodeOneMillionModelAlias(model)
            return [
                {
                    value: model,
                    label: `${titleCase(mapAlias)}${isOneMillion ? ' 1M' : ''} · ${model}`,
                    providerModel: model,
                    canonicalModel: mapAlias,
                    enabled: true,
                    reason: null
                }
            ]
        })
    return [...aliasOptions, ...versionOptions]
}

const collectText = async (stream: AsyncIterable<string>): Promise<string> => {
    let out = ''
    for await (const chunk of stream) out += chunk
    return out
}

const lastJsonLine = (text: string): string | null => {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i]?.startsWith('{')) return lines[i] ?? null
    }
    return null
}

interface RuntimeInspectCatalog {
    claudeAliases: string[]
    codexModels: string[]
    codexSpeeds: string[]
    codexIntelligence: string[]
    geminiModels: string[]
    geminiAliases: string[]
}

// Exported so a test can execute the emitted script against fixture homes: it
// is a hand-mirrored copy of the daemon's inspectors (apps/cli/src/daemon/
// rpc.ts) and nothing else would catch the two drifting apart.
export const runtimeInspectScript = (
    framework: string,
    catalog: RuntimeInspectCatalog
): string => {
    const nodeScript = `
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const framework = ${JSON.stringify(framework)}
const claudeAliases = ${JSON.stringify(catalog.claudeAliases)}
const claudeModelCatalog = ${JSON.stringify([...claudeLocalModelCatalog])}
const codexModelCatalog = ${JSON.stringify(catalog.codexModels)}
const codexSpeeds = ${JSON.stringify(catalog.codexSpeeds)}
const codexIntelligence = ${JSON.stringify(catalog.codexIntelligence)}
const geminiModelCatalog = ${JSON.stringify(catalog.geminiModels)}
const geminiAliases = ${JSON.stringify(catalog.geminiAliases)}
const home = os.homedir()
const unique = (items) => {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const value = typeof item === 'string' ? item.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
const commandVersion = (cmd) => {
  try {
    return cp.execFileSync(cmd, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    }).trim() || null
  } catch {
    return null
  }
}
const readable = (target) => {
  try {
    fs.accessSync(target, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}
const readText = (target) => {
  try {
    return { ok: true, text: fs.readFileSync(target, 'utf8'), error: null }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, text: null, error: null }
    return { ok: false, text: null, error: err && err.message ? err.message : String(err) }
  }
}
const tomlString = (text, key) => {
  const dq = new RegExp('^\\\\s*' + key + '\\\\s*=\\\\s*"([^"]*)"', 'm').exec(text)
  if (dq && dq[1]) return dq[1].trim()
  const sq = new RegExp('^\\\\s*' + key + "\\\\s*=\\\\s*'([^']*)'", 'm').exec(text)
  return sq && sq[1] ? sq[1].trim() : null
}
const codexHomeDir = () => {
  const raw = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
  return raw ? path.resolve(raw.replace(/^~/, home)) : path.join(home, '.codex')
}
const parseJson = (text) => {
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
const nested = (record, key) => {
  const value = record ? record[key] : null
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const jwtExpiryMs = (value) => {
  if (typeof value !== 'string') return null
  const part = value.split('.')[1]
  if (!part) return null
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const exp = JSON.parse(json).exp
    return typeof exp === 'number' && isFinite(exp) ? Math.round(exp * 1000) : null
  } catch {
    return null
  }
}
const tomlScalar = (raw) => {
  const withoutComment = raw.replace(/\\s+#.*$/, '').trim()
  const quoted = /^["']([^"']*)["']$/.exec(withoutComment)
  return (quoted ? quoted[1] : withoutComment).trim()
}
const scanCodexConfig = (text) => {
  const scan = { activeProvider: null, providers: [], profileModels: [] }
  if (!text) return scan
  const providers = new Map()
  let section = null
  for (const rawLine of text.split(/\\r?\\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\\[+([^\\]]+)\\]+$/.exec(line)
    if (header) {
      section = header[1].trim()
      if (section.indexOf('model_providers.') === 0)
        providers.set(tomlScalar(section.slice('model_providers.'.length)), {})
      continue
    }
    const pair = /^([A-Za-z0-9_.-]+)\\s*=\\s*(.+)$/.exec(line)
    if (!pair) continue
    const key = pair[1]
    const value = tomlScalar(pair[2])
    if (section === null) {
      if (key === 'model_provider') scan.activeProvider = value || null
      continue
    }
    if (section.indexOf('model_providers.') === 0) {
      const id = tomlScalar(section.slice('model_providers.'.length))
      const entry = providers.get(id)
      if (entry) entry[key] = value
      continue
    }
    if (section.indexOf('profiles.') === 0 && key === 'model' && value)
      scan.profileModels.push(value)
  }
  for (const entry of providers) {
    const id = entry[0]
    const values = entry[1]
    const envKey = values.env_key || null
    scan.providers.push({
      id,
      hasBaseUrl: Boolean(values.base_url),
      envKey,
      envKeyPresent: Boolean(envKey && process.env[envKey] && process.env[envKey].trim()),
      requiresOpenaiAuth: values.requires_openai_auth === 'true'
    })
  }
  return scan
}
const codexAuthSummary = (text) => {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    const apiKey = typeof parsed.OPENAI_API_KEY === 'string'
      ? parsed.OPENAI_API_KEY.trim()
      : typeof parsed.openaiApiKey === 'string'
        ? parsed.openaiApiKey.trim()
        : ''
    if (apiKey) return 'auth.json API key'
    const tokens = parsed && typeof parsed.tokens === 'object' ? parsed.tokens : null
    const hasToken = Boolean(tokens && ['id_token', 'access_token', 'refresh_token'].some((key) => typeof tokens[key] === 'string' && tokens[key].trim().length > 0))
    if (hasToken) return 'auth.json token auth'
    return 'auth.json readable'
  } catch {
    return 'auth.json readable'
  }
}
const now = new Date().toISOString()
let capability
if (framework === 'claude-code') {
  const cliVersion = commandVersion('claude')
  const configReadable = readable(path.join(home, '.claude')) || readable(path.join(home, '.claude.json'))
  const credentialReady = Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || configReadable)
  const mapped = [
    process.env.ANTHROPIC_DEFAULT_FABLE_MODEL,
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  ]
  const current = unique(mapped).join(' / ') || null
  const error = cliVersion
    ? (credentialReady ? null : 'Claude Code local credentials were not detected')
    : 'claude CLI is not available on PATH'
  const claudeCredentials = parseJson(readText(path.join(home, '.claude', '.credentials.json')).text)
  const claudeOauth = nested(claudeCredentials, 'claudeAiOauth') || nested(claudeCredentials, 'oauthAccount')
  const claudeJson = parseJson(readText(path.join(home, '.claude.json')).text)
  capability = {
    framework,
    cliVersion,
    ready: Boolean(cliVersion && credentialReady),
    credentialReady,
    credentialFacts: {
      framework: 'claude-code',
      envToken: Boolean(
        (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_AUTH_TOKEN.trim()) ||
        (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim())
      ),
      credentialsFileParsed: claudeCredentials !== null,
      oauthExpiresAt: claudeOauth && typeof claudeOauth.expiresAt === 'number' ? claudeOauth.expiresAt : null,
      hasRefreshToken: Boolean(claudeOauth && nonEmpty(claudeOauth.refreshToken)),
      oauthAccount: nested(claudeJson, 'oauthAccount') !== null,
      configPresent: configReadable
    },
    configReadable,
    current,
    models: unique([...mapped, ...claudeModelCatalog]),
    aliases: claudeAliases,
    speeds: [],
    intelligence: [],
    lastCheckedAt: now,
    error
  }
} else if (framework === 'codex') {
  const cliVersion = commandVersion('codex')
  const codexHome = codexHomeDir()
  const config = readText(path.join(codexHome, 'config.toml'))
  const auth = readText(path.join(codexHome, 'auth.json'))
  const model = config.text ? tomlString(config.text, 'model') : null
  const intelligence = config.text ? tomlString(config.text, 'model_reasoning_effort') : null
  const speed = config.text ? tomlString(config.text, 'service_tier') : null
  const requiresOpenAiAuth = Boolean(config.text && /^\\s*requires_openai_auth\\s*=\\s*true\\s*$/m.test(config.text))
  const authSummary = auth.ok ? codexAuthSummary(auth.text) : null
  const envCredentialReady = Boolean(process.env.OPENAI_API_KEY && !requiresOpenAiAuth)
  const credentialReady = Boolean(authSummary || envCredentialReady)
  const codexScan = scanCodexConfig(config.text)
  const codexAuth = parseJson(auth.text)
  const codexTokens = nested(codexAuth, 'tokens')
  const current = unique([model, speed === 'fast' ? 'fast' : null, intelligence, authSummary, envCredentialReady ? 'OPENAI_API_KEY env' : null]).join(' · ') || null
  const error = config.error || auth.error || (cliVersion
    ? (config.ok
        ? (credentialReady ? null : 'Codex local credentials were not detected in ' + path.join(codexHome, 'auth.json'))
        : 'Codex local config was not detected')
    : 'codex CLI is not available on PATH')
  capability = {
    framework,
    cliVersion,
    ready: Boolean(cliVersion && config.ok && credentialReady && !error),
    credentialReady,
    credentialFacts: {
      framework: 'codex',
      authFilePresent: auth.ok,
      authFileParsed: codexAuth !== null,
      apiKeyPresent: Boolean(codexAuth && (nonEmpty(codexAuth.OPENAI_API_KEY) || nonEmpty(codexAuth.openaiApiKey))),
      envApiKey: envCredentialReady,
      hasAccessToken: Boolean(codexTokens && nonEmpty(codexTokens.access_token)),
      hasRefreshToken: Boolean(codexTokens && nonEmpty(codexTokens.refresh_token)),
      accessTokenExp: codexTokens ? jwtExpiryMs(codexTokens.access_token) : null,
      lastRefresh: codexAuth && typeof codexAuth.last_refresh === 'string' ? codexAuth.last_refresh : null,
      customProviders: codexScan.providers,
      activeProvider: codexScan.activeProvider
    },
    configReadable: config.ok,
    current,
    models: unique([model, ...codexScan.profileModels, ...codexModelCatalog]),
    aliases: [],
    speeds: codexSpeeds,
    intelligence: codexIntelligence,
    lastCheckedAt: now,
    error
  }
} else {
  const cliVersion = commandVersion('gemini')
  const geminiHome = path.join(home, '.gemini')
  const settingsPath = path.join(geminiHome, 'settings.json')
  const oauthPath = path.join(geminiHome, 'oauth_creds.json')
  const settings = readText(settingsPath)
  const settingsParsed = (() => {
    if (!settings.ok || !settings.text) return null
    try { return JSON.parse(settings.text) } catch { return null }
  })()
  const settingsModel = (() => {
    if (!settingsParsed) return null
    const raw = settingsParsed.model
    if (typeof raw === 'string') return raw.trim() || null
    if (raw && typeof raw === 'object' && typeof raw.name === 'string') return raw.name.trim() || null
    return null
  })()
  const settingsApiKey = settingsParsed && typeof settingsParsed.apiKey === 'string'
    ? settingsParsed.apiKey.trim()
    : null
  const oauth = readText(oauthPath)
  const geminiOauth = parseJson(oauth.text)
  const envApiKey = (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim())
    || (process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY.trim())
    || (process.env.GOOGLE_GEMINI_API_KEY && process.env.GOOGLE_GEMINI_API_KEY.trim())
    || ''
  const credentialReady = Boolean(envApiKey || settingsApiKey || oauth.ok)
  const configReadable = readable(geminiHome) || settings.ok
  const envBaseUrl = (process.env.GOOGLE_GEMINI_BASE_URL && process.env.GOOGLE_GEMINI_BASE_URL.trim())
    || (process.env.GEMINI_BASE_URL && process.env.GEMINI_BASE_URL.trim())
    || null
  const envModel = (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) || null
  const credentialSummary = envApiKey
    ? 'GEMINI_API_KEY env'
    : settingsApiKey
      ? 'settings.json apiKey'
      : oauth.ok
        ? 'oauth_creds.json'
        : null
  const current = unique([envModel, settingsModel, envBaseUrl, credentialSummary]).join(' · ') || null
  const error = settings.error || oauth.error || (cliVersion
    ? (credentialReady
        ? null
        : 'Gemini CLI local credentials were not detected (set GEMINI_API_KEY or run gemini auth)')
    : 'gemini CLI is not available on PATH')
  capability = {
    framework,
    cliVersion,
    ready: Boolean(cliVersion && credentialReady && !error),
    credentialReady,
    credentialFacts: {
      framework: 'gemini-cli',
      envApiKey: Boolean(envApiKey),
      settingsApiKey: Boolean(settingsApiKey),
      oauthFilePresent: oauth.ok,
      oauthFileParsed: geminiOauth !== null,
      oauthExpiryDate: geminiOauth && typeof geminiOauth.expiry_date === 'number' ? geminiOauth.expiry_date : null,
      hasRefreshToken: Boolean(geminiOauth && nonEmpty(geminiOauth.refresh_token))
    },
    configReadable,
    current,
    models: unique([envModel, settingsModel, ...geminiModelCatalog]),
    aliases: geminiAliases,
    speeds: [],
    intelligence: [],
    lastCheckedAt: now,
    error
  }
}
console.log(JSON.stringify({ frameworks: [capability] }))
`
    return `node <<'MF_MODEL_INSPECT_NODE'\n${nodeScript}\nMF_MODEL_INSPECT_NODE`
}

const readProviderModelsCache = (
    extras: unknown
): AgentModelProviderModelsCache | null => {
    const raw = asRecord(safeRecord(extras).modelProviderModels)
    if (!raw) return null
    const provider = normalizeNullable(raw.provider) as UserModelProvider | null
    const baseUrl = normalizeNullable(raw.baseUrl)
    const models = Array.isArray(raw.models)
        ? uniqueTrimmedModelIds(
              raw.models.filter((m): m is string => typeof m === 'string')
          )
        : []
    const testedAt = normalizeNullable(raw.testedAt)
    const sourceRaw = normalizeNullable(raw.source)
    const source =
        sourceRaw === 'saved-provider' ||
        sourceRaw === 'agent-refresh' ||
        sourceRaw === 'inline-test' ||
        sourceRaw === 'daemon-local'
            ? sourceRaw
            : 'agent-refresh'
    if (!testedAt || models.length === 0) return null
    return { provider, baseUrl, models, testedAt, source }
}

const readRuntimeLocalModelConfigCache = (
    extras: unknown
): RuntimeLocalModelConfigCache | null => {
    const raw = asRecord(safeRecord(extras).runtimeLocalModelConfig)
    if (!raw) return null
    const source = normalizeNullable(raw.source)
    if (
        source !== 'daemon-local' &&
        source !== 'sprites-local' &&
        source !== 'k8s-local'
    )
        return null
    const framework = normalizeNullable(raw.framework)
    const lastCheckedAt = normalizeNullable(raw.lastCheckedAt)
    if (!framework || !lastCheckedAt) return null
    return {
        available: raw.available !== false,
        ready: raw.ready === true,
        source,
        framework: framework as RuntimeLocalModelConfigCache['framework'],
        cliVersion: normalizeNullable(raw.cliVersion),
        credentialReady:
            typeof raw.credentialReady === 'boolean'
                ? raw.credentialReady
                : null,
        credentialStatus: 'unknown',
        credentialReason: 'not-reported',
        credentialFacts: parseRuntimeLocalCredentialFacts(raw.credentialFacts),
        configReadable:
            typeof raw.configReadable === 'boolean' ? raw.configReadable : null,
        current: normalizeNullable(raw.current),
        models: Array.isArray(raw.models)
            ? uniqueTrimmedModelIds(
                  raw.models.filter((m): m is string => typeof m === 'string')
              )
            : [],
        aliases: Array.isArray(raw.aliases)
            ? uniqueTrimmedModelIds(
                  raw.aliases.filter((m): m is string => typeof m === 'string')
              )
            : [],
        speeds: Array.isArray(raw.speeds)
            ? uniqueTrimmedModelIds(
                  raw.speeds.filter((m): m is string => typeof m === 'string')
              )
            : [],
        intelligence: Array.isArray(raw.intelligence)
            ? uniqueTrimmedModelIds(
                  raw.intelligence.filter(
                      (m): m is string => typeof m === 'string'
                  )
              )
            : [],
        lastCheckedAt,
        error: normalizeNullable(raw.error)
    }
}
