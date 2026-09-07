// Google Chat renders its own markdown dialect, not CommonMark: bold is a
// single *asterisk*, italic a single _underscore_, strikethrough a single
// ~tilde~, and links are <url|label>. Headings, tables and ordered lists have
// no rendering at all, so they are folded into shapes Chat does render.
//
// Code spans and fenced blocks are held out of every transform. Chat renders
// them verbatim, and rewriting inside one corrupts the code — `[x](y)` in a
// snippet is not a link, and `**p` is not bold.
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]+`)/g

const HEADING_RE = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g
// Bold and italic in one alternation: converting bold first and italic second
// would re-match the *bold* this pass just produced and demote it to _bold_.
const EMPHASIS_RE = /\*\*(.+?)\*\*|__(.+?)__|\*(?![\s*])([^*\n]+?)\*/g
const STRIKE_RE = /~~(.+?)~~/g
const ORDERED_ITEM_RE = /^([ \t]*)\d+[.)][ \t]+/gm
const HORIZONTAL_RULE_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm
const BLANK_LINES_RE = /\n{3,}/g

export const markdownToGoogleChat = (text: string): string => {
    const segments = text.split(CODE_SEGMENT_RE)
    return segments
        .map((segment, index) =>
            // split() with a capturing group puts the delimiters at odd
            // indices; those are the code spans, passed through untouched.
            index % 2 === 1 ? segment : convertSegment(segment)
        )
        .join('')
        .replace(BLANK_LINES_RE, '\n\n')
        .trim()
}

const convertSegment = (segment: string): string =>
    segment
        // Chat drops the # entirely, so a heading would read as body text.
        // Emit markdown bold and let the emphasis pass below render it.
        .replace(HEADING_RE, (_match, content: string) => `**${content.replace(/\*\*/g, '')}**`)
        .replace(LINK_RE, '<$2|$1>')
        .replace(
            EMPHASIS_RE,
            (
                _match,
                boldStars: string | undefined,
                boldUnderscores: string | undefined,
                italic: string | undefined
            ) => {
                const bold = boldStars ?? boldUnderscores
                return bold !== undefined ? `*${bold}*` : `_${italic}_`
            }
        )
        .replace(STRIKE_RE, '~$1~')
        // Chat renders no list markup, but it does honor the bullet character,
        // so a numbered list at least keeps its shape.
        .replace(ORDERED_ITEM_RE, '$1• ')
        .replace(HORIZONTAL_RULE_RE, '')
