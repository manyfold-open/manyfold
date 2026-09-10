import { redactSensitiveUrlQuery } from './redact-url'

const REDACTED = 'REDACTED'
const SENSITIVE_FIELD =
    /(?:^|[._-])(?:authorization|cookie|set-cookie|token|(?:api|access|refresh)[_-]?token|api[_-]?key|password|secret)$/i

export const redactCredentialText = (text: string): string =>
    text
        .replace(/(?:\b[a-z][a-z0-9+.-]{0,31}:\/\/|\/|\?)[^\s<>"']+/gi, (url) =>
            redactSensitiveUrlQuery(url)
        )
        .replace(/\bBearer\s+[^\s"',;<>]+/gi, `Bearer ${REDACTED}`)
        .replace(
            /(["']?(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}&]+)/gi,
            `$1${REDACTED}`
        )
        .replace(/\b(?:ldt_|nca_rt_|nca_|mfs_)[A-Za-z0-9_-]{16,}/g, REDACTED)

export const redactCredentialValue = (value: unknown): unknown => {
    const seen = new WeakSet<object>()
    const visit = (item: unknown): unknown => {
        if (typeof item === 'string') return redactCredentialText(item)
        if (item === null || typeof item !== 'object') return item
        if (item instanceof Date)
            return Number.isNaN(item.getTime())
                ? 'Invalid Date'
                : item.toISOString()
        if (Buffer.isBuffer(item)) return '[Binary]'
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
        if (item instanceof Error)
            return {
                name: redactCredentialText(item.name),
                message: redactCredentialText(item.message),
                stack: item.stack
                    ? redactCredentialText(item.stack)
                    : undefined,
                ...(item.cause === undefined
                    ? {}
                    : { cause: visit(item.cause) })
            }
        if (Array.isArray(item)) return item.map(visit)
        return Object.fromEntries(
            Object.entries(item)
                .filter(([key]) => key !== 'url.query' && key !== 'http.query')
                .map(([key, entry]) => [
                    key,
                    SENSITIVE_FIELD.test(key) ? REDACTED : visit(entry)
                ])
        )
    }
    try {
        return visit(value)
    } catch {
        return '[Unserializable]'
    }
}
