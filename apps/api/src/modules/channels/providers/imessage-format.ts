// iMessage renders every message body as plain text — Messages.app applies no
// markdown — so agent replies are flattened before they go out.
//
// The underscore forms of bold (`__bold__`) and italic (`_italic_`) are
// deliberately left alone: they are indistinguishable from snake_case and
// dunder identifiers, so stripping them corrupts `my_func_name` into
// `myfuncname` and `__init__` into `init`. Agents reliably emit the asterisk
// forms, which makes dropping the underscore forms the safe trade.
const CODE_BLOCK_RE = /```[a-zA-Z]*\n?([\s\S]*?)```/g
const INLINE_CODE_RE = /`([^`]+)`/g
const BOLD_RE = /\*\*(.+?)\*\*/g
const ITALIC_RE = /\*(.+?)\*/g
const STRIKE_RE = /~~(.+?)~~/g
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const HEADING_RE = /^#{1,6}\s+/gm
const HORIZONTAL_RULE_RE = /^---+\s*$/gm
const BLOCKQUOTE_RE = /^>\s?/gm
const BLANK_LINES_RE = /\n{3,}/g

export const markdownToIMessagePlainText = (text: string): string =>
    text
        .replace(CODE_BLOCK_RE, '$1')
        .replace(INLINE_CODE_RE, '$1')
        .replace(BOLD_RE, '$1')
        .replace(ITALIC_RE, '$1')
        .replace(STRIKE_RE, '$1')
        .replace(LINK_RE, '$1 ($2)')
        .replace(HEADING_RE, '')
        .replace(HORIZONTAL_RULE_RE, '')
        .replace(BLOCKQUOTE_RE, '')
        .replace(BLANK_LINES_RE, '\n\n')
        .trim()

// One long bubble is unreadable in Messages and iMessage has no formatting to
// structure it, so each paragraph becomes its own bubble. Splitting runs after
// the markdown has already been flattened, which is why chunkText's fence
// preservation is a no-op here and only its length budget matters.
export const splitIMessageBubbles = (text: string, max: number): string[] =>
    text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0)
        .flatMap((paragraph) =>
            paragraph.length <= max ? [paragraph] : chunkPlain(paragraph, max)
        )

const chunkPlain = (text: string, max: number): string[] => {
    const out: string[] = []
    let remaining = text
    while (remaining.length > max) {
        let cut = remaining.lastIndexOf('\n', max)
        if (cut < max / 2) cut = remaining.lastIndexOf(' ', max)
        if (cut <= 0) cut = max
        out.push(remaining.slice(0, cut).trimEnd())
        remaining = remaining.slice(cut).trimStart()
    }
    if (remaining.length > 0) out.push(remaining)
    return out
}

const REGEX_META_RE = /[.*+?^${}()|[\]\\]/g

// iMessage has no bot identity to @-mention, so group turns are gated on a wake
// word. These are matched as escaped literals, never as user-supplied patterns:
// parseInbound runs on the unauthenticated webhook path, where a hostile regex
// would be a ReDoS against every channel sharing the instance.
export const compileWakeWords = (words: string[]): RegExp | null => {
    const literals = words
        .map((word) => word.trim())
        .filter((word) => word.length > 0)
        .map((word) => {
            const escaped = word.replace(REGEX_META_RE, '\\$&')
            // \b only means "end of word" after a word character. A wake word
            // ending in punctuation ('hey (bot)') would otherwise never match,
            // because \b there demands a word character follows.
            return /\w$/.test(word) ? `${escaped}\\b` : escaped
        })
    if (literals.length === 0) return null
    // The lookbehind keeps a wake word from matching inside an email or handle.
    return new RegExp(`(?<![\\w@])@?(?:${literals.join('|')})`, 'iu')
}

// Only strips at the head: a wake word that also occurs mid-sentence is an
// ordinary word there, and deleting it would corrupt the message.
export const stripLeadingWakeWord = (text: string, re: RegExp): string => {
    const anchored = new RegExp(`^\\s*(?:${re.source})`, re.flags)
    return text.replace(anchored, '').replace(/^[\s,:.\-—]+/, '')
}
