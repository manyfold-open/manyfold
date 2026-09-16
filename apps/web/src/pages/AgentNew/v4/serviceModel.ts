import {
    brandFor,
    builtInSupportsProtocol,
    frameworkSupportsProtocol,
    isManagedProtocolAllowedForFramework,
    lookupBuiltIn,
    providerModelIdsForProtocol
} from '@manyfold/shared'
import type {
    AgentFramework,
    CreateAgentBody,
    InferenceProtocol,
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

// Same list, same order, as the API's CredentialsResolverService: a built-in
// provider that speaks several of these is resolved to the FIRST it supports,
// and the model list shown here has to be the one that resolution will read,
// or step ④ names a model the agent never gets.
const SERVICE_PROTOCOLS: readonly InferenceProtocol[] = [
    'anthropic_messages',
    'openai_chat_completions',
    'openai_responses',
    'mistral_chat_completions'
]

// Only for choosing the economical default within a list; the protocol is
// what actually gets sent.
const BRAND_FOR_PROTOCOL: Partial<Record<InferenceProtocol, UserModelProvider>> =
    {
        anthropic_messages: 'anthropic',
        openai_chat_completions: 'openai',
        openai_responses: 'openai'
    }

// The protocol this framework would speak to this provider row, or null when
// the API would refuse the pair — either because the framework cannot talk it
// or because the managed channel is closed to that framework.
export const serviceProtocolFor = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): InferenceProtocol | null => {
    const protocols = SERVICE_PROTOCOLS.filter((protocol) =>
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

// The model the install will be given: the economical default of what this
// provider has been tested with on that protocol — the same pick v3 makes.
// Null when the row has never been tested, because the API requires a model
// name and there is nothing honest to invent.
export const serviceModelFor = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): string | null => {
    const protocol = serviceProtocolFor(framework, row)
    if (protocol === null) return null
    const options =
        providerModelIdsForProtocol(
            row.lastTestModels,
            row.enabledModels,
            protocol
        ) ?? []
    return (
        preferredPrimaryModelDefault(
            options,
            BRAND_FOR_PROTOCOL[protocol] ?? 'openai'
        ) ?? null
    )
}

// Why a provider row cannot be picked for this framework, if it cannot. The
// row stays on screen and says which (decision R keeps a disabled row in
// place with its reason); a row that quietly vanished would leave the user
// wondering where their key went.
export type ServiceRowVerdict = 'usable' | 'incompatible' | 'untested'

export const serviceRowVerdict = (
    framework: AgentFramework,
    row: UserModelProviderSummary
): ServiceRowVerdict =>
    serviceProtocolFor(framework, row) === null
        ? 'incompatible'
        : serviceModelFor(framework, row) === null
          ? 'untested'
          : 'usable'

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
        .filter((row) => serviceModelFor(framework, row) !== null)
        .sort(
            (a, b) =>
                managedChannelRank(brandFor(a)) - managedChannelRank(brandFor(b))
        )[0] ?? null

// Attach the provider row and model to a step ③ answer, for a framework that
// is installed at create. Null when no honest binding exists — the rows that
// would lead here are disabled, so this is the guard behind the guard.
export const withServiceBinding = (
    choice: CostChoice,
    framework: AgentFramework,
    providers: UserModelProviderSummary[]
): CostChoice | null => {
    if (!bindsModelAtCreate(framework)) return choice
    if (choice.kind === 'platform') {
        const channel = managedChannelFor(framework, providers)
        const model = channel === null ? null : serviceModelFor(framework, channel)
        return channel === null || model === null
            ? null
            : { kind: 'platform', providerId: channel.id, model }
    }
    if (choice.kind === 'provider') {
        const row = providers.find((p) => p.id === choice.providerId)
        const model = row === undefined ? null : serviceModelFor(framework, row)
        return model === null ? null : { ...choice, model }
    }
    return choice
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
