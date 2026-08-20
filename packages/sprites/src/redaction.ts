const TOKEN_PATTERNS: readonly RegExp[] = [
    /Bearer\s+[A-Za-z0-9._+/=-]{8,}/gi,
    /\b[a-f0-9]{32,}\b/gi,
    /sk-[A-Za-z0-9_-]{10,}/g
]

export const redact = (input: string): string => {
    let out = input
    for (const re of TOKEN_PATTERNS) out = out.replace(re, '[REDACTED]')
    return out
}

export const redactHeaders = (
    headers: Record<string, string | string[] | undefined>
): Record<string, string | string[] | undefined> => {
    const clone: Record<string, string | string[] | undefined> = {}
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'authorization') {
            clone[k] = '[REDACTED]'
        } else if (typeof v === 'string') {
            clone[k] = redact(v)
        } else if (Array.isArray(v)) {
            clone[k] = v.map(redact)
        } else {
            clone[k] = v
        }
    }
    return clone
}
