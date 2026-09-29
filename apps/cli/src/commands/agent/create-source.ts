import {
    bindingProtocolFor,
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
    isObjectId,
    managedChannelFor,
    piProviderForProtocol,
    providerBindingFor,
    providerRowVerdict,
    testedModelsFor,
    type AgentRuntimeSummary,
    type CreateAgentBody,
    type PiProvider,
    type SandboxSummary,
    type UserModelProviderSummary
} from '@manyfold/shared'
import {
    modelOptionsFor,
    providerModelOf,
    resolveModelChoice,
    shellArg
} from '@/model-options'
import { UsageError } from '@/usage-error'

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
            providerModel: providerModelOf(
                modelOptionsFor(framework, row),
                modelConfig.model
            )
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
