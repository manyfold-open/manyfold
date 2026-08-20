// Auto-generated labels are <host-name>-<framework>, and host names are not
// unique, so the base label can already be taken. Names are NOT db-unique — the
// suffix is readability, and users may rename to anything afterwards.
export const nextFreeLabel = (base: string, taken: Set<string>): string => {
    if (!taken.has(base)) return base
    for (let n = 2; ; n += 1) {
        const candidate = `${base}-${n}`
        if (!taken.has(candidate)) return candidate
    }
}
