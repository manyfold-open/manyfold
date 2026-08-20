import type * as PtyTypes from 'node-pty'

let ptyMod: typeof PtyTypes | null = null

export const resolvePtyModule = (value: unknown): typeof PtyTypes | null => {
    if (hasSpawn(value)) return value as typeof PtyTypes
    if (
        value &&
        typeof value === 'object' &&
        'default' in value &&
        hasSpawn((value as { default?: unknown }).default)
    )
        return (value as { default: typeof PtyTypes }).default
    return null
}

export const loadPty = async (): Promise<typeof PtyTypes> => {
    if (ptyMod) return ptyMod
    const loaded = await import('node-pty')
    const resolved = resolvePtyModule(loaded)
    if (!resolved) throw new Error('node-pty loaded but did not expose spawn')
    ptyMod = resolved
    return ptyMod
}

const hasSpawn = (value: unknown): boolean =>
    !!value &&
    typeof value === 'object' &&
    typeof (value as { spawn?: unknown }).spawn === 'function'
