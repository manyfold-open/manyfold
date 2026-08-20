export interface GrantPermissionContent {
    text: string
    tokens: string[]
}

const GRANT_URL_SOURCE = 'https?://[^\\s)<>"\'`]*/grant-permission\\?[^\\s)<>"\'`]*'

// `[label](grant-url)` — strip the whole markdown link, keep nothing behind.
const MARKDOWN_LINK_RE = new RegExp(
    `\\[[^\\]]*\\]\\(\\s*(${GRANT_URL_SOURCE})\\s*\\)`,
    'gi'
)
// A bare grant-permission URL sitting in prose.
const BARE_URL_RE = new RegExp(GRANT_URL_SOURCE, 'gi')
// Fenced code blocks and inline code spans are captured so they survive intact.
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g
const TRAILING_PUNCT_RE = /[.,;:!?]+$/

const extractToken = (rawUrl: string): string | null => {
    try {
        const parsed = new URL(rawUrl)
        if (!parsed.pathname.endsWith('/grant-permission')) return null
        return parsed.searchParams.get('token')
    } catch {
        return null
    }
}

const collapseBlankLines = (value: string): string =>
    value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')

// Detects manyfold `/grant-permission?token=…` consent links in assistant
// markdown and lifts them out: callers render a permission card for each token
// instead of a raw URL. URLs inside code blocks/spans are left untouched so we
// never mangle a code sample that happens to contain one.
export const splitGrantPermissionContent = (
    input: string
): GrantPermissionContent => {
    const tokens: string[] = []
    const seen = new Set<string>()

    const collect = (rawUrl: string): void => {
        const token = extractToken(rawUrl)
        if (!token || seen.has(token)) return
        seen.add(token)
        tokens.push(token)
    }

    const stripFromProse = (prose: string): string =>
        prose
            .replace(MARKDOWN_LINK_RE, (_match, url: string) => {
                collect(url)
                return ''
            })
            .replace(BARE_URL_RE, (match: string) => {
                const trailing = TRAILING_PUNCT_RE.exec(match)?.[0] ?? ''
                collect(match.slice(0, match.length - trailing.length))
                return trailing
            })

    const rebuilt = input
        .split(CODE_SEGMENT_RE)
        .map((part, index) => (index % 2 === 1 ? part : stripFromProse(part)))
        .join('')

    return { text: collapseBlankLines(rebuilt).trim(), tokens }
}
