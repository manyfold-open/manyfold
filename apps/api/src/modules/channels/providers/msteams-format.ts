// Teams renders a Markdown subset in a bot message sent with
// textFormat: 'markdown'. Bold, italic, strikethrough, links, bullet and
// numbered lists, inline code, fenced blocks and blockquotes all work as
// written, so most text passes through untouched.
//
// Headings are the exception: Teams strips the leading #, leaving a heading
// indistinguishable from body text. They are promoted to bold instead.
// Tables are handled upstream by the shared wrapMarkdownTables, which fences
// them so they arrive monospaced rather than as pipe soup.
//
// Code spans and fenced blocks are held out of the transform. Teams renders
// them verbatim, and rewriting inside one corrupts the code — a '# ' at the
// start of a line in a shell snippet is a comment, not a heading.
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]+`)/g

const HEADING_RE = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm
const BLANK_LINES_RE = /\n{3,}/g

export const markdownToMsTeams = (text: string): string =>
    text
        .split(CODE_SEGMENT_RE)
        .map((segment, index) =>
            // split() with a capturing group puts the delimiters at odd
            // indices; those are the code spans, passed through untouched.
            index % 2 === 1 ? segment : convertSegment(segment)
        )
        .join('')
        .replace(BLANK_LINES_RE, '\n\n')
        .trim()

const convertSegment = (segment: string): string =>
    segment.replace(
        HEADING_RE,
        // Strip any bold the heading already carries, or the wrapper would
        // nest into '****text****' and render literally.
        (_match, content: string) => `**${content.replace(/\*\*/g, '')}**`
    )

// Teams delivers an @mention as '<at>Display Name</at>' in the activity text,
// with the real identity in entities[]. The bot's own mention is pure framing
// and is removed; a mention of someone else is information the agent needs, so
// it is flattened to that person's name.
//
// The display name inside the tag is attacker-controlled — a group member can
// rename themselves '<at>Bot</at>' — so which mention is whose is decided by
// entities[].mentioned.id, never by the text.
export interface MsTeamsMentionSpan {
    text: string
    id: string | null
    name: string | null
}

const MENTION_TAG_RE = /<at\b[^>]*>[\s\S]*?<\/at>/gi
const COLLAPSE_SPACES_RE = /[ \t]{2,}/g

export const stripMsTeamsMentions = (
    text: string,
    mentions: MsTeamsMentionSpan[] = [],
    botId: string | null = null
): string => {
    let out = text
    for (const mention of mentions) {
        if (!mention.text) continue
        const replacement =
            botId !== null && mention.id === botId ? ' ' : ` ${mention.name ?? ''} `
        out = out.split(mention.text).join(replacement)
    }
    // Anything entities[] did not describe — a mention of a departed member, or
    // a payload where Teams omitted the entity — still must not reach the agent
    // as raw markup.
    return out.replace(MENTION_TAG_RE, ' ').replace(COLLAPSE_SPACES_RE, ' ').trim()
}

