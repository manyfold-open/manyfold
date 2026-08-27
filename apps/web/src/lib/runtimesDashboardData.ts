import type { UserExternalAgentProviderSummary } from '@manyfold/shared'

// An external runtime records no provider id, only the endpoint it was bound
// to — so the dashboard's runtime↔provider join can only match on a
// normalized endpoint URL.
export const normalizeEndpoint = (url: string): string => {
    const trimmed = url.trim().replace(/\/+$/, '')
    try {
        return new URL(trimmed).toString().replace(/\/+$/, '')
    } catch {
        return trimmed.toLowerCase()
    }
}

export const matchProviderByEndpoint = (
    providers: UserExternalAgentProviderSummary[],
    endpointUrl: string | null | undefined
): UserExternalAgentProviderSummary | null => {
    if (!endpointUrl) return null
    const target = normalizeEndpoint(endpointUrl)
    return (
        providers.find((p) => normalizeEndpoint(p.endpointUrl) === target) ??
        null
    )
}

export const unusedProviders = (
    providers: UserExternalAgentProviderSummary[],
    usedEndpoints: Array<string | null | undefined>
): UserExternalAgentProviderSummary[] => {
    const used = new Set(
        usedEndpoints
            .filter((e): e is string => typeof e === 'string' && e.length > 0)
            .map(normalizeEndpoint)
    )
    return providers.filter((p) => !used.has(normalizeEndpoint(p.endpointUrl)))
}
