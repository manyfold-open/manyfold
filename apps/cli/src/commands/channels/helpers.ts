import { readFile } from 'node:fs/promises'
import type { ChannelDetail } from '@manyfold/shared'

export interface RootChannelOptions {
    apiUrl?: string
    token?: string
    agentId?: string
}

export const parseJsonArg = async (
    raw: string,
    label: string
): Promise<Record<string, unknown>> => {
    let source = raw
    if (raw.startsWith('@')) {
        const path = raw.slice(1)
        if (!path)
            throw new Error(
                `${label}: @ prefix requires a file path (e.g. @path/to/file.json)`
            )
        source = await readFile(path, 'utf8')
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(source)
    } catch (err) {
        throw new Error(`${label}: invalid JSON (${(err as Error).message})`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`${label}: expected a JSON object`)
    return parsed as Record<string, unknown>
}

const DEFAULT_SENSITIVE_KEYS = [
    'credentialsCiphertext',
    'credentials',
    'credentialsPlaintext',
    'credentialsRaw',
    'apiKey',
    'token',
    'secret',
    'verificationToken',
    'encryptKey'
] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const maskValue = (value: unknown, keys: ReadonlySet<string>): unknown => {
    if (Array.isArray(value)) return value.map((item) => maskValue(item, keys))
    if (!isPlainObject(value)) return value
    const safe: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
        safe[key] = keys.has(key) ? '[redacted]' : maskValue(child, keys)
    }
    return safe
}

// Generalized sensitive-key masker. Replaces any matching key — at any
// nesting depth, including inside arrays — with the literal string
// '[redacted]'. Defense-in-depth: callers should still avoid passing
// secret-bearing objects unnecessarily.
export const maskSensitive = (
    obj: object,
    extraKeys: readonly string[] = []
): Record<string, unknown> => {
    const keys = new Set<string>([...DEFAULT_SENSITIVE_KEYS, ...extraKeys])
    return maskValue(obj, keys) as Record<string, unknown>
}

export const printChannel = (channel: ChannelDetail): void => {
    console.log(JSON.stringify(maskSensitive(channel), null, 2))
}
