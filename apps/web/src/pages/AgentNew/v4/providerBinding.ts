import {
    brandFor,
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
    builtInSupportsProtocol,
    frameworkCapability,
    frameworkSupportsProtocol,
    isManagedProtocolAllowedForFramework,
    lookupBuiltIn,
    piProviderForProtocol,
    providerModelIdsForProtocol
} from '@manyfold/shared'
import type {
    AgentFramework,
    CreateAgentBody,
    InferenceProtocol,
    UpdateAgentCredentialsBody,
    UpdateAgentModelConfigBody,
    UserModelProvider,
    UserModelProviderSummary
} from '@manyfold/shared'
import { optionalWorkspace } from '@/lib/agentCreateDraft'
import { preferredPrimaryModelDefault } from '@/lib/agentModelConfig'
import { managedChannelRank } from '@/lib/agentCreate/managedRank'
import type { CostChoice } from '@/pages/AgentNew/v4/flowState'

// The two service frameworks that are handed a model provider at install.
// NarraNexus manages its own providers from inside its UI and takes nothing
// from us; the external three never install at all.
export const bindsModelAtCreate = (
    framework: AgentFramework
): framework is 'openclaw' | 'hermes' =>
    framework === 'openclaw' || framework === 'hermes'

// A coding CLI is installed at step ② and joins its runtime at step ④ through
// `POST /agent-runtimes/:id/agents`, which carries no provider — so a step ③
// answer that names one is bound right after the join, with the PATCH the
// agent's own credentials dialog issues (v1 binds a Cloud pick on an existing
// runtime the same way). The stored credential belongs to the runtime, which
// is why this holds whether the runtime is new or already runs agents.
export const bindsModelAfterJoin = (framework: AgentFramework): boolean =>
    frameworkCapability(framework).kind === 'coding'

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
const BRAND_FOR_PROTOCOL: Partial<Record<InferenceProtocol, UserModelProvider>> =
    {
        anthropic_messages: 'anthropic',
        openai_chat_completions: 'openai',
        openai_responses: 'openai',
        google_generate_content: 'google'
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
const testedModelsFor = (
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
    // and a model the API picks on a gateway.
    model?: string
}

// The provider row and model a step ③ answer binds, or null when the API
// would refuse it. Claude Code and Codex get the default mapping the agent's
// model settings would propose for this list (Codex only runs its own model
// family, so a list without one cannot bind); the rest get the economical
// default of what the provider has been tested with — the pick v3 makes.
export const providerBindingFor = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): ProviderBinding | null => {
    const protocol = bindingProtocolFor(framework, row)
    const options = testedModelsFor(framework, row)
    if (protocol === null || options.length === 0) return null
    if (framework === 'gemini-cli') return { providerId: row.id }
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

// Why a provider row cannot be picked for this framework, if it cannot. The
// row stays on screen and says which (decision R keeps a disabled row in
// place with its reason); a row that quietly vanished would leave the user
// wondering where their key went.
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

// "Manyfold managed" is one row on screen and several channels underneath
// (one per vendor). The API needs a concrete one, so the row resolves to the
// best-ranked channel this framework may use that has a model to offer —
// with the edition's own ranking, the way v3's picker collapses the family.
export const managedChannelFor = (
    framework: AgentFramework,
    providers: UserModelProviderSummary[]
): UserModelProviderSummary | null =>
    providers
        .filter((row) => row.source === 'managed' && !row.channelDisabled)
        .filter((row) => providerBindingFor(framework, row) !== null)
        .sort(
            (a, b) =>
                managedChannelRank(brandFor(a)) - managedChannelRank(brandFor(b))
        )[0] ?? null

// Attach the provider row and model to a step ③ answer, for a framework whose
// answer is bound (installed at create, or a coding CLI). Null when no honest
// binding exists — the rows that would lead here are disabled, so this is the
// guard behind the guard.
export const withBinding = (
    choice: CostChoice,
    framework: AgentFramework,
    providers: UserModelProviderSummary[]
): CostChoice | null => {
    if (!bindsModelAtCreate(framework) && !bindsModelAfterJoin(framework))
        return choice
    const row =
        choice.kind === 'platform'
            ? managedChannelFor(framework, providers)
            : choice.kind === 'provider'
              ? (providers.find((p) => p.id === choice.providerId) ?? null)
              : undefined
    if (row === undefined) return choice
    const binding = row === null ? null : providerBindingFor(framework, row)
    if (binding === null) return null
    return choice.kind === 'platform'
        ? { kind: 'platform', ...binding }
        : { ...choice, ...binding }
}

// The one request that installs the framework onto the sandbox and creates
// the agent on it — `POST /agents` with `sandboxId`, exactly what v3 sends.
// Shapes per framework follow `buildCreateAgentBody`'s saved-provider branch.
export const serviceCreateBody = (args: {
    framework: AgentFramework
    sandboxId: string
    name: string
    workspace: string
    cost: CostChoice | null
}): CreateAgentBody => {
    const body: CreateAgentBody = {
        name: args.name.trim(),
        framework: args.framework,
        runtime: 'sprites',
        sandboxId: args.sandboxId
    }
    const workspace = optionalWorkspace(args.workspace)
    if (workspace) body.workspace = workspace
    const cost = args.cost
    const bound =
        cost !== null &&
        (cost.kind === 'platform' || cost.kind === 'provider') &&
        cost.providerId !== undefined &&
        cost.model !== undefined
            ? { providerId: cost.providerId, model: cost.model }
            : null
    if (bound === null) return body
    if (args.framework === 'openclaw')
        body.openclawCredentials = {
            providerId: bound.providerId,
            primaryModelName: bound.model
        }
    else if (args.framework === 'hermes')
        body.hermesCredentials = {
            primaryProviderId: bound.providerId,
            primaryModelName: bound.model
        }
    return body
}

export interface JoinBinding {
    credentials: UpdateAgentCredentialsBody
    // On a daemon the model source defaults to the machine's own sign-in, so
    // a platform answer is written down, or the key just bound is never used.
    modelConfig?: UpdateAgentModelConfigBody
}

// The two requests that bind a joined coding agent to its step ③ answer:
// `PATCH /agents/:id/credentials`, then its platform model settings. Claude
// Code and Codex send the default mapping for the provider's tested list —
// the one `providerBindingFor` named — because the API only derives one for
// Claude Code; pi carries its model in the credential itself, so it sends the
// source alone. Null when the answer names no provider (a sign-in on the
// machine, or a framework that is not bound here).
export const joinBindingFor = (
    framework: AgentFramework,
    cost: CostChoice | null,
    providers: UserModelProviderSummary[]
): JoinBinding | null => {
    if (!bindsModelAfterJoin(framework) || cost === null) return null
    if (cost.kind !== 'platform' && cost.kind !== 'provider') return null
    if (cost.providerId === undefined) return null
    const providerId = cost.providerId
    const row = providers.find((p) => p.id === providerId)
    const options = row === undefined ? [] : testedModelsFor(framework, row)
    if (framework === 'claude-code')
        return {
            credentials: { claudeCodeCredentials: { providerId } },
            modelConfig: {
                modelConfigSource: 'platform',
                modelConfig: buildClaudeCodeDefaultModelConfig(options)
            }
        }
    if (framework === 'codex')
        return {
            credentials: { codexCredentials: { providerId } },
            modelConfig: {
                modelConfigSource: 'platform',
                modelConfig: buildCodexDefaultModelConfig(options)
            }
        }
    if (framework === 'gemini-cli')
        return {
            credentials: { geminiCliCredentials: { providerId } },
            modelConfig: { modelConfigSource: 'platform' }
        }
    // pi's vendor rides along: beside a provider speaking several of pi's
    // protocols it says which one the agent is bound under, and it has to be
    // the one the model above was read from.
    const protocol =
        row === undefined ? null : bindingProtocolFor(framework, row)
    const provider = protocol === null ? null : piProviderForProtocol(protocol)
    if (framework !== 'pi' || provider === null) return null
    return {
        credentials: {
            piCredentials: {
                providerId,
                provider,
                ...(cost.model !== undefined ? { model: cost.model } : {})
            }
        },
        modelConfig: { modelConfigSource: 'platform' }
    }
}
