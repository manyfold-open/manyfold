import {
    buildClaudeCodeDefaultModelConfig,
    claudeCodeModelSelectionMapKey,
    codexModelDisplayName,
    isClaudeCodeModelAlias,
    resolveClaudeCodeModelOptions,
    resolveCodexModelOptions,
    testedModelsFor,
    type AgentFramework,
    type AgentModelConfigView,
    type ClaudeCodeModelMap,
    type UserModelProviderSummary
} from '@manyfold/shared'
import { UsageError } from '@/usage-error'

// The models `--model` can name, read the same way wherever it is given:
// `mf agent create` against what a provider was tested with, `mf agent
// update` and `mf model-config update` against an agent's model settings.

// An alias follows its family's newest listed model (`providerModel` is the
// id it stands for today, where that is known); anything else pins one id.
export interface ModelOption {
    value: string
    label: string
    providerModel: string | null
    family: string | null
    alias: boolean
}

// Claude Code's mapped aliases and the versions beside them, labelled by
// name (`Opus 5.5`) and newest first within each family.
const claudeOptions = (
    models: readonly string[],
    modelMap: ClaudeCodeModelMap | undefined
): ModelOption[] =>
    resolveClaudeCodeModelOptions(models, modelMap)
        .filter((option) => option.enabled)
        .map((option) => ({
            value: option.value,
            label: option.label,
            providerModel: option.providerModel ?? null,
            family: option.canonicalModel ?? null,
            alias: isClaudeCodeModelAlias(option.value)
        }))

// What `--model` accepts from this row: Claude Code's mapped aliases and the
// tested versions beside them, Codex's own models among the tested ones, the
// tested list for Gemini CLI and pi. Null for Antigravity CLI, which names
// models by slugs no provider test lists.
export const modelOptionsFor = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): ModelOption[] | null => {
    const tested = testedModelsFor(framework, row)
    if (framework === 'claude-code')
        return claudeOptions(
            tested,
            buildClaudeCodeDefaultModelConfig(tested).modelMap
        )
    if (framework === 'codex')
        return resolveCodexModelOptions(tested).map((option) => ({
            value: option.value,
            label: codexModelDisplayName(option.value) ?? option.value,
            providerModel: option.value,
            family: null,
            alias: false
        }))
    if (framework === 'antigravity-cli') return null
    return tested.map((id) => ({
        value: id,
        label: id,
        providerModel: id,
        family: null,
        alias: false
    }))
}

// What an agent's model settings offer: the options the API lists for its
// provider's models, or on a sign-in the aliases and models the machine's
// CLI reported.
export const modelOptionsFromView = (
    view: AgentModelConfigView
): ModelOption[] => {
    const claude = view.framework === 'claude-code'
    if (view.source === 'runtime-local') {
        const local = view.runtimeLocal
        const values = new Set(
            [...(local?.aliases ?? []), ...(local?.models ?? [])]
                .map((value) => value.trim())
                .filter(Boolean)
        )
        return [...values].map((value) => ({
            value,
            label: value,
            providerModel: null,
            family: claude ? claudeCodeModelSelectionMapKey(value) : null,
            alias: claude && isClaudeCodeModelAlias(value)
        }))
    }
    const listed = view.options
        .filter((option) => option.enabled)
        .map((option) => ({
            value: option.value,
            label: option.label,
            providerModel: option.providerModel ?? null,
            // Codex's canonicalModel is its id without a vendor prefix, not
            // a family.
            family: claude ? (option.canonicalModel ?? null) : null,
            alias: claude && isClaudeCodeModelAlias(option.value)
        }))
    if (!claude) return listed
    // The API labels Claude options by id (`Opus · claude-opus-5-5`) in the
    // order the provider listed its models. They are read and listed here as
    // on a create, by name and newest first; anything else the API lists
    // follows.
    const accepted = new Set(listed.map((option) => option.value))
    const named = claudeOptions(
        view.providerModels,
        view.config?.framework === 'claude-code'
            ? view.config.modelMap
            : undefined
    ).filter((option) => accepted.has(option.value))
    const seen = new Set(named.map((option) => option.value))
    return [...named, ...listed.filter((option) => !seen.has(option.value))]
}

// The provider's id for a value, where the value is an alias.
export const providerModelOf = (
    options: readonly ModelOption[] | null,
    value: string | null | undefined
): string | null =>
    (value &&
        options?.find((option) => option.value === value)?.providerModel) ||
    null

// How people write a model name: any case, spaces for dashes, 4.5 for 4-5,
// with or without a vendor prefix, `claude-` or a release date. What was
// typed and every option are reduced to this before comparing.
const modelKey = (name: string): string =>
    name
        .trim()
        .toLowerCase()
        .replace(/^[a-z0-9-]+[/:]/, '')
        .replace(/[\s_]+/g, '-')
        .replace(/(\d)\.(?=\d)/g, '$1-')
        .replace(/^claude-/, '')
        .replace(/-\d{8}$/, '')

// An alias is matched by its label, not by the id it stands for: that id is
// also what its 1M-context variant stands for.
const keysOf = (option: ModelOption): string[] => [
    modelKey(option.value),
    modelKey(option.label),
    ...(option.providerModel && !option.alias
        ? [modelKey(option.providerModel)]
        : [])
]

const FAMILY_NAMES: Record<string, string> = {
    fable: 'Fable',
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku'
}

const describeAlias = (option: ModelOption): string => {
    if (!option.providerModel || option.label === option.value)
        return option.value
    return option.value.includes('[')
        ? `${option.value} (${option.label})`
        : `${option.value} → ${option.providerModel} (${option.label})`
}

// The options one family (or, for frameworks without families, one list)
// per line: aliases with the id each stands for, then the pinned ids, newest
// first. `limit` caps the pinned ids shown per line.
export const formatModelOptions = (
    options: readonly ModelOption[],
    limit = Number.POSITIVE_INFINITY
): string[] => {
    const groups = new Map<string, ModelOption[]>()
    for (const option of options)
        groups.set(option.family ?? '', [
            ...(groups.get(option.family ?? '') ?? []),
            option
        ])
    return [...groups].map(([family, group]) => {
        const aliases = group
            .filter((option) => option.alias)
            .map(describeAlias)
        const pinned = group.filter((option) => !option.alias)
        const shown = pinned.slice(0, limit).map((option) => option.value)
        const rest = pinned.length - shown.length
        const entries = [
            ...aliases,
            ...shown,
            ...(rest > 0 ? [`+${rest} ${family ? 'older' : 'more'}`] : [])
        ].join(', ')
        return family
            ? `  ${(FAMILY_NAMES[family] ?? family).padEnd(6)}  ${entries}`
            : `  ${entries}`
    })
}

export const shellArg = (value: string): string =>
    /^[\w.@:/-]+$/.test(value) ? value : `"${value}"`

// The option a typed model names: an exact value; an id an alias stands for,
// as that alias (model settings list the id only through it, and would read
// it back as unmapped); or the one option its name reduces to.
const matchModelOption = (
    options: readonly ModelOption[],
    model: string
): { option: ModelOption } | { candidates: ModelOption[] } | null => {
    const exact = options.find((option) => option.value === model)
    if (exact) return { option: exact }
    const standsFor = options.filter(
        (option) => option.alias && option.providerModel === model
    )
    if (standsFor.length > 0)
        return {
            option:
                standsFor.find((option) => !option.value.includes('[')) ??
                standsFor[0]
        }
    const key = modelKey(model)
    const matches = options.filter((option) => keysOf(option).includes(key))
    if (matches.length === 1) return { option: matches[0] }
    return matches.length > 1 ? { candidates: matches } : null
}

interface RefusalTexts {
    // Where the options come from, after "could be a or b".
    where: string
    // The first line when nothing matches.
    none: string
    // The last line: how to read the list again.
    refresh: string
}

const refusal = (
    framework: AgentFramework,
    options: readonly ModelOption[],
    model: string,
    candidates: readonly ModelOption[] | null,
    texts: RefusalTexts
): UsageError => {
    if (candidates)
        return new UsageError(
            `"${model}" could be ${candidates.map((option) => option.value).join(' or ')} ${texts.where}; pass one of them`
        )
    const family =
        framework === 'claude-code'
            ? claudeCodeModelSelectionMapKey(model)
            : null
    const newest = family
        ? options.find(
              (option) =>
                  option.alias &&
                  option.family === family &&
                  option.providerModel
          )
        : undefined
    return new UsageError(
        [
            family && newest
                ? `${texts.none} Its newest ${FAMILY_NAMES[family] ?? family} is ${newest.label}: --model ${newest.value}.`
                : texts.none,
            'It can run:',
            ...formatModelOptions(options, 3),
            texts.refresh
        ].join('\n')
    )
}

// `--model` for a new agent. Antigravity CLI takes its own slugs as given.
export const resolveModelChoice = (
    framework: AgentFramework,
    row: UserModelProviderSummary,
    model: string
): string => {
    const options = modelOptionsFor(framework, row)
    if (options === null) return model
    const match = matchModelOption(options, model)
    if (match && 'option' in match) return match.option.value
    const tested = row.lastTestedAt
        ? `was last tested ${row.lastTestedAt.slice(0, 16).replace('T', ' ')} UTC`
        : 'has not been tested'
    throw refusal(framework, options, model, match?.candidates ?? null, {
        where: `on ${row.providerName}`,
        none: `${row.providerName} was not tested with a model "${model}".`,
        refresh: `${row.providerName} ${tested}; for a model released since, test it again: mf model-providers test ${shellArg(row.providerName)}`
    })
}

// Gemini CLI also runs the ids its provider was tested with that its catalog
// does not list, and pi any id its provider serves: a name matching nothing
// listed is theirs for the API to judge.
const listIsExhaustive = (view: AgentModelConfigView): boolean =>
    view.source === 'runtime-local' ||
    (view.framework !== 'gemini-cli' && view.framework !== 'pi')

// `--model` for an agent that exists, against its model settings. Nothing
// listed yet (a provider never tested, a CLI not inspected) leaves the model
// to the API as well.
export const resolveAgentModel = (
    view: AgentModelConfigView,
    model: string
): string => {
    const options = modelOptionsFromView(view)
    if (options.length === 0) return model
    const match = matchModelOption(options, model)
    if (match && 'option' in match) return match.option.value
    if (!match && !listIsExhaustive(view)) return model
    throw refusal(view.framework, options, model, match?.candidates ?? null, {
        where: `for ${view.agentId}`,
        none: `The model settings of ${view.agentId} offer no model "${model}".`,
        refresh: `For a model released since they were read: mf model-config refresh-models ${view.agentId}`
    })
}
