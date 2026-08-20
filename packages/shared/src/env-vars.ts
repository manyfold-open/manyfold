// Comment-preserving `.env` parser shared by the API (injection) and the web UI
// (by-entry display). The raw text is the source of truth — comments and ordering
// live in the stored text; this module only extracts the effective KEY=value set.
//
// Supported syntax (a pragmatic dotenv subset):
//   - `# comment` lines and blank lines (ignored here, retained in the raw text)
//   - `KEY=value` (unquoted; surrounding whitespace trimmed; trailing ` # ...`
//     inline comment stripped)
//   - `KEY="value"` / `KEY='value'` (quoted; quotes are not part of the value)
//   - quoted values spanning multiple physical lines (the mockup's multiline case)
//   - `\n` `\r` `\t` `\\` `\"` escapes inside double-quoted values

export interface EnvEntry {
    key: string
    value: string
    // 1-based line of the `KEY=` declaration (start line for multiline values).
    line: number
    // True when the key collides with a platform/framework/credential name; such
    // entries are shown with a warning and dropped at injection (envTextToRecord).
    reserved: boolean
}

export interface EnvParseError {
    line: number
    reason: string
}

export interface ParsedEnvText {
    entries: EnvEntry[]
    errors: EnvParseError[]
}

// Names we inject ourselves or that the frameworks/shell depend on. User entries
// matching these are flagged in the UI and never injected — the merge order
// (`{ ...userEnv, ...platformEnv }`) is the hard backstop; this is the friendly
// heads-up. NODE_ENV is deliberately NOT reserved — it's a legitimate user value.
export const RESERVED_ENV_PREFIXES = [
    'MF_',
    'MANYFOLD_',
    'NCA_',
    'HERMES_',
    'OPENCLAW_',
    'NARRANEXUS_',
    'NEXUS_',
    'ANTHROPIC_',
    'OPENAI_',
    'OPENROUTER_',
    'GOOGLE_',
    'GEMINI_',
    'CLAUDE_',
    // Managed GitHub/Cloudflare connection injection (platform-owned).
    'GITHUB_',
    'CLOUDFLARE_',
    'GIT_CONFIG_'
] as const

export const RESERVED_ENV_KEYS = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'PWD',
    'OLDPWD',
    'TERM',
    'LANG',
    'LC_ALL',
    'COLORTERM',
    'GH_TOKEN'
] as const

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const isReservedEnvKey = (key: string): boolean => {
    if ((RESERVED_ENV_KEYS as readonly string[]).includes(key)) return true
    return RESERVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
}

const unescapeDoubleQuoted = (value: string): string =>
    value.replace(/\\([nrt"\\])/g, (_, code: string) => {
        if (code === 'n') return '\n'
        if (code === 'r') return '\r'
        if (code === 't') return '\t'
        return code
    })

// Index of the closing quote, or -1 if this segment doesn't contain it. Double
// quotes honour backslash escapes (`\"` is not a closer); single quotes are
// literal so the next quote always closes.
const findClosingQuote = (segment: string, quote: string): number => {
    if (quote === "'") return segment.indexOf("'")
    let i = 0
    while (i < segment.length) {
        const ch = segment[i]
        if (ch === '\\') {
            i += 2
            continue
        }
        if (ch === '"') return i
        i += 1
    }
    return -1
}

interface QuotedRead {
    closed: boolean
    value: string
    endLine: number
}

const readQuotedValue = (
    quote: string,
    firstSegment: string,
    lines: string[],
    startLine: number
): QuotedRead => {
    const segments: string[] = []
    let lineIdx = startLine
    let remainder = firstSegment
    while (lineIdx < lines.length) {
        const closeIdx = findClosingQuote(remainder, quote)
        if (closeIdx !== -1) {
            segments.push(remainder.slice(0, closeIdx))
            const raw = segments.join('\n')
            return {
                closed: true,
                value: quote === '"' ? unescapeDoubleQuoted(raw) : raw,
                endLine: lineIdx
            }
        }
        segments.push(remainder)
        lineIdx += 1
        if (lineIdx < lines.length) remainder = lines[lineIdx]
    }
    return { closed: false, value: '', endLine: lines.length - 1 }
}

// An unquoted value ends at the first `#` preceded by whitespace (dotenv rule);
// `URL=http://x#y` keeps its `#`.
const stripInlineComment = (value: string): string => {
    const match = value.match(/\s#/)
    if (!match || match.index === undefined) return value
    return value.slice(0, match.index)
}

export const parseEnvText = (text: string): ParsedEnvText => {
    const entries: EnvEntry[] = []
    const errors: EnvParseError[] = []
    const lines = text.split(/\r?\n/)
    let i = 0
    while (i < lines.length) {
        const lineNo = i + 1
        const raw = lines[i]
        const lead = raw.replace(/^\s+/, '')
        if (lead === '' || lead.startsWith('#')) {
            i += 1
            continue
        }
        const eq = lead.indexOf('=')
        if (eq === -1) {
            errors.push({ line: lineNo, reason: 'missing "="' })
            i += 1
            continue
        }
        const key = lead.slice(0, eq).trim()
        if (!KEY_RE.test(key)) {
            errors.push({
                line: lineNo,
                reason: `invalid variable name "${key}"`
            })
            i += 1
            continue
        }
        const afterEq = lead.slice(eq + 1)
        const valueStart = afterEq.replace(/^[ \t]+/, '')
        const quote = valueStart[0]
        if (quote === '"' || quote === "'") {
            const read = readQuotedValue(quote, valueStart.slice(1), lines, i)
            if (!read.closed) {
                errors.push({
                    line: lineNo,
                    reason: 'unterminated quoted value'
                })
                break
            }
            entries.push({
                key,
                value: read.value,
                line: lineNo,
                reserved: isReservedEnvKey(key)
            })
            i = read.endLine + 1
            continue
        }
        entries.push({
            key,
            value: stripInlineComment(afterEq).trim(),
            line: lineNo,
            reserved: isReservedEnvKey(key)
        })
        i += 1
    }
    return { entries, errors }
}

// The effective env to inject: valid, non-reserved entries, last-wins on dup keys.
export const envTextToRecord = (
    text: string | null | undefined
): Record<string, string> => {
    if (!text) return {}
    const record: Record<string, string> = {}
    for (const entry of parseEnvText(text).entries) {
        if (entry.reserved) continue
        record[entry.key] = entry.value
    }
    return record
}

// Safely read the stored `.env` text out of an agent's untyped `extras` jsonb.
export const envTextFromExtras = (
    extras: Record<string, unknown> | null | undefined
): string | undefined => {
    const value = extras?.envText
    return typeof value === 'string' ? value : undefined
}