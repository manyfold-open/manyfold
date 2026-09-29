import {
    bindingProtocolFor,
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
    claudeCodeModelSelectionMapKey,
    codexModelDisplayName,
    isClaudeCodeModelAlias,
    isObjectId,
    managedChannelFor,
    piProviderForProtocol,
    providerBindingFor,
    providerRowVerdict,
    resolveClaudeCodeModelOptions,
    resolveCodexModelOptions,
    testedModelsFor,
    type AgentRuntimeSummary,
    type CreateAgentBody,
    type PiProvider,
    type SandboxSummary,
    type UserModelProviderSummary
} from '@manyfold/shared'

// What `mf agent create` sends for each way of paying for the model: the same
// bodies the web sends for a managed channel, a saved provider, a pasted key
// or a sign-in on the machine.

export const CREATE_FRAMEWORKS = [
    'claude-code',
    'codex',
    'gemini-cli',
    'pi',
    'antigravity-cli'
] as const
export type CreateFramework = (typeof CREATE_FRAMEWORKS)[number]

// A mistake in the command line itself: reported as usage (exit 5) before
// anything is created.
export class UsageError extends Error {}

interface InlineKey {
    key: string
    baseUrl?: string
    piProvider?: PiProvider
}

export type ModelSource =
    | { kind: 'managed'; row: UserModelProviderSummary }
    | { kind: 'provider'; row: UserModelProviderSummary }
    | { kind: 'key'; key: InlineKey }
    | { kind: 'subscription' }

type CredentialFields = Pick<
    CreateAgentBody,
    | 'claudeCodeCredentials'
    | 'codexCredentials'
    | 'geminiCliCredentials'
    | 'piCredentials'
    | 'antigravityCliCredentials'
    | 'modelConfigSource'
    | 'modelConfig'
>

interface BoundSource {
    fields: CredentialFields
    // The model the agent is set up with, where it is ours to name, and the
    // provider's id for it when that is an alias.
    model: string | null
    providerModel: string | null
}

// "managed" and "subscription" win over a saved provider that happens to
// carry the same name; anything else is a provider id, then an exact name.
export const resolveModelSource = (
    framework: CreateFramework,
    ref: string,
    providers: readonly UserModelProviderSummary[]
): ModelSource => {
    if (ref === 'subscription') return { kind: 'subscription' }
    if (ref === 'managed') {
        const row = managedChannelFor(framework, providers)
        if (!row)
            throw new UsageError(
                `no Manyfold managed model serves ${framework} on this account; mf model-providers list --framework ${framework} shows what can`
            )
        return { kind: 'managed', row }
    }
    return { kind: 'provider', row: resolveProviderRef(providers, ref) }
}

// A saved or managed provider by id, else by its exact name.
export const resolveProviderRef = (
    providers: readonly UserModelProviderSummary[],
    ref: string
): UserModelProviderSummary => {
    const byId = providers.find((row) => row.id === ref)
    if (byId) return byId
    const named = providers.filter((row) => row.providerName === ref)
    if (named.length > 1)
        throw new UsageError(
            `${named.length} model providers are named "${ref}" (${named.map((row) => row.id).join(', ')}); pass the id`
        )
    if (named.length === 1) return named[0]
    throw new UsageError(
        `no model provider "${ref}"; use managed, subscription, or a provider from mf model-providers list`
    )
}

// One model `--model` can name on a provider row. An alias follows its
// family's newest tested model (`providerModel` is the id it stands for
// today); anything else pins one id.
export interface ModelOption {
    value: string
    label: string
    providerModel: string | null
    family: string | null
    alias: boolean
}

// What `--model` accepts from this row: Claude Code's mapped aliases and the
// tested versions beside them, Codex's own models among the tested ones, the
// tested list for Gemini CLI and pi. Null for Antigravity CLI, which names
// models by slugs no provider test lists.
export const modelOptionsFor = (
    framework: CreateFramework,
    row: UserModelProviderSummary
): ModelOption[] | null => {
    const tested = testedModelsFor(framework, row)
    if (framework === 'claude-code')
        return resolveClaudeCodeModelOptions(
            tested,
            buildClaudeCodeDefaultModelConfig(tested).modelMap
        )
            .filter((option) => option.enabled)
            .map((option) => ({
                value: option.value,
                label: option.label,
                providerModel: option.providerModel ?? null,
                family: option.canonicalModel ?? null,
                alias: isClaudeCodeModelAlias(option.value)
            }))
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
            .map((option) =>
                option.value.includes('[')
                    ? `${option.value} (${option.label})`
                    : `${option.value} → ${option.providerModel} (${option.label})`
            )
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

const shellArg = (value: string): string =>
    /^[\w.@:/-]+$/.test(value) ? value : `"${value}"`

const unknownModelMessage = (
    framework: CreateFramework,
    row: UserModelProviderSummary,
    model: string,
    options: readonly ModelOption[]
): string => {
    let first = `${row.providerName} was not tested with a model "${model}".`
    const family =
        framework === 'claude-code'
            ? claudeCodeModelSelectionMapKey(model)
            : null
    const newest = family
        ? options.find((option) => option.alias && option.family === family)
        : undefined
    if (family && newest)
        first += ` Its newest ${FAMILY_NAMES[family] ?? family} is ${newest.label}: --model ${newest.value}.`
    const tested = row.lastTestedAt
        ? `was last tested ${row.lastTestedAt.slice(0, 16).replace('T', ' ')} UTC`
        : 'has not been tested'
    return [
        first,
        'It can run:',
        ...formatModelOptions(options, 3),
        `${row.providerName} ${tested}; for a model released since, test it again: mf model-providers test ${shellArg(row.providerName)}`
    ].join('\n')
}

// The option `--model` names, however it was written: an exact value; an id
// an alias stands for, saved as that alias (the agent's settings list the
// id only through it, and would read it back as unmapped); or the one option
// its name reduces to. Antigravity CLI takes its own slugs as given.
export const resolveModelChoice = (
    framework: CreateFramework,
    row: UserModelProviderSummary,
    model: string
): string => {
    const options = modelOptionsFor(framework, row)
    if (options === null) return model
    const exact = options.find((option) => option.value === model)
    if (exact) return exact.value
    const standsFor = options.filter(
        (option) => option.alias && option.providerModel === model
    )
    if (standsFor.length > 0)
        return (
            standsFor.find((option) => !option.value.includes('[')) ??
            standsFor[0]
        ).value
    const key = modelKey(model)
    const matches = options.filter((option) => keysOf(option).includes(key))
    if (matches.length === 1) return matches[0].value
    if (matches.length > 1)
        throw new UsageError(
            `"${model}" could be ${matches.map((option) => option.value).join(' or ')} on ${row.providerName}; pass one of them`
        )
    throw new UsageError(unknownModelMessage(framework, row, model, options))
}

// The provider's id for a chosen value, where the value is an alias.
const providerModelOf = (
    framework: CreateFramework,
    row: UserModelProviderSummary,
    value: string | null | undefined
): string | null =>
    (value &&
        modelOptionsFor(framework, row)?.find(
            (option) => option.value === value
        )?.providerModel) ||
    null

// A provider row bound the way the web binds it: Claude Code and Codex get
// the default model mapping for what the row was tested with (the API only
// derives one for Claude Code), pi its vendor and model in the credential.
const bindProviderRow = (
    framework: CreateFramework,
    row: UserModelProviderSummary,
    model: string | undefined
): BoundSource => {
    const verdict = providerRowVerdict(framework, row)
    if (verdict === 'untested')
        throw new UsageError(
            `${row.providerName} has not been tested, so there is no model to run on it; test it: mf model-providers test ${shellArg(row.providerName)}`
        )
    if (verdict === 'incompatible')
        throw new UsageError(
            `${row.providerName} cannot serve ${framework}; mf model-providers list --framework ${framework} shows the ones that can`
        )
    const providerId = row.id
    const tested = testedModelsFor(framework, row)
    const chosen = model ? resolveModelChoice(framework, row, model) : undefined
    if (framework === 'claude-code') {
        const defaults = buildClaudeCodeDefaultModelConfig(tested)
        const modelConfig = chosen
            ? buildClaudeCodeDefaultModelConfig(tested, {
                  ...defaults,
                  model: chosen
              })
            : defaults
        return {
            fields: {
                claudeCodeCredentials: { providerId },
                modelConfigSource: 'platform',
                modelConfig
            },
            model: modelConfig.model ?? null,
            providerModel: providerModelOf(framework, row, modelConfig.model)
        }
    }
    if (framework === 'codex') {
        const defaults = buildCodexDefaultModelConfig(tested)
        const modelConfig = chosen
            ? buildCodexDefaultModelConfig(tested, {
                  ...defaults,
                  model: chosen
              })
            : defaults
        return {
            fields: {
                codexCredentials: { providerId },
                modelConfigSource: 'platform',
                modelConfig
            },
            model: modelConfig.model ?? null,
            providerModel: null
        }
    }
    if (framework === 'pi') {
        const protocol = bindingProtocolFor(framework, row)
        const provider = protocol ? piProviderForProtocol(protocol) : null
        if (!provider)
            throw new UsageError(`${row.providerName} cannot serve pi`)
        const piModel = chosen ?? providerBindingFor(framework, row)?.model
        return {
            fields: {
                piCredentials: {
                    providerId,
                    provider,
                    ...(piModel ? { model: piModel } : {})
                }
            },
            model: piModel ?? null,
            providerModel: null
        }
    }
    // Gemini CLI routes its own default on Google's endpoint when no model
    // is named.
    const credentials = { providerId, ...(chosen ? { model: chosen } : {}) }
    return {
        fields:
            framework === 'gemini-cli'
                ? { geminiCliCredentials: credentials }
                : { antigravityCliCredentials: credentials },
        model: chosen ?? null,
        providerModel: null
    }
}

// A pasted key carries no tested model list, so only the frameworks whose
// credential names a model take one.
const bindInlineKey = (
    framework: CreateFramework,
    key: InlineKey,
    model: string | undefined
): BoundSource => {
    if (model && (framework === 'claude-code' || framework === 'codex'))
        throw new UsageError(
            `--model needs a model provider for ${framework}: a key alone has no tested models; set it after the create with mf model-config update`
        )
    const baseUrl = key.baseUrl
    if (framework === 'claude-code')
        return {
            fields: {
                claudeCodeCredentials: {
                    anthropicAuthToken: key.key,
                    ...(baseUrl ? { anthropicBaseUrl: baseUrl } : {})
                }
            },
            model: null,
            providerModel: null
        }
    if (framework === 'codex')
        return {
            fields: {
                codexCredentials: {
                    openaiApiKey: key.key,
                    ...(baseUrl ? { openaiBaseUrl: baseUrl } : {})
                }
            },
            model: null,
            providerModel: null
        }
    if (framework === 'pi') {
        if (!key.piProvider)
            throw new UsageError(
                '--pi-api-key needs --pi-provider anthropic | openai | google, the vendor the key belongs to'
            )
        return {
            fields: {
                piCredentials: {
                    apiKey: key.key,
                    provider: key.piProvider,
                    ...(baseUrl ? { baseUrl } : {}),
                    ...(model ? { model } : {})
                }
            },
            model: model ?? null,
            providerModel: null
        }
    }
    const credentials = {
        googleApiKey: key.key,
        ...(baseUrl ? { googleGeminiBaseUrl: baseUrl } : {}),
        ...(model ? { model } : {})
    }
    return {
        fields:
            framework === 'gemini-cli'
                ? { geminiCliCredentials: credentials }
                : { antigravityCliCredentials: credentials },
        model: model ?? null,
        providerModel: null
    }
}

export const bindSource = (
    framework: CreateFramework,
    source: ModelSource,
    model: string | undefined
): BoundSource => {
    if (source.kind === 'subscription') {
        if (model)
            throw new UsageError(
                `--model does not apply to a subscription sign-in: ${framework} picks from what the account offers; change it after the sign-in with mf model-config update`
            )
        return {
            fields: { modelConfigSource: 'runtime-local' },
            model: null,
            providerModel: null
        }
    }
    if (source.kind === 'key')
        return bindInlineKey(framework, source.key, model)
    return bindProviderRow(framework, source.row, model)
}

// An id, or a name only one of the user's sandboxes carries.
export const resolveSandboxRef = (
    sandboxes: readonly SandboxSummary[],
    ref: string
): SandboxSummary => {
    if (isObjectId(ref, 'sandboxHost')) {
        const found = sandboxes.find((row) => row.id === ref)
        if (found) return found
        throw new UsageError(`no sandbox ${ref}; mf sandbox list shows yours`)
    }
    const named = sandboxes.filter((row) => row.name === ref)
    if (named.length > 1)
        throw new UsageError(
            `${named.length} sandboxes are named "${ref}" (${named.map((row) => row.id).join(', ')}); pass the id`
        )
    if (named.length === 1) return named[0]
    throw new UsageError(
        `no sandbox named "${ref}"; mf sandbox list shows yours`
    )
}

// The instance of the framework an agent added to this sandbox would join,
// or null when the create installs the framework there first.
export const runtimeToJoin = (
    runtimes: readonly AgentRuntimeSummary[],
    sandbox: SandboxSummary,
    framework: CreateFramework
): AgentRuntimeSummary | null => {
    const live = runtimes.find(
        (row) =>
            row.kind === 'sprites' &&
            row.hostId === sandbox.id &&
            row.framework === framework &&
            row.status !== 'failed'
    )
    if (!live) return null
    if (live.status !== 'ready')
        throw new Error(
            `sandbox ${sandbox.name} is still bringing up ${framework} (${live.status}); try again once it is ready`
        )
    return live
}
