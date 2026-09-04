import type { InferenceProtocol, ProtocolModelMap } from '@manyfold/shared'

export interface ModelGroup {
    protocol: InferenceProtocol
    models: string[]
}

// A row in this list is a (protocol, model) pair, not a model. The same model
// id can be served over several protocols with its own enabled state on each,
// which is why the flat list had to carry a protocol tag on every row to say
// which ones a row stood for. Grouping states it once per group instead.
export const buildModelGroups = (
    rowMap: ProtocolModelMap | null | undefined,
    query = ''
): ModelGroup[] => {
    if (!rowMap) return []
    const needle = query.trim().toLowerCase()
    const groups: ModelGroup[] = []
    for (const [protocol, models] of Object.entries(rowMap)) {
        const matched = needle
            ? models.filter((modelId) =>
                  modelId.toLowerCase().includes(needle)
              )
            : [...models]
        if (matched.length === 0) continue
        groups.push({
            protocol: protocol as InferenceProtocol,
            models: matched
        })
    }
    return groups
}

// Pairs, not distinct model ids: the tab counts are per protocol, so a total
// that de-duplicates across them cannot be the sum of its own tabs.
export const countModelPairs = (groups: ModelGroup[]): number =>
    groups.reduce((total, group) => total + group.models.length, 0)

export const enabledPairCount = (
    groups: ModelGroup[],
    enabledMap: Record<string, Set<string> | 'all'>
): number =>
    groups.reduce((total, group) => {
        const state = enabledMap[group.protocol]
        if (state === 'all') return total + group.models.length
        if (state instanceof Set)
            return (
                total +
                group.models.filter((modelId) => state.has(modelId)).length
            )
        return total
    }, 0)
