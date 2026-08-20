import {
    AgentFramework,
    AgentRuntimeSummary,
    UserModelProvider,
    UserModelProviderSummary,
    brandFor,
    frameworkSupportsProtocol,
    isManagedProtocolAllowedForFramework,
    providerProtocolForTarget,
    providerSupportsTarget
} from '@manyfold/shared'
import { managedChannelRank } from '@/lib/agentCreate/managedRank'

// Mirrors the pickers' own filtering: a row the picker hides (an admin-disabled
// managed channel, or one whose protocol the framework can't talk) must not
// become the auto-selected default either, or the select renders with nothing
// selected and create submits a provider the user never saw. Pass `framework`
// wherever it is known.
export const preferredSavedProviderFor = (
    options: UserModelProviderSummary[],
    provider: UserModelProvider,
    framework?: AgentFramework
): UserModelProviderSummary | null => {
    const filtered = options
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
            if (a.source === 'managed' && b.source === 'managed') {
                const rankDelta =
                    managedChannelRank(brandFor(a)) -
                    managedChannelRank(brandFor(b))
                if (rankDelta !== 0) return rankDelta
            }
            return a.providerName.localeCompare(b.providerName)
        })
    return filtered[0] ?? null
}

// Managed Gemini and Managed Antigravity both speak google_generate_content, so
// a gemini-family picker lists two managed rows — and a picker that renders
// every managed row under one platform name shows them as the same option
// twice. Keep one channel per protocol (declaration order, so the Antigravity
// fallback only surfaces when Managed Gemini is off or absent), plus whatever
// the user already selected so an explicit pick never vanishes from the list.
export const collapseManagedChannels = (
    options: UserModelProviderSummary[],
    keepId?: string
): UserModelProviderSummary[] => {
    const keptPerProtocol = new Map<string, string>()
    for (const option of options
        .filter((o) => o.source === 'managed')
        .sort(
            (a, b) =>
                managedChannelRank(brandFor(a)) -
                managedChannelRank(brandFor(b))
        )) {
        const protocol = option.inferenceProtocol ?? ''
        if (!keptPerProtocol.has(protocol))
            keptPerProtocol.set(protocol, option.id)
    }
    return options.filter(
        (o) =>
            o.source !== 'managed' ||
            o.id === keepId ||
            keptPerProtocol.get(o.inferenceProtocol ?? '') === o.id
    )
}

export const openclawWorkspaceFor = (
    runtime: AgentRuntimeSummary,
    agentName: string
): string => {
    const daemonBase =
        runtime.kind === 'daemon' && runtime.homeDir
            ? `${runtime.homeDir.replace(/\/+$/, '')}/.openclaw`
            : null
    const base = (
        daemonBase ??
        runtime.mountPath ??
        '~/.openclaw'
    ).replace(/\/+$/, '')
    const suffix = (agentName.trim() || 'agent').replace(/\s+/g, '-')
    return `${base}/workspace-${suffix}`
}