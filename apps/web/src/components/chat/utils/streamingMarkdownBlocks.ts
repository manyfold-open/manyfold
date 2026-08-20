import {
    type MarkdownBlockScan,
    scanMarkdownBlocks
} from '@/components/chat/utils/markdownBlocks'
import {
    healMarkdownSpan,
    mathSpanRenderable
} from '@/components/chat/utils/streamingMarkdown'

export interface StreamingMarkdownBlocks {
    next: (text: string) => string[]
}

// A split point is only ever taken where the text after it starts with a
// blank line. remend's setext handler reads the line BEFORE the last line of
// the string, and its thematic-break check reads the whole line a marker sits
// on, so a window that opens mid-paragraph would be reading a line the
// document does not end there: heal("plain\n-") is "plain\n-\u200b" while
// "plain" + heal("\n-") is not. A blank line puts an empty line in front of
// the window's first content line in both readings, which is also why every
// probe below opens on one.
const BLANK_LINE = /[^\S\r\n]*\r?\n[^\S\r\n]*\r?\n/y
const atBlankLine = (text: string, offset: number): boolean => {
    BLANK_LINE.lastIndex = offset
    return BLANK_LINE.test(text)
}

// One trailing block per class of state remend carries forward, each ending
// in a half-typed marker so the handler for that class has to decide. Adding
// one to a settled span and re-healing asks remend itself whether the span
// leaves anything behind for a later tail to trip over — an unclosed `[` or
// `<tag` (both truncate everything after them), an odd count of any emphasis
// or code or math marker (every closer is chosen off a parity taken over the
// whole string), or a `$$` (a dangling one closes inline or on its own line
// depending on where the FIRST `$$` in the string sits). Using remend as its
// own oracle keeps this honest across remend upgrades in a way that
// re-implementing its counters here would not.
const PROBES = [
    '\n\nz',
    '\n\n`z',
    '\n\n*z',
    '\n\n**z',
    '\n\n***z',
    '\n\n_z',
    '\n\n__z',
    '\n\n~~z',
    '\n\nz~z',
    '\n\n$$z',
    '\n\nz [z',
    '\n\nz ![z',
    '\n\nz <b z',
    '\n\n- >= 1',
    '\n\nz\n-',
    // The single `*` and `_` handlers pick the FIRST qualifying marker in the
    // whole string and then test what follows it, so a span that owns one
    // changes whether a marker the user has only just opened counts as
    // half-typed. These probes end on a bare marker to expose that.
    '\n\nz `',
    '\n\nz *',
    '\n\nz **',
    '\n\nz ***',
    '\n\nz _',
    '\n\nz __',
    '\n\nz ~~',
    '\n\nz $$'
]
const HEALED_PROBES = PROBES.map(healMarkdownSpan)

// How far behind the split point healing is re-proved each frame. Normally
// the span settled by the previous advance, capped so one huge block cannot
// put the answer back on an unbounded per-frame scan.
const LOOKBACK_LIMIT = 4096
// A candidate span is probed once whatever its size, so an ordinary long
// fenced code block still settles. This caps the RETRY budget only: after a
// span has failed it is re-probed as it grows — two `$` in different blocks
// read as an open math span on their own and as plain prose together — but
// not past here, or a span that will never settle would be re-probed for the
// rest of the turn.
const PROBE_RETRY_LIMIT = 4096
// One probe pass is a remend run over the span, so a single enormous
// top-level block would buy its split point with a visible hitch. Past this
// the turn hands itself back to the original pipeline, which is what it would
// have been paying for that answer anyway. Measured on darwin/node22
// [2026-08-09]: a 16 kB span costs ~30 ms of probing, once.
const PROBE_SPAN_LIMIT = 16384
// Settled blocks prepended to the tail so it parses in context rather than as
// a fresh document. One is almost always enough; the cap stops a pathological
// answer from walking the context back to the start.
const CONTEXT_BLOCKS_LIMIT = 4
const CONTEXT_CHARS_LIMIT = 8192

// A settled span is safe to freeze only if healing it in isolation leaves
// exactly the same trace as healing it in front of an arbitrary tail.
const selfContained = (span: string): boolean => {
    for (let i = 0; i < PROBES.length; i += 1) {
        if (healMarkdownSpan(span + PROBES[i]) !== span + HEALED_PROBES[i])
            return false
    }
    return true
}

// Incremental front end for heal + split. Both are whole-string functions
// whose cost grows with the answer, and the typewriter calls them once per
// animation frame, so a long turn pays O(answer) per frame — O(answer²) per
// turn.
//
// Measured on darwin/node22 [2026-08-09], one frame over a 200 kB answer:
// healStreamingMarkdown 560 ms (remend's link handler walks every `[` in the
// string and rescans from 0 at each one) and splitMarkdownBlocks 221 ms. Only
// the tail of an answer can still change, so this keeps the settled prefix as
// already-split block strings and re-runs both passes over the open tail.
//
// Four checks stand behind that, none of them assumed:
//
//  1. Splitting, node window. Appending text can only reshape the last two
//     top-level mdast nodes — see scanMarkdownBlocks for why two. Definitions
//     are the one exception, and they take the unsplit path below.
//  2. Splitting, parse context. A suffix does NOT parse like the same text
//     inside the document: block structure carries a container stack, and
//     `2) two` after an indented code block is a paragraph in context but an
//     ordered list at the top of a fresh document. So the tail is always
//     parsed with settled blocks in front of it, and those blocks have to
//     come back byte-identical or the context widens.
//  3. Healing, long range. A span joins the settled prefix only once the
//     probes above show it carries no remend state past its own end.
//  4. Healing, short range. Every frame re-heals a span of settled lookback
//     as well and requires the two runs to agree, and a split point is only
//     taken at a blank line so the line-sensitive handlers read the same
//     lines either way.
//
// When any of them fails the split point is dropped, and with barrier 0 the
// whole thing reduces to the original pipeline, so the frame renders exactly
// what it rendered before this change. Dropping it is deliberately not
// sticky, and neither is refusing to settle: an oversized or unsettleable
// span must never stop a later one from settling, or a single long fenced
// code block would put the rest of the answer back on the old cost.
export const createStreamingMarkdownBlocks = (): StreamingMarkdownBlocks => {
    let lastText = ''
    let lastBlocks: string[] = []
    // Block strings taken from text.slice(0, barrier), a span healing has
    // been shown to leave untouched.
    let settled: string[] = []
    // Raw start offset of each settled block, so a block can be re-fed to the
    // parser as leading context for the tail behind it.
    let settledStarts: number[] = []
    let barrier = 0
    let lookback = 0
    // Sticky across frames: once an answer has shown it needs more context,
    // it keeps it rather than rediscovering the shortfall every block.
    let contextBlocks = 1
    let probeFailedSpan = 0
    let probeBlocked = false
    // Start offsets of the last two `$$` inside text.slice(0, barrier).
    let settledMath: number[] = []
    let renderable = true
    // Blocks of the newest frame whose trailing math parsed. Mirrors the
    // `lastRenderable` hold the component used to keep: while a display
    // formula is mid-command KaTeX rejects it, so the last good frame holds.
    let renderableBlocks: string[] | null = null

    const dropSplitPoint = (): void => {
        settled = []
        settledStarts = []
        barrier = 0
        lookback = 0
        settledMath = []
        probeFailedSpan = 0
    }

    const collectMath = (text: string, from: number, to: number): void => {
        for (let i = Math.max(from - 1, 0); i < to - 1; i += 1) {
            if (text[i] !== '$' || text[i + 1] !== '$') continue
            settledMath.push(i)
            if (settledMath.length > 2) settledMath.shift()
        }
    }

    // The trailing-math probe over `text.slice(0, barrier) + tail`, without
    // building that string: settled `$$` offsets are collected as the barrier
    // moves, so only the tail is searched per frame. The search is the same
    // pair of lastIndexOf calls the original made, so with barrier 0 this is
    // that function exactly — a hand-rolled scan here would leave the
    // fallback path measurably slower than the code it replaces.
    const trailingRenderable = (text: string, tail: string): boolean => {
        const found = settledMath.slice()
        if (barrier > 0 && text[barrier - 1] === '$' && tail[0] === '$')
            found.push(barrier - 1)
        const last = tail.lastIndexOf('$$')
        if (last >= 0) {
            const prev = last > 0 ? tail.lastIndexOf('$$', last - 1) : -1
            if (prev >= 0) found.push(barrier + prev)
            found.push(barrier + last)
        }
        const close = found[found.length - 1]
        if (close === undefined || close <= 0) return true
        const open = found[found.length - 2]
        if (open === undefined) return true
        const head = Math.min(barrier, close)
        const formula =
            open + 2 >= barrier
                ? tail.slice(open + 2 - barrier, close - barrier)
                : text.slice(open + 2, head) + tail.slice(0, close - head)
        return mathSpanRenderable(formula.trim())
    }

    // The leading `count` blocks of a context re-parse have to come back as
    // exactly the settled blocks they were fed as, or the context was too
    // short and nothing the parse says about the tail can be trusted.
    const leadIntact = (blocks: string[], count: number): boolean => {
        if (blocks.length < count) return false
        const base = settled.length - count
        for (let i = 0; i < count; i += 1)
            if (blocks[i] !== settled[base + i]) return false
        return true
    }

    // Parse the tail behind however many settled blocks it takes for those
    // blocks to survive the round trip. null means no amount within budget
    // worked, so the caller falls back to the whole string.
    const parseInContext = (
        text: string,
        healed: string
    ): { scan: MarkdownBlockScan; lead: number; count: number } | null => {
        const most = Math.min(CONTEXT_BLOCKS_LIMIT, settled.length)
        for (let count = Math.min(contextBlocks, most); ; count += 1) {
            if (count === 0)
                return { scan: scanMarkdownBlocks(healed), lead: 0, count: 0 }
            const lead = barrier - settledStarts[settled.length - count]
            if (lead > CONTEXT_CHARS_LIMIT) return null
            const scan = scanMarkdownBlocks(
                text.slice(barrier - lead, barrier) + healed
            )
            if (scan.whole || leadIntact(scan.blocks, count)) {
                contextBlocks = count
                return { scan, lead, count }
            }
            if (count >= most) return null
        }
    }

    // With barrier 0 this is the original pipeline verbatim: heal the whole
    // text, split the whole healed text. Every fallback lands there, so the
    // two paths cannot disagree about what a frame renders.
    const frame = (text: string): string[] => {
        const tail = text.slice(barrier)
        const healed = healMarkdownSpan(tail)
        if (barrier > lookback) {
            const wide = healMarkdownSpan(text.slice(lookback))
            if (wide !== text.slice(lookback, barrier) + healed) {
                dropSplitPoint()
                return frame(text)
            }
        }
        renderable = trailingRenderable(text, healed)
        if (!renderable && renderableBlocks) return renderableBlocks
        const parsed = parseInContext(text, healed)
        if (!parsed) {
            dropSplitPoint()
            return frame(text)
        }
        const { scan, lead, count } = parsed
        if (scan.whole) {
            if (settled.length > 0) {
                dropSplitPoint()
                return frame(text)
            }
            return healed ? [healed] : []
        }
        let open = scan.blocks.slice(count)
        if (
            scan.settledCount > count &&
            !probeBlocked &&
            atBlankLine(text, barrier + scan.settledEnd - lead)
        ) {
            const settledEnd = barrier + scan.settledEnd - lead
            const span = text.slice(barrier, settledEnd)
            if (span.length > probeFailedSpan) {
                if (
                    span.length > PROBE_SPAN_LIMIT ||
                    (probeFailedSpan > 0 && span.length > PROBE_RETRY_LIMIT)
                ) {
                    // Either genuinely unsettleable or too big to be worth
                    // buying. Hand the whole string back to the original
                    // pipeline rather than pay the window's overhead on top
                    // of it — dropping the split point is what makes the
                    // fallback cost the same as before, not more.
                    probeBlocked = true
                    dropSplitPoint()
                    return frame(text)
                }
                if (healed.startsWith(span) && selfContained(span)) {
                    for (let i = count; i < scan.settledCount; i += 1) {
                        settled.push(scan.blocks[i])
                        settledStarts.push(barrier + scan.starts[i] - lead)
                    }
                    open = scan.blocks.slice(scan.settledCount)
                    const previous = barrier
                    collectMath(text, barrier, settledEnd)
                    barrier = settledEnd
                    lookback = Math.max(previous, barrier - LOOKBACK_LIMIT)
                } else {
                    probeFailedSpan = span.length
                }
            }
        }
        return settled.length > 0 ? settled.concat(open) : open
    }

    return {
        next: (text: string): string[] => {
            if (text === lastText) return lastBlocks
            // The typewriter only ever appends. A replace event, or React
            // handing this instance another message, invalidates the cache.
            if (!text.startsWith(lastText)) {
                dropSplitPoint()
                contextBlocks = 1
                probeBlocked = false
                renderableBlocks = null
            }
            lastText = text
            if (!text) {
                lastBlocks = []
                return lastBlocks
            }
            renderable = true
            lastBlocks = frame(text)
            if (renderable) renderableBlocks = lastBlocks
            return lastBlocks
        }
    }
}
