export const flattenSavedModels = (
    map: Record<string, string[]> | null | undefined
): string[] => {
    if (!map) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const list of Object.values(map)) {
        for (const id of list) {
            if (seen.has(id)) continue
            seen.add(id)
            out.push(id)
        }
    }
    return out
}
