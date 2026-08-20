import { readFileSync } from 'node:fs'

// stdin can only be consumed once per process, but a single action may resolve
// the root `--token -` several times (every buildClient call re-reads it, and
// a2a status issues two self-requests concurrently), so cache the first read.
let stdinCache: string | undefined

const readStdinOnce = (): string => {
    if (stdinCache === undefined) stdinCache = readFileSync(0, 'utf8')
    return stdinCache
}

export const resolveSecretInput = (
    value: string | undefined,
    optionName = '--token',
    readStdin: () => string = readStdinOnce
): string | undefined => {
    const trimmed = value?.trim()
    if (!trimmed) return undefined
    if (trimmed !== '-') return trimmed
    let secret: string
    try {
        secret = readStdin().trim()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${optionName} - could not read stdin: ${message}`)
    }
    if (!secret) throw new Error(`${optionName} - received empty stdin`)
    return secret
}
