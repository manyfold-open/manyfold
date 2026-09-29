import {
    bindingProtocolFor,
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
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
    // The model the agent is set up with, where it is ours to name.
    model: string | null
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
    const byId = providers.find((row) => row.id === ref)
    if (byId) return { kind: 'provider', row: byId }
    const named = providers.filter((row) => row.providerName === ref)
    if (named.length > 1)
        throw new UsageError(
            `${named.length} model providers are named "${ref}" (${named.map((row) => row.id).join(', ')}); pass the id`
        )
    if (named.length === 1) return { kind: 'provider', row: named[0] }
    throw new UsageError(
        `no model provider "${ref}"; use managed, subscription, or a provider from mf model-providers list`
    )
}

// What `--model` accepts from this provider row: Claude Code's aliases
// mapped to a tested model and the tested versions beside them, Codex's own
// models among the tested ones, the tested list for Gemini CLI and pi.
// Null for Antigravity CLI, which names models by slugs no test lists.
export const modelChoices = (
    framework: CreateFramework,
    row: UserModelProviderSummary
): string[] | null => {
    const tested = testedModelsFor(framework, row)
    if (framework === 'claude-code')
        return resolveClaudeCodeModelOptions(
            tested,
            buildClaudeCodeDefaultModelConfig(tested).modelMap
        )
            .filter((option) => option.enabled)
            .map((option) => option.value)
    if (framework === 'codex')
        return resolveCodexModelOptions(tested).map((option) => option.value)
    if (framework === 'antigravity-cli') return null
    return tested
}

const assertModelOffered = (
    model: string,
    offered: readonly string[] | null,
    row: UserModelProviderSummary
): void => {
    if (offered === null || offered.includes(model)) return
    throw new UsageError(
        `${row.providerName} has not been tested with "${model}"; pick one of: ${offered.join(', ')}`
    )
}

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
            `${row.providerName} has not been tested, so there is no model to run on it; test it under Settings → Model providers in the web app`
        )
    if (verdict === 'incompatible')
        throw new UsageError(
            `${row.providerName} cannot serve ${framework}; mf model-providers list --framework ${framework} shows the ones that can`
        )
    const providerId = row.id
    const tested = testedModelsFor(framework, row)
    if (model) assertModelOffered(model, modelChoices(framework, row), row)
    if (framework === 'claude-code') {
        const defaults = buildClaudeCodeDefaultModelConfig(tested)
        const modelConfig = model
            ? buildClaudeCodeDefaultModelConfig(tested, { ...defaults, model })
            : defaults
        return {
            fields: {
                claudeCodeCredentials: { providerId },
                modelConfigSource: 'platform',
                modelConfig
            },
            model: modelConfig.model ?? null
        }
    }
    if (framework === 'codex') {
        const defaults = buildCodexDefaultModelConfig(tested)
        const modelConfig = model
            ? buildCodexDefaultModelConfig(tested, { ...defaults, model })
            : defaults
        return {
            fields: {
                codexCredentials: { providerId },
                modelConfigSource: 'platform',
                modelConfig
            },
            model: modelConfig.model ?? null
        }
    }
    if (framework === 'pi') {
        const protocol = bindingProtocolFor(framework, row)
        const provider = protocol ? piProviderForProtocol(protocol) : null
        if (!provider)
            throw new UsageError(`${row.providerName} cannot serve pi`)
        const chosen = model ?? providerBindingFor(framework, row)?.model
        return {
            fields: {
                piCredentials: {
                    providerId,
                    provider,
                    ...(chosen ? { model: chosen } : {})
                }
            },
            model: chosen ?? null
        }
    }
    // Gemini CLI routes its own default on Google's endpoint when no model
    // is named.
    const credentials = { providerId, ...(model ? { model } : {}) }
    return {
        fields:
            framework === 'gemini-cli'
                ? { geminiCliCredentials: credentials }
                : { antigravityCliCredentials: credentials },
        model: model ?? null
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
            model: null
        }
    if (framework === 'codex')
        return {
            fields: {
                codexCredentials: {
                    openaiApiKey: key.key,
                    ...(baseUrl ? { openaiBaseUrl: baseUrl } : {})
                }
            },
            model: null
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
            model: model ?? null
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
        model: model ?? null
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
        return { fields: { modelConfigSource: 'runtime-local' }, model: null }
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
