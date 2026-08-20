export type ManagedChannelFailureSignal = 'account_pool_empty'

const MANAGED_POOL_EMPTY_MESSAGES: ReadonlySet<string> = new Set([
    'No available accounts',
    'No available accounts: no available accounts',
    'No available Antigravity accounts',
    'No available Antigravity accounts: no available accounts',
    'No available Gemini accounts',
    'No available Gemini accounts: no available accounts'
])

const structuredErrorFromMessage = (
    message: string
): { code?: unknown; message?: unknown } | null => {
    const end = message.lastIndexOf('}')
    if (end < 0) return null
    let start = message.indexOf('{')
    while (start >= 0 && start < end) {
        try {
            const parsed = JSON.parse(message.slice(start, end + 1)) as {
                error?: unknown
            }
            if (
                parsed.error &&
                typeof parsed.error === 'object' &&
                !Array.isArray(parsed.error)
            )
                return parsed.error as { code?: unknown; message?: unknown }
        } catch {
            start = message.indexOf('{', start + 1)
            continue
        }
        start = message.indexOf('{', start + 1)
    }
    return null
}

// gemini-cli lets the gateway's `_ApiError` reach Node's top level, so the pool
// cause arrives as util.inspect output rather than as JSON. #660 stayed open
// after the first reader because that reader was a character class that rejected
// every `[` in the cause body, and the real gateway error carries a third field
// beside the pair worth reading: `details: []`, the google.rpc.Status member.
//
// So the body needs an actual reader. The one below walks EXACTLY ONE object
// level and collects only that object's own pairs — searching the body for the
// pair at any depth is the permissive shape to avoid, because
// `detail: { code: 503, message: '…' }` is text a failed tool result can print.
// Malformed, truncated and elision-spliced bodies fail the grammar instead of
// contributing a partial match, and both authoritative values are compared as
// exact literals rather than matched as prose.
const INSPECTED_CAUSE_KEY_RE = /(?:^|[\s,{])(?:\[cause\]|cause)\s*:\s*\{/g
// Key spellings util.inspect emits: a bare identifier, a bracketed non-string
// key (`[cause]`, `[Symbol(x)]`), or a single-quoted key for anything else.
const INSPECTED_KEY_RE = /[A-Za-z_$][\w$]*|\[[^[\]\r\n]*\]|'[^'\\\r\n]*'/y
// Node prints this string with single quotes and no escapes: every allowlisted
// message is plain ASCII with no quote of either kind in it, so a value that
// needed an escape, a different quote or any trailing expression is not the
// value Node printed for it.
const INSPECTED_MESSAGE_LITERAL_RE = /^'([^'\\\r\n]*)'$/
const INSPECTED_POOL_EMPTY_CODE = '503'
// Bounds, so a hostile or merely enormous stderr cannot make this quadratic.
// The real block is one of a handful of candidates and a few hundred bytes; the
// stderr the adapter classifies is itself capped at a few KB.
const MAX_INSPECTED_CAUSE_CANDIDATES = 256
const MAX_INSPECTED_CAUSE_BODY_CHARS = 8_192

const isInspectValueOpen = (ch: string): boolean =>
    ch === '{' || ch === '[' || ch === '('

const isInspectValueClose = (ch: string): boolean =>
    ch === '}' || ch === ']' || ch === ')'

// Index of the top-level `,` or `}` that ends the value starting at `from`, or
// -1 when the value never ends inside the budget. Nested containers and quoted
// runs are skipped whole, which is what keeps a nested `code`/`message` pair out
// of the parsed level entirely.
const inspectValueEnd = (text: string, from: number, limit: number): number => {
    const closers: string[] = []
    for (let i = from; i < limit; i += 1) {
        const ch = text[i]
        if (ch === "'" || ch === '"' || ch === '`') {
            i += 1
            while (i < limit && text[i] !== ch) i += text[i] === '\\' ? 2 : 1
            if (i >= limit) return -1
            continue
        }
        if (isInspectValueOpen(ch)) {
            closers.push(ch === '{' ? '}' : ch === '[' ? ']' : ')')
            continue
        }
        if (isInspectValueClose(ch)) {
            if (closers.length > 0) {
                if (closers.at(-1) !== ch) return -1
                closers.pop()
                continue
            }
            // An unbalanced closer that is not this object's own is malformed.
            return ch === '}' ? i : -1
        }
        if (ch === ',' && closers.length === 0) return i
    }
    return -1
}

// The own pairs of the inspect object opening at `open`, or null when the text
// is not one well-formed object body. Duplicate keys are treated as malformed:
// util.inspect cannot print them, and accepting them would make the verdict
// depend on whether the first or the last spelling of `code` wins.
const inspectObjectPairs = (
    text: string,
    open: number
): Map<string, string> | null => {
    const limit = Math.min(text.length, open + MAX_INSPECTED_CAUSE_BODY_CHARS)
    const pairs = new Map<string, string>()
    const ownKeys = new Set<string>()
    let i = open + 1
    const skipSpace = (): void => {
        while (i < limit && /\s/.test(text[i])) i += 1
    }
    skipSpace()
    if (i < limit && text[i] === '}') return pairs
    for (;;) {
        INSPECTED_KEY_RE.lastIndex = i
        const key = INSPECTED_KEY_RE.exec(text)?.[0]
        if (!key) return null
        i += key.length
        skipSpace()
        if (text[i] !== ':') return null
        i += 1
        skipSpace()
        const end = inspectValueEnd(text, i, limit)
        if (end < 0) return null
        const value = text.slice(i, end).trim()
        const ownKey = key.startsWith("'") ? key.slice(1, -1) : key
        if (!value || ownKeys.has(ownKey)) return null
        ownKeys.add(ownKey)
        pairs.set(key, value)
        i = end
        if (text[i] === '}') return pairs
        i += 1
        skipSpace()
    }
}

const isInspectedPoolEmptyCause = (pairs: Map<string, string>): boolean => {
    if (pairs.get('code') !== INSPECTED_POOL_EMPTY_CODE) return false
    const literal = pairs.get('message')?.match(INSPECTED_MESSAGE_LITERAL_RE)
    return !!literal && MANAGED_POOL_EMPTY_MESSAGES.has(literal[1])
}

export const countGeminiCliInspectedPoolEmptyCauses = (
    message: string
): number => {
    let count = 0
    let candidates = 0
    INSPECTED_CAUSE_KEY_RE.lastIndex = 0
    for (
        let match = INSPECTED_CAUSE_KEY_RE.exec(message);
        match && candidates < MAX_INSPECTED_CAUSE_CANDIDATES;
        match = INSPECTED_CAUSE_KEY_RE.exec(message)
    ) {
        candidates += 1
        const open = match.index + match[0].length - 1
        const pairs = inspectObjectPairs(message, open)
        if (pairs && isInspectedPoolEmptyCause(pairs)) count += 1
        // Resume inside this block rather than past it: a cause chain prints
        // one cause inside another, and both halves of the provenance
        // subtraction have to count the same way over the same bytes.
        INSPECTED_CAUSE_KEY_RE.lastIndex = open
    }
    return count
}

export const classifyManagedChannelFailureSignal = (signal: {
    status?: number | null
    message?: string | null
}): ManagedChannelFailureSignal | null => {
    const message = signal.message ?? ''
    const error = structuredErrorFromMessage(message)
    if (
        error &&
        typeof error.message === 'string' &&
        (signal.status === 503 || error.code === 503 || error.code === '503') &&
        MANAGED_POOL_EMPTY_MESSAGES.has(error.message)
    )
        return 'account_pool_empty'
    return null
}

export const classifyGeminiCliInspectedFailureSignal = (signal: {
    machineStderr?: string | null
    untrustedCauseCount: number
}): ManagedChannelFailureSignal | null =>
    // Gemini mirrors recoverable tool failures to process stderr. The adapter
    // subtracts blocks already attributed to typed tool-result stdout before
    // stderr can teach the shared breaker. A simultaneous real cause remains.
    countGeminiCliInspectedPoolEmptyCauses(signal.machineStderr ?? '') >
    signal.untrustedCauseCount
        ? 'account_pool_empty'
        : null
