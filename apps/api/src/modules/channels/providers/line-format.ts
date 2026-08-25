// LINE renders every message body as plain text — the Messaging API has no
// markdown, HTML or rich-text mode — so agent replies are flattened before
// they go out.
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

export const markdownToLinePlainText = (text: string): string =>
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
