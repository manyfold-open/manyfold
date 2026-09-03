import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// File and token helpers shared by the daemon's runtime-local inspectors
// (model.inspect in rpc.ts and account.inspect in account-inspect.ts). They
// live apart from rpc.ts so the account inspector can import them without an
// import cycle through the handler table.

export const expandHome = (p: string): string =>
    p.startsWith('~') ? p.replace(/^~/, homedir()) : p

export const readTextIfPresent = async (
    path: string
): Promise<{ ok: boolean; text: string | null; error: string | null }> => {
    try {
        return { ok: true, text: await readFile(path, 'utf8'), error: null }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return { ok: false, text: null, error: null }
        return { ok: false, text: null, error: (err as Error).message }
    }
}

export const codexHomeDir = (): string => {
    const raw = process.env.CODEX_HOME?.trim()
    return raw ? resolve(expandHome(raw)) : join(homedir(), '.codex')
}

export const parseJsonRecord = (
    text: string | null
): Record<string, unknown> | null => {
    if (!text?.trim()) return null
    try {
        const parsed = JSON.parse(text) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null
    } catch {
        return null
    }
}

export const nestedRecord = (
    record: Record<string, unknown> | null,
    key: string
): Record<string, unknown> | null => {
    const value = record?.[key]
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

export const nonEmptyString = (value: unknown): boolean =>
    typeof value === 'string' && value.trim().length > 0

// Decodes a JWT payload without verifying the signature: the daemon only
// reads what the CLI itself trusts (expiry, the signed-in email), never uses
// the claims to grant anything.
export const jwtClaims = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'string') return null
    const payload = value.split('.')[1]
    if (!payload) return null
    try {
        return parseJsonRecord(
            Buffer.from(
                payload.replace(/-/g, '+').replace(/_/g, '/'),
                'base64'
            ).toString('utf8')
        )
    } catch {
        return null
    }
}

// Reads the `exp` claim so the daemon knows when the CLI will consider the
// token stale.
export const jwtExpiryMs = (value: unknown): number | null => {
    const exp = jwtClaims(value)?.exp
    return typeof exp === 'number' && Number.isFinite(exp)
        ? Math.round(exp * 1000)
        : null
}
