import type { UserExternalAgentProviderSummary } from '@manyfold/shared'

// An external runtime records no provider id, only the endpoint it was bound
// to — so the dashboard's provider↔runtime join can only match on a
// normalized endpoint URL.
export const normalizeEndpoint = (url: string): string => {
    const trimmed = url.trim().replace(/\/+$/, '')
    try {
        return new URL(trimmed).toString().replace(/\/+$/, '')
    } catch {
        return trimmed.toLowerCase()
    }
}

export const providerRuntimeCounts = (
    providers: UserExternalAgentProviderSummary[],
    runtimeEndpoints: Array<string | null | undefined>
): Map<string, number> => {
    const used = new Map<string, number>()
    for (const endpoint of runtimeEndpoints) {
        if (typeof endpoint !== 'string' || endpoint.length === 0) continue
        const key = normalizeEndpoint(endpoint)
        used.set(key, (used.get(key) ?? 0) + 1)
    }
    return new Map(
        providers.map((p) => [
            p.id,
            used.get(normalizeEndpoint(p.endpointUrl)) ?? 0
        ])
    )
}
