// Postgres rejects \u0000 in jsonb ("unsupported Unicode escape sequence")
// and lone UTF-16 surrogates; agent output (tokens, tool results) can carry
// both. Strip NUL and replace lone surrogates before any jsonb write.
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g

const sanitizeText = (value: string): string =>
    value
        .replaceAll('\u0000', '')
        .replace(SURROGATES, (match) =>
            match.length === 2 ? match : '\uFFFD'
        )

// Postgres TEXT columns reject NUL the same way jsonb does — reuse for any
// user-supplied text destined for a text column.
export const sanitizePgText = sanitizeText

const isHighSurrogate = (code: number): boolean =>
    code >= 0xd800 && code <= 0xdbff

// Sanitize one chunk of a text stream that will be concatenated with the
// chunks around it. Sanitizing each chunk in isolation would be wrong: an
// agent can split a surrogate PAIR across two deltas, and running the lone
// surrogate rule over each half turns one emoji into two U+FFFD. So a
// trailing high surrogate is not sanitized, it is handed back as `carry` for
// the caller to prepend to the next delta. NUL is stripped before that check
// because it can sit between the two halves too. A carry left over when the
// stream ends is a genuinely lone surrogate — flush it through sanitizePgText.
export const sanitizeStreamDelta = (
    carry: string,
    delta: string
): { text: string; carry: string } => {
    const stripped = (carry + delta).replaceAll('\u0000', '')
    const held = isHighSurrogate(stripped.charCodeAt(stripped.length - 1))
    const body = held ? stripped.slice(0, -1) : stripped
    return {
        text: body.replace(SURROGATES, (match) =>
            match.length === 2 ? match : '\uFFFD'
        ),
        carry: held ? stripped.slice(-1) : ''
    }
}

const isPlainObject = (value: object): boolean => {
    const proto: unknown = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

const sanitizeValue = (value: unknown): unknown => {
    if (typeof value === 'string') return sanitizeText(value)
    if (Array.isArray(value)) return value.map(sanitizeValue)
    if (value !== null && typeof value === 'object' && isPlainObject(value)) {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value))
            out[sanitizeText(key)] = sanitizeValue(item)
        return out
    }
    return value
}

export const sanitizeForJsonb = <T>(value: T): T => sanitizeValue(value) as T
