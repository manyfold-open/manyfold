import { builtInSupportsProtocol, lookupBuiltIn } from './built-in-providers'
import type { AgentFramework } from './constants'
import type {
    InferenceProtocol,
    UserModelProvider,
    UserModelProviderSummary
} from './dtos'
import {
    frameworkSupportsProtocol,
    isManagedProtocolAllowedForFramework
} from './inference-protocol'
import {
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
    providerModelIdsForProtocol
} from './model-config'

// Which saved or managed provider row a coding agent can be bound to, and the
// model it gets: shared by the web create flow and `mf agent create`, so both
// bind the same way.

// Same order as the API's CredentialsResolverService: a built-in provider that
// speaks several of these is resolved to the FIRST the framework supports, and
// the model list read here has to be the one that resolution will read, or
// step ④ names a model the agent never gets. Each framework narrows it to what
// it speaks, which leaves the resolver's own list for every one of them.
const BINDING_PROTOCOLS: readonly InferenceProtocol[] = [
    'anthropic_messages',
    'openai_chat_completions',
    'openai_responses',
    'mistral_chat_completions',
    'google_generate_content'
]

// Only for choosing the economical default within a list; the protocol is
// what actually gets sent.
const BRAND_FOR_PROTOCOL: Partial<
    Record<InferenceProtocol, UserModelProvider>
> = {
    anthropic_messages: 'anthropic',
    openai_chat_completions: 'openai',
    openai_responses: 'openai',
    google_generate_content: 'google'
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
        const partial = options.find((o) => o.toLowerCase().includes(keyword))
        if (partial) return partial
    }
    return options[0]
}

// The protocol this framework would speak to this provider row, or null when
// the API would refuse the pair — either because the framework cannot talk it
// or because the managed channel is closed to that framework.
export const bindingProtocolFor = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): InferenceProtocol | null => {
    const protocols = BINDING_PROTOCOLS.filter((protocol) =>
        frameworkSupportsProtocol(framework, protocol)
    )
    let protocol: InferenceProtocol | null = null
    if (row.builtInId) {
        const entry = lookupBuiltIn(row.builtInId)
        protocol = entry ? builtInSupportsProtocol(entry, protocols) : null
    } else if (
        row.inferenceProtocol !== null &&
        protocols.includes(row.inferenceProtocol)
    )
        protocol = row.inferenceProtocol
    if (protocol === null) return null
    return isManagedProtocolAllowedForFramework(framework, row.source, protocol)
        ? protocol
        : null
}

// What this provider has been tested with on the protocol the framework will
// speak. Empty for a row never tested, which is the one thing a binding
// cannot do without: every framework here needs a model name the provider is
// known to serve, and there is nothing honest to invent.
export const testedModelsFor = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): string[] => {
    const protocol = bindingProtocolFor(framework, row)
    if (protocol === null) return []
    return (
        providerModelIdsForProtocol(
            row.lastTestModels,
            row.enabledModels,
            protocol
        ) ?? []
    )
}

export interface ProviderBinding {
    providerId: string
    // The model the agent will be given, where it is ours to name. Gemini CLI
    // leaves it out: its default is the CLI's own router on Google's endpoint
    // and a model the API picks on a gateway. So does Antigravity CLI, whose
    // models are its own slugs, not the ids a provider was tested with.
    model?: string
}

// The provider row and model a binding would use, or null when the API would
// refuse it. Claude Code and Codex get the default mapping the agent's model
// settings would propose for this list (Codex only runs its own model family,
// so a list without one cannot bind); the rest get the economical default of
// what the provider has been tested with.
export const providerBindingFor = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): ProviderBinding | null => {
    const protocol = bindingProtocolFor(framework, row)
    const options = testedModelsFor(framework, row)
    if (protocol === null || options.length === 0) return null
    if (framework === 'gemini-cli' || framework === 'antigravity-cli')
        return { providerId: row.id }
    const model =
        framework === 'claude-code'
            ? buildClaudeCodeDefaultModelConfig(options).model
            : framework === 'codex'
              ? buildCodexDefaultModelConfig(options).model
              : preferredPrimaryModelDefault(
                    options,
                    BRAND_FOR_PROTOCOL[protocol] ?? 'openai'
                )
    return model ? { providerId: row.id, model } : null
}

// Why a provider row cannot be picked for this framework, if it cannot. A
// picker keeps a disabled row in place with its reason; a row that quietly
// vanished would leave the user wondering where their key went.
export type ProviderRowVerdict = 'usable' | 'incompatible' | 'untested'

export const providerRowVerdict = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): ProviderRowVerdict =>
    providerBindingFor(framework, row) !== null
        ? 'usable'
        : bindingProtocolFor(framework, row) !== null &&
            testedModelsFor(framework, row).length === 0
          ? 'untested'
          : 'incompatible'

// "Manyfold managed" is one choice on screen and several channels underneath
// (one per vendor). The API needs a concrete one, so the choice resolves to
// the best-ranked channel this framework may use that has a model to offer.
// The ranking is the edition's: without one, rows keep the order given.
export const managedChannelFor = (
    framework: AgentFramework,
    providers: readonly UserModelProviderSummary[],
    rank: (row: UserModelProviderSummary) => number = () => 0
): UserModelProviderSummary | null =>
    providers
        .filter((row) => row.source === 'managed' && !row.channelDisabled)
        .filter((row) => providerBindingFor(framework, row) !== null)
        .sort((a, b) => rank(a) - rank(b))[0] ?? null
