import type {
    K8sProviderRef,
    RuntimeHostRow,
    SpritesProviderRef
} from '@manyfold/db'

// Non-throwing narrowings of a host's provider_ref for the resource modules
// that render or filter by it; the adapters (hosts/providers) are the only
// writers.
export const spritesRef = (
    host: Pick<RuntimeHostRow, 'providerRef'>
): SpritesProviderRef | null =>
    host.providerRef?.kind === 'sprites' ? host.providerRef : null

export const k8sRef = (
    host: Pick<RuntimeHostRow, 'providerRef'>
): K8sProviderRef | null =>
    host.providerRef?.kind === 'k8s' ? host.providerRef : null

// The provider's own name for the machine, for operators: a sprite name or a
// namespace. Null before the provider has created it.
export const providerRefLabel = (
    host: Pick<RuntimeHostRow, 'providerRef'> | null
): string | null => {
    if (!host?.providerRef) return null
    if (host.providerRef.kind === 'sprites') return host.providerRef.spriteName
    return host.providerRef.namespace
}
