import {
    BUILT_IN_PROVIDERS,
    builtInSupportsProtocol,
    compatibleProtocolsForProvider,
    frameworkSupportsProtocol,
    isConfigurableFramework,
    isManagedProtocolAllowedForFramework,
    providerProtocolForTarget,
    providerSupportsTarget
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime,
    BuiltInProviderEntry,
    InferenceProtocol,
    RuntimeAuthListView,
    UserModelProvider,
    UserModelProviderSummary
} from '@manyfold/shared'
import { PROVIDER_PICKER_DEFAULT_MODE } from '@/lib/agentCreate/providerDefaultMode'
import { profileBindable, runtimeAuthPickerState } from '@/lib/runtimeAuth'

// The create form's provider section has two sources: Cloud (Manyfold holds
// the credential — a saved provider) and Local (the runtime holds it — the
// coding CLI's own sign-in, or an API key stored on the runtime). 'runtime'
// is the picker mode that means Local, unchanged so the request builders and
// the other create variants keep reading it. Joining an existing runtime
// offers no "same credentials" row: the runtime's own credentials ARE the
// Local list (its host sign-in row), so a Cloud pick is always a provider.
export type ProviderPickerMode = 'saved' | 'inline' | 'runtime'
export type CloudPickerMode = 'saved' | 'inline'
export type ProviderSource = 'cloud' | 'local'
// The section's chip row filters one pick-one list; it never changes the
// selection, exactly like the runtime kind chips above it.
export type ProviderSourceFilter = 'all' | ProviderSource

export interface LocalCredentialSelection {
    // '' = the host's own sign-in (the inherited binding), otherwise one of
    // the runtime's added accounts — a subscription or a stored API key.
    profileId: string
}

export const INITIAL_LOCAL_CREDENTIALS: LocalCredentialSelection = {
    profileId: ''
}

export interface ProviderTarget {
    runtimeMode: 'new' | 'existing'
    runtimeKind: AgentRuntime | null
}

export const NEW_RUNTIME_TARGET: ProviderTarget = {
    runtimeMode: 'new',
    runtimeKind: null
}

export const localSourceAvailable = (framework: AgentFramework): boolean =>
    isConfigurableFramework(framework)

export const providerSourceOf = (mode: ProviderPickerMode): ProviderSource =>
    mode === 'runtime' ? 'local' : 'cloud'

export const isCloudPickerMode = (
    mode: ProviderPickerMode
): mode is CloudPickerMode => mode === 'saved' || mode === 'inline'

// Only the two modes that carry a credential Manyfold stores can become a
// credentials PATCH; the type guard is what keeps the other two out of it.
export const isCloudCredentialPicker = <T extends { mode: ProviderPickerMode }>(
    picker: T
): picker is T & { mode: CloudPickerMode } => isCloudPickerMode(picker.mode)

// A self-owned computer already holds the user's sign-in, so it starts on
// Local whatever the edition prefers for platform-hosted runtimes.
export const defaultProviderSource = (
    framework: AgentFramework,
    target: ProviderTarget,
    defaultMode: string = PROVIDER_PICKER_DEFAULT_MODE
): ProviderSource => {
    if (!isConfigurableFramework(framework)) return 'cloud'
    if (target.runtimeKind === 'daemon') return 'local'
    return defaultMode === 'runtime' ? 'local' : 'cloud'
}

export const initialPickerModeFor = (
    framework: AgentFramework,
    target: ProviderTarget,
    defaultMode?: string
): ProviderPickerMode => {
    if (defaultProviderSource(framework, target, defaultMode) === 'local')
        return 'runtime'
    return 'saved'
}

// The saved providers this framework can actually use, in picker order.
// Mirrors the assertProtocol() narrowing in the API resolver so an
// incompatible row fails at picker time, not after the agent is created:
// codex only speaks /v1/responses, so chat-completions-only providers are
// hidden; managed Anthropic is hidden for openclaw / hermes because their
// tool-rich requests hit Claude.ai's "third-party app" rate limit on the
// shared managed account (BYO Anthropic stays); an admin-disabled managed
// channel stays usable for bound agents but must not be picked anew.
export const selectableProvidersFor = (
    options: readonly UserModelProviderSummary[],
    provider: UserModelProvider,
    framework?: AgentFramework
): UserModelProviderSummary[] =>
    options
        .filter((o) => providerSupportsTarget(o, provider))
        .filter((o) => !o.channelDisabled)
        .filter((o) => {
            if (!framework) return true
            const protocol = providerProtocolForTarget(o, provider)
            if (!protocol) return true
            return frameworkSupportsProtocol(framework, protocol)
        })
        .filter((o) => {
            if (!framework || !o.inferenceProtocol) return true
            return isManagedProtocolAllowedForFramework(
                framework,
                o.source,
                o.inferenceProtocol
            )
        })
        .sort((a, b) => {
            const sourceDelta =
                (a.source === 'managed' ? 0 : 1) -
                (b.source === 'managed' ? 0 : 1)
            if (sourceDelta !== 0) return sourceDelta
            return a.providerName.localeCompare(b.providerName)
        })

// The provider families a framework's Cloud list draws from. OpenClaw and
// Hermes speak both vendors' protocols, so their list is the union and a
// chip row filters it by family; a coding CLI has the one family its vendor
// gives it.
export type ProviderFamilyFilter = 'all' | UserModelProvider

export const PERSISTENT_PROVIDER_FAMILIES: readonly UserModelProvider[] = [
    'anthropic',
    'openai'
]

export const providerFamiliesFor = (
    framework: AgentFramework,
    fallback: UserModelProvider
): readonly UserModelProvider[] =>
    framework === 'openclaw' || framework === 'hermes'
        ? PERSISTENT_PROVIDER_FAMILIES
        : [fallback]

// The family a saved row belongs to, in the caller's order of preference: a
// built-in that speaks both protocols counts for the first family listed.
export const providerFamilyOf = (
    row: Pick<UserModelProviderSummary, 'builtInId' | 'inferenceProtocol'>,
    families: readonly UserModelProvider[]
): UserModelProvider | null =>
    families.find((family) => providerSupportsTarget(row, family)) ?? null

// selectableProvidersFor over several families, each row once, in the same
// order (managed first, then by name).
export const selectableProvidersForFamilies = (
    options: readonly UserModelProviderSummary[],
    families: readonly UserModelProvider[],
    framework?: AgentFramework
): UserModelProviderSummary[] => {
    const seen = new Set<string>()
    const rows: UserModelProviderSummary[] = []
    for (const family of families)
        for (const row of selectableProvidersFor(options, family, framework)) {
            if (seen.has(row.id)) continue
            seen.add(row.id)
            rows.push(row)
        }
    return rows.sort((a, b) => {
        const sourceDelta =
            (a.source === 'managed' ? 0 : 1) - (b.source === 'managed' ? 0 : 1)
        if (sourceDelta !== 0) return sourceDelta
        return a.providerName.localeCompare(b.providerName)
    })
}

// The catalog entries the "add a provider" menu offers: those with a
// protocol the target provider family accepts and the framework can talk.
export const builtInEntriesFor = (
    framework: AgentFramework,
    provider: UserModelProvider
): BuiltInProviderEntry[] => {
    const protocols = compatibleProtocolsForProvider(provider)
    return BUILT_IN_PROVIDERS.filter((entry) => {
        const protocol = builtInSupportsProtocol(entry, protocols)
        return (
            protocol !== null && frameworkSupportsProtocol(framework, protocol)
        )
    })
}

// The protocols a custom provider may be created with from the agent form:
// what the target family accepts, narrowed to what the framework can talk.
export const customProtocolsFor = (
    framework: AgentFramework,
    provider: UserModelProvider
): InferenceProtocol[] =>
    compatibleProtocolsForProvider(provider).filter((protocol) =>
        frameworkSupportsProtocol(framework, protocol)
    )

// What a saved provider's last test found, per protocol, for the row's
// description: the enabled subset when the user narrowed it, else all.
export const protocolModelCounts = (
    row: Pick<UserModelProviderSummary, 'lastTestModels' | 'enabledModels'>
): Array<{ protocol: string; count: number }> => {
    const tested = row.lastTestModels ?? {}
    return Object.keys(tested)
        .sort()
        .map((protocol) => ({
            protocol,
            count: (row.enabledModels?.[protocol] ?? tested[protocol] ?? [])
                .length
        }))
        .filter((entry) => entry.count > 0)
}

export const hostApiKeyEnvFor = (framework: AgentFramework): string => {
    if (framework === 'codex') return 'OPENAI_API_KEY'
    if (framework === 'gemini-cli') return 'GEMINI_API_KEY'
    return 'ANTHROPIC_API_KEY'
}

// What the create request can carry: an added account only when the host
// can list and run under it right now; the host sign-in is an inherited
// binding and needs nothing from the list.
export const localSelectionValid = (input: {
    target: ProviderTarget
    local: LocalCredentialSelection
    list: RuntimeAuthListView | null
}): boolean => {
    if (input.target.runtimeMode === 'new') return true
    if (input.local.profileId === '') return true
    if (runtimeAuthPickerState(input.list) !== 'ready') return false
    return (
        input.list?.profiles.some(
            (profile) =>
                profile.id === input.local.profileId && profileBindable(profile)
        ) ?? false
    )
}
