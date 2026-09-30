import {
    bindingProtocolFor,
    brandFor,
    buildClaudeCodeDefaultModelConfig,
    buildCodexDefaultModelConfig,
    frameworkCapability,
    managedChannelFor as rankedManagedChannelFor,
    piProviderForProtocol,
    providerBindingFor,
    testedModelsFor
} from '@manyfold/shared'
import type {
    AgentFramework,
    CreateAgentBody,
    UpdateAgentCredentialsBody,
    UpdateAgentModelConfigBody,
    UserModelProviderSummary
} from '@manyfold/shared'
import { optionalWorkspace } from '@/lib/agentCreateDraft'
import { managedChannelRank } from '@/lib/agentCreate/managedRank'
import type { CostChoice } from '@/pages/AgentNew/v4/flowState'

// The two service frameworks that are handed a model provider at install.
// One whose runtime manages its own providers takes nothing from us; the
// external three never install at all.
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

// "Manyfold managed" resolves to the best-ranked managed channel; this is
// the shared pick with the edition's ranking (the cloud overlay's slot).
export const managedChannelFor = (
    framework: AgentFramework,
    providers: UserModelProviderSummary[]
): UserModelProviderSummary | null =>
    rankedManagedChannelFor(framework, providers, (row) =>
        managedChannelRank(brandFor(row))
    )

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
    // The sandbox or cloud computer the framework installs onto.
    target: { sandboxId: string } | { podHostId: string }
    name: string
    workspace: string
    cost: CostChoice | null
}): CreateAgentBody => {
    const body: CreateAgentBody = {
        name: args.name.trim(),
        framework: args.framework,
        ...('podHostId' in args.target
            ? { runtime: 'k8s', podHostId: args.target.podHostId }
            : { runtime: 'sprites', sandboxId: args.target.sandboxId })
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
    if (framework === 'antigravity-cli')
        return {
            credentials: { antigravityCliCredentials: { providerId } },
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
