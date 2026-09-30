import {
    buildClaudeCodeDefaultModelConfig,
    claudeCodeModelAliasMapKey,
    claudeCodeModelAliases,
    claudeCodeModelSelectionMapKey,
    type AgentModelConfigOption,
    type AgentModelConfigView,
    type ClaudeCodeModelMap
} from '@manyfold/shared'

// A Claude Code agent's model settings on a provider as the API returns
// them: options labelled by id (`opus · claude-opus-5-5`), in the order the
// provider listed its models, every family's versions included. The mapping
// is the default one unless given.
export const claudeSettings = (
    agentId: string,
    models: readonly string[],
    model: string | null,
    modelMap: ClaudeCodeModelMap = buildClaudeCodeDefaultModelConfig(models)
        .modelMap ?? {}
): AgentModelConfigView => {
    const mapped = new Set(Object.values(modelMap))
    const aliases = claudeCodeModelAliases.map(
        (alias): AgentModelConfigOption => {
            const family = claudeCodeModelAliasMapKey(alias)
            const providerModel = modelMap[family] ?? null
            return {
                value: alias,
                label: `${alias} · ${providerModel ?? 'not mapped'}`,
                providerModel,
                canonicalModel: family,
                enabled:
                    providerModel !== null && models.includes(providerModel)
            }
        }
    )
    const versions = models
        .filter((id) => !mapped.has(id))
        .flatMap((id): AgentModelConfigOption[] => {
            const family = claudeCodeModelSelectionMapKey(id)
            return family
                ? [
                      {
                          value: id,
                          label: `${family} · ${id}`,
                          providerModel: id,
                          canonicalModel: family,
                          enabled: true
                      }
                  ]
                : []
        })
    return {
        agentId,
        framework: 'claude-code',
        source: 'platform',
        providerModels: [...models],
        runtimeLocal: null,
        config: { framework: 'claude-code', model, modelMap },
        options: [...aliases, ...versions]
    } as AgentModelConfigView
}
