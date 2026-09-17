import { posix } from 'node:path'

export interface StoragePathReading {
    key: string
    path: string
    bytes: number | null
}

export const resolvedStoragePath = (
    path: string,
    home: string | null
): string | null => {
    const normalized = (value: string): string => {
        const result = posix.normalize(value)
        return result === '/' ? result : result.replace(/\/+$/, '')
    }
    if (path === '~' || path.startsWith('~/')) {
        if (!home || !posix.isAbsolute(home)) return null
        return normalized(posix.join(home, path.slice(2)))
    }
    return posix.isAbsolute(path) ? normalized(path) : null
}

const contains = (parent: string, child: string): boolean =>
    child !== parent && child.startsWith(parent === '/' ? '/' : `${parent}/`)

// Partition only known path containment. Raw du readings remain independent;
// symlink/inode identity, COW allocation and provider billing are not inferred.
export const attributeStoragePaths = (
    readings: StoragePathReading[],
    home: string | null
): {
    attributed: Map<string, number | null>
    complete: boolean
    unionBytes: number | null
} => {
    const attributed = new Map<string, number | null>(
        readings.map((reading) => [reading.key, null])
    )
    const groups = new Map<string, StoragePathReading[]>()
    let unresolved = false
    for (const reading of readings) {
        const path = resolvedStoragePath(reading.path, home)
        if (!path) {
            unresolved = true
            continue
        }
        const group = groups.get(path) ?? []
        group.push(reading)
        groups.set(path, group)
    }
    const paths = [...groups.keys()].sort(
        (a, b) => a.length - b.length || a.localeCompare(b)
    )
    const parents = new Map<string, string | undefined>()
    for (const path of paths)
        parents.set(
            path,
            paths
                .filter((candidate) => contains(candidate, path))
                .sort((a, b) => b.length - a.length)[0]
        )
    const measured = new Map<string, number | null>()
    for (const [path, rows] of groups) {
        const values = rows.map((row) => row.bytes)
        const first = values[0]
        measured.set(
            path,
            first !== null &&
                Number.isSafeInteger(first) &&
                first >= 0 &&
                values.every((value) => value === first)
                ? first
                : null
        )
    }
    let inconsistent = unresolved
    for (const [path, rows] of groups) {
        const total = measured.get(path)
        const children = paths.filter(
            (candidate) => parents.get(candidate) === path
        )
        const childValues = children.map((child) => measured.get(child) ?? null)
        if (
            total === null ||
            total === undefined ||
            childValues.some((value) => value === null)
        )
            continue
        const childBytes = childValues.reduce<number>(
            (sum, bytes) => sum + (bytes ?? 0),
            0
        )
        if (childBytes > total) {
            inconsistent = true
            continue
        }
        const [owner, ...aliases] = [...rows].sort((a, b) =>
            a.key.localeCompare(b.key)
        )
        attributed.set(owner.key, total - childBytes)
        for (const alias of aliases) attributed.set(alias.key, 0)
    }
    const roots = paths.filter((path) => parents.get(path) === undefined)
    const rootValues = roots.map((path) => measured.get(path) ?? null)
    const unionBytes =
        inconsistent || rootValues.some((value) => value === null)
            ? null
            : rootValues.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0)
    return {
        attributed,
        complete: [...attributed.values()].every((value) => value !== null),
        unionBytes
    }
}
