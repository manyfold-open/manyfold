import assert from 'node:assert/strict'
import test from 'node:test'
import { splitMarkdownBlocks } from '../src/components/chat/utils/markdownBlocks'
import {
    healMarkdownSpan,
    mathSpanRenderable
} from '../src/components/chat/utils/streamingMarkdown'
import { createStreamingMarkdownBlocks } from '../src/components/chat/utils/streamingMarkdownBlocks'

// The whole-string pipeline MarkdownText ran before the tail window existed,
// transcribed rather than imported: it is the golden output this whole file
// asserts against, so it must not drift when the production code does.
const trailingMathRenderable = (source: string): boolean => {
    const close = source.lastIndexOf('$$')
    if (close <= 0) return true
    const open = source.lastIndexOf('$$', close - 1)
    if (open < 0) return true
    return mathSpanRenderable(source.slice(open + 2, close).trim())
}

const createReference = (): ((text: string) => string[]) => {
    let lastRenderable = ''
    return (text: string): string[] => {
        let source = text
        if (text) {
            const healed = healMarkdownSpan(text)
            if (trailingMathRenderable(healed)) {
                lastRenderable = healed
                source = healed
            } else {
                source = lastRenderable || healed
            }
        }
        return splitMarkdownBlocks(source)
    }
}

// Half-typed formulas are the point of several fixtures and KaTeX warns on
// every one of them, which would bury the suite output. The probe's verdict
// is still asserted; only the chatter is dropped.
const quietly = (run: () => void): void => {
    const warn = console.warn
    console.warn = (): void => undefined
    try {
        run()
    } finally {
        console.warn = warn
    }
}

const assertEveryPrefix = (name: string, doc: string): void => {
    const reference = createReference()
    const stream = createStreamingMarkdownBlocks()
    quietly(() => {
        for (let i = 1; i <= doc.length; i += 1) {
            const prefix = doc.slice(0, i)
            assert.deepEqual(
                stream.next(prefix),
                reference(prefix),
                `${name}: blocks diverge after ${i} characters\n${JSON.stringify(prefix)}`
            )
        }
    })
}

// Ordinary answers. These must stay on the incremental path, which the
// per-frame budget test below is what actually holds us to.
const ANSWERS: Record<string, string> = {
    prose: 'First paragraph, plain prose with **bold** and _italic_ and `code`.\n\nSecond paragraph after a blank line.\n\nThird one closes it out.',
    headings:
        '# Title\n\nIntro text.\n\n## Sub heading\nNo blank line before this paragraph.\n\n### Deeper\n\nDone.',
    nestedLists:
        'Steps:\n\n1. First step\n   - nested a\n   - nested b\n2. Second step\n\n   Continued paragraph inside item two.\n\n3. Third step\n\nAfter the list.',
    looseOrdered: '1. one\n\n2. two\n\n3. three\n\ntrailing text',
    bulletThenPara: '- one\n\n- two\n\n- three\n\nafter the list',
    table: 'Results:\n\n| col | val |\n| --- | --- |\n| a   | 1   |\n| b   | 2   |\n\nAfter the table.',
    tableInterruptsParagraph:
        'lead line\n| a | b |\n| - | - |\n| 1 | 2 |\n\nnext paragraph here',
    fenced: 'Example:\n\n```ts\nconst a = 1\n\nconst b = 2\nconsole.log(a + b)\n```\n\nDone talking.',
    fenceNeverCloses:
        'Here we go:\n\n```python\ndef f(x):\n    return x * 2\n\nprint(f(3))\n\nmore lines that never close the fence',
    indentedCode:
        'Intro line.\n\n    indented code\n\n    still the same block\n\nnormal paragraph again.',
    blockquote:
        '> quoted line one\n> quoted line two\n\n> a second quote\n\nplain text after',
    htmlBlock:
        'Before.\n\n<div class="note">\n  <p>hello</p>\n</div>\n\nAfter the html block.',
    htmlPre: 'Intro.\n\n<pre>\nraw\n\nstill raw\n</pre>\n\nOutro paragraph.',
    htmlComment:
        'Before.\n\n<!-- a comment\n\nstill inside\n\n-->\n\nAfter the comment.',
    setextLate: 'Some paragraph text\n===\n\nfollow up paragraph',
    setextDash: 'Another heading\n---\n\nbody text after it',
    thematic: 'Above the rule.\n\n---\n\nBelow the rule.\n\nAnd more.',
    hardBreaks: 'line one  \nline two  \nline three\n\nnext para',
    crlf: 'first line\r\n\r\nsecond paragraph\r\n\r\nthird paragraph',
    emoji: 'Unicode 🎉 and 𝒜 math letters.\n\nSecond ✅ paragraph.\n\nThird.',
    linkHeavy:
        'See [one](https://a.example) and [two](https://b.example).\n\nThen [three](https://c.example) here.\n\nAnd [four](https://d.example) last.',
    mixed: '## Answer\n\nHere is what I found:\n\n- point one with `code`\n- point two with [a link](https://example.com)\n\n```bash\nnpm run build\n```\n\n| k | v |\n| - | - |\n| a | 1 |\n\n> note: this matters\n\nFinal paragraph.'
}

// Enough settled blocks to push the offending construct out of the per-frame
// lookback, so the fixtures below can only be caught by the per-block probes.
const FILLER =
    '\n\npara A here\n\npara B here\n\npara C here\n\npara D here\n\n'

// Constructs that reach backwards across a block boundary. The window cannot
// reproduce these, so the point of each one is that the fallback catches it
// and the frame still renders what the whole-string pipeline renders.
const REACH_BACK: Record<string, string> = {
    // A list swallows the paragraph after it the moment that paragraph
    // grows a marker of its own, so the last two nodes stay open.
    listAbsorbsNextParagraph: '1. one\n\n2. two\n\n3. three\n\nafter the list',
    // remend truncates from an unclosed `[` or `<tag` to the string's end.
    unclosedBracket:
        'First settled paragraph here.\n\nNow an open bracket [that never closes and keeps going',
    unclosedImage:
        'Settled paragraph.\n\nAn ![image that never closes\n\nAnother paragraph.\n\nLast.',
    unclosedTag:
        'First settled paragraph here.\n\nNow an <b tag that never closes for a while',
    // Every emphasis closer is picked off a whole-string parity count.
    strayBacktick:
        'Use the `foo function to do things.\n\nThen the next paragraph arrives.\n\nAnd one more.',
    strayAsterisk:
        'A line with one *asterisk here.\n\nA following paragraph with no markers.\n\nAnd a third.',
    strayUnderscore:
        'A line with one _underscore here.\n\nA following paragraph.\n\nAnd a third one.',
    strayTilde:
        'A ~~struck phrase never closes.\n\nA following paragraph.\n\nAnd a third one.',
    // A lone `$` puts remend into "inside math" for the whole remainder,
    // suppressing emphasis healing in every later block. The filler puts it
    // far enough back that only the per-block probes can see it.
    loneDollarThenItalic: `Ends with a dollar $${FILLER}Prose with _italic_ and a lone _`,
    // An italic in a settled block changes whether a marker the user has only
    // just opened reads as half-typed, because the single-marker handlers
    // pick the first one in the whole string.
    italicThenOpenMarker: `Prose with _italic_ inside.${FILLER}A trailing lone _`,
    emphasisThenOpenMarker: `Prose with *emph* inside.${FILLER}A trailing lone *`,
    farUnclosedBracket: `Open bracket [never closed here${FILLER}tail paragraph grows`,
    farUnclosedTag: `Open tag <b never closed${FILLER}tail paragraph grows`,
    farStrayBacktick: `A stray \` backtick here${FILLER}tail paragraph with \`code\` in it`,
    farFourBackticks: `Weird \`\`\`\` run${FILLER}tail with \`code`,
    // A dangling `$$` closes inline or on its own line depending on where the
    // FIRST `$$` in the string sits.
    mathThenMath: '$$a$$\n\ntext\n\n$$b$$\n\nmore text',
    farMathThenOpenMath: `$$a$$ inline math${FILLER}tail with $$open`,
    blockMath:
        'Consider:\n\n$$\n\\frac{1}{2} + \\frac{1}{3}\n$$\n\nand also $$e^{i\\pi}+1=0$$ inline.\n\nEnd.',
    // KaTeX rejects a mid-command formula, so the last good frame holds.
    brokenMathHolds:
        'Look:\n\n$$\\frac{1}{$$\n\nthen more prose arrives after the broken formula.\n\nAnd a final line.',
    // Definitions are referenced from other blocks, so the message renders as
    // one unit the moment one appears.
    definitionLate:
        'See [the docs][d] for details.\n\nMore prose in between.\n\n[d]: https://example.com',
    footnoteLate:
        'Claim with a note[^1].\n\nAnother paragraph.\n\n[^1]: The footnote body.',
    escapedMarkers:
        'Literal \\*stars\\* and \\`ticks\\` in prose.\n\nSecond paragraph with **real bold**.\n\nThird.',
    fourBackticks:
        'Weird ```` run in prose.\n\nThen a normal paragraph.\n\nAnd `code` here.\n\nEnd.',
    comparisonInList: '- 1 >= 2 is false\n- 3 > 1 is true\n\nAfter the list.',
    tildeInWord:
        'A ~~struck~~ phrase and a lone ~ tilde in word~thing.\n\nNext paragraph.\n\nThird.'
}

for (const [name, doc] of Object.entries(ANSWERS)) {
    test(`matches the whole-string pipeline at every prefix: ${name}`, () => {
        assertEveryPrefix(name, doc)
    })
}

// Shapes where the tail parses differently on its own than it does inside the
// document, so a splitter that re-parses a bare suffix reports the wrong
// blocks even though healing is identical. `2) two` is the canonical one: an
// ordered list that does not start at 1 cannot interrupt the indented code
// block still open above it, so in context it stays a paragraph and the line
// under it is its own code block — but at the top of a fresh document it is a
// list, and it swallows that line.
const PARSE_CONTEXT: Record<string, string> = {
    orderedAfterIndentedCode: 'a\n\n    code\n\n2) two\n\n    co',
    orderedDotAfterIndentedCode: 'a\n\n    code\n\n2. two\n\n    co',
    orderedAfterIndentedCodeLonger:
        'intro para\n\n    code line\n\n    more code\n\n7) seven\n\n    body',
    oneAfterIndentedCode: 'a\n\n    code\n\n1) one\n\n    co',
    indentedAfterIndented:
        'lead\n\n    first\n\nmid para\n\n    second\n\n    third',
    bulletAfterIndentedCode: 'a\n\n    code\n\n- item\n\n    nested body',
    quoteThenLazy: 'head para\n\n> quoted\n\nplain\n\n> second\nlazy line',
    tableAfterParagraph:
        'first para\n\nsecond para\n\nlead line\n| a | b |\n| - | - |\n| 1 | 2 |',
    listInterruptsParagraph:
        'first para\n\nsecond para\n\nlead line\n- bullet one\n- bullet two',
    setextAfterBlocks: 'first para\n\nsecond para\n\nthird para\n===\n\nafter',
    htmlThenOrdered: 'para\n\n<div>\nx\n</div>\n\n3) three\n\n    body',
    fenceThenOrdered: 'para\n\n```\ncode\n```\n\n4) four\n\n    body',
    tabIndentedCode: 'a\n\n\tcode\n\n2) two\n\n\tco'
}

for (const [name, doc] of Object.entries(PARSE_CONTEXT)) {
    test(`parses the tail in document context: ${name}`, () => {
        assertEveryPrefix(name, doc)
    })
}

for (const [name, doc] of Object.entries(REACH_BACK)) {
    test(`falls back rather than diverging: ${name}`, () => {
        assertEveryPrefix(name, doc)
    })
}

const FRAGMENTS = [
    'Plain prose sentence about the topic.',
    'Prose with **bold** and _italic_ and `code` inline.',
    'A [link](https://example.com) and an ![img](https://x.png).',
    'An unclosed [bracket that keeps going',
    'A stray * asterisk and a lone _ underscore.',
    'A stray ` backtick in prose.',
    'A ~~struck~~ phrase plus a lone ~ tilde.',
    'An <b unclosed tag start',
    'Closing > angle bracket here.',
    'Escaped \\* star and \\` tick and \\$ dollar.',
    '# ATX heading',
    'Setext heading\n===',
    'Setext dash heading\n---',
    '- bullet a\n- bullet b\n- bullet c',
    '* star bullet a\n* star bullet b',
    '1. one\n2. two\n3. three',
    '1. loose one\n\n2. loose two',
    '- outer\n  - inner\n    - deepest',
    '- item with para\n\n  continued inside item',
    '> quoted line\n> second quoted line',
    '```ts\nconst a = 1\n\nconst b = 2\n```',
    '```python\nnever closed fence',
    '    four space indented code\n\n    second chunk',
    '| a | b |\n| - | - |\n| 1 | 2 |',
    '$$\nx^2 + y^2\n$$',
    '$$\\frac{1}{',
    '<div class="x">\n  <p>y</p>\n</div>',
    '<!-- comment\nstill comment\n-->',
    '[d]: https://example.com',
    '[^1]: footnote body',
    'Text with 🎉 emoji and 𝒜 letters.',
    'Trailing spaces line   ',
    'text_with_underscores_inside and more',
    'Ends with a dollar $',
    'Ends with two dollars $$'
]

const mulberry = (seed: number): (() => number) => {
    let state = seed
    return (): number => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// A seeded sample. The full sweep this was cut down from — eight seeds of
// 300 documents each, ~390k prefix comparisons — is what actually vetted the
// probe list; this keeps a fixed slice of it as the standing regression net.
test('matches the whole-string pipeline on generated documents', () => {
    for (let doc = 0; doc < 40; doc += 1) {
        const random = mulberry(1_000_003 * (doc + 1))
        const parts: string[] = []
        const count = 2 + Math.floor(random() * 4)
        for (let i = 0; i < count; i += 1)
            parts.push(FRAGMENTS[Math.floor(random() * FRAGMENTS.length)])
        assertEveryPrefix(
            `generated#${doc}`,
            parts.join(random() < 0.85 ? '\n\n' : '\n')
        )
    }
})

test('a repeated text re-renders the same blocks without recomputing', () => {
    const stream = createStreamingMarkdownBlocks()
    const text = 'One paragraph.\n\nTwo paragraph.\n\nThree para'
    const first = stream.next(text)
    assert.equal(stream.next(text), first, 'same array instance is handed back')
})

test('a text that is not an append restarts from scratch', () => {
    const reference = createReference()
    const stream = createStreamingMarkdownBlocks()
    const streamed = 'Alpha block.\n\nBeta block.\n\nGamma block in progress'
    for (let i = 1; i <= streamed.length; i += 1) {
        const prefix = streamed.slice(0, i)
        stream.next(prefix)
        reference(prefix)
    }
    // What a moderation `replace` event does: the token blocks are dropped
    // and different text takes their place.
    const replaced = 'This answer was withheld.\n\nTry rephrasing the question.'
    assert.deepEqual(stream.next(replaced), createReference()(replaced))
    assert.deepEqual(
        stream.next(replaced + ' Or ask support.'),
        createReference()(replaced + ' Or ask support.')
    )
})

test('a settled block is never rewritten, so its memo never invalidates', () => {
    const doc =
        '## Heading\n\nFirst paragraph of the answer.\n\n- a\n- b\n\n```ts\nconst x = 1\n```\n\nClosing paragraph of the answer.'
    const stream = createStreamingMarkdownBlocks()
    const seen: string[] = []
    for (let i = 1; i <= doc.length; i += 1) {
        const blocks = stream.next(doc.slice(0, i))
        // Everything but the last two blocks is settled and must be byte for
        // byte what earlier frames already handed React.
        for (let b = 0; b < blocks.length - 2; b += 1) {
            if (seen[b] === undefined) seen[b] = blocks[b]
            assert.equal(blocks[b], seen[b], `block ${b} was rewritten`)
        }
    }
    assert.ok(seen.length >= 3, 'the document settled several blocks')
})

// Replay the same frames through both implementations, handing the clock
// back and forth frame by frame rather than timing one whole pass and then
// the other. Alternate which implementation goes first so shared-helper
// cache and JIT effects are not always charged to the reference side. Short
// or sustained contention is then sampled on both sides across the replay;
// one long suspension can still land within either individual interval.
//
// Measured on darwin/node22 [2026-08-10], six fresh processes per order: the
// long reference/stream ratio was 6.50-6.81 reference-first, 5.84-6.40
// stream-first and 6.55-7.04 alternating. The enormous stream/reference
// ratio stayed within 0.99-1.04 across all three orders.
const replay = (
    doc: string,
    step: number
): { reference: number; stream: number } => {
    const frames: string[] = []
    for (let i = step; i <= doc.length; i += step) frames.push(doc.slice(0, i))
    const reference = createReference()
    const stream = createStreamingMarkdownBlocks()
    let referenceMs = 0
    let streamMs = 0
    for (const [index, prefix] of frames.entries()) {
        const referenceFirst = index % 2 === 0
        const before = performance.now()
        if (referenceFirst) reference(prefix)
        else stream.next(prefix)
        const between = performance.now()
        if (referenceFirst) stream.next(prefix)
        else reference(prefix)
        const after = performance.now()
        referenceMs += referenceFirst ? between - before : after - between
        streamMs += referenceFirst ? after - between : between - before
    }
    return { reference: referenceMs, stream: streamMs }
}

const buildAnswer = (chars: number): string => {
    const section = (i: number): string =>
        `## Step ${i}\n\nProse for stage ${i} with **bold** and \`code\` and a ` +
        `[link](https://docs.example.com/${i}).\n\n- first bullet\n- second bullet\n\n` +
        '```ts\n' +
        `const stage${i} = ${i}\n` +
        '```\n\n'
    let doc = ''
    for (let i = 0; doc.length < chars; i += 1) doc += section(i)
    return doc.slice(0, chars)
}

const FRAME_STEP = 200
const TIMED_FRAMES = 100
const SHORT_ANSWER = 4_000
const LONG_ANSWER = 48_000
// Sections are all the same shape, so a window of frames taken anywhere in
// here does the same work as a window taken anywhere else and only the amount
// of answer already behind the window differs. Long enough that the last timed
// frame off LONG_ANSWER still lands inside it — run off the end and every
// frame would repeat the same text, which `next` answers from its memo.
const ANSWER = buildAnswer(LONG_ANSWER + TIMED_FRAMES * FRAME_STEP)

// What one frame costs once `settled` characters have already streamed
// through. The lead-in is deliberately outside the clock: this measures what a
// frame costs at a given answer length, not the cost of getting there.
const perFrameMs = (settled: number): number => {
    const stream = createStreamingMarkdownBlocks()
    for (let i = FRAME_STEP; i <= settled; i += FRAME_STEP)
        stream.next(ANSWER.slice(0, i))
    const start = performance.now()
    for (let i = 1; i <= TIMED_FRAMES; i += 1)
        stream.next(ANSWER.slice(0, settled + i * FRAME_STEP))
    return (performance.now() - start) / TIMED_FRAMES
}

// CI runs up to five test tasks at once on one shared runner, and losing the
// CPU only ever adds time, so the fastest of a few runs is the closest thing
// to the real cost. It absorbs JIT warmup too, which lands in the first run.
const fastest = (runs: number, measure: () => number): number => {
    let best = Infinity
    for (let i = 0; i < runs; i += 1) best = Math.min(best, measure())
    return best
}

// The point of the whole change: per-frame cost stops tracking the answer
// length. The same hundred frames of the same 200-character steps are timed
// twice, once with 4 kB of answer settled behind them and once with 48 kB.
// An incremental implementation does identical work in both windows, so
// machine speed and whatever else the runner is doing divide out; one that has
// gone back to a whole-string pass per frame cannot make them match.
//
// Holding the two windows against each other rather than against the old
// pipeline is what makes this stable. That shape timed ~50 ms of incremental
// work against ~400 ms of whole-string work, so a single descheduled slice in
// the short side moved the ratio further than the regression it was watching
// for. Measured on darwin/node22 [2026-08-10]: this ratio is 1.0-1.2x, and
// 7.4-11.4x for implementations put back on a whole-string pass per frame, so
// the bar sits at 3x between them.
test('per-frame cost does not grow with the answer', () => {
    const short = fastest(3, () => perFrameMs(SHORT_ANSWER))
    const long = fastest(3, () => perFrameMs(LONG_ANSWER))
    assert.ok(
        long < short * 3,
        `${LONG_ANSWER / SHORT_ANSWER}x the answer costs ${(long * 1000).toFixed(0)} us per frame vs ${(short * 1000).toFixed(0)} us`
    )
})

// A long fenced code block is one of the commonest shapes in an agent answer
// and it used to be the worst case here: an oversized settle candidate turned
// the window off for the rest of the turn, so the answer paid the old cost
// plus this module's overhead on top. It must now be a win, and above the
// size where buying a split point stops being worth the probe pass it must
// still be a wash rather than a loss.
test('a long single block is a win, and an enormous one is not a loss', () => {
    const body = (chars: number): string =>
        '```ts\n' + 'const x = 1\n'.repeat(Math.ceil(chars / 12)) + '```\n\n'
    const rest = (i: number): string =>
        `## Step ${i}\n\nProse for stage ${i} with **bold** and \`code\`.\n\n`
    const build = (first: number, total: number): string => {
        let doc = body(first)
        for (let i = 0; doc.length < total; i += 1) doc += rest(i)
        return doc.slice(0, total)
    }

    const long = replay(build(6000, 24_000), 200)
    assert.ok(
        long.stream * 3 < long.reference,
        `6 kB block: incremental ${long.stream.toFixed(1)} ms vs ${long.reference.toFixed(1)} ms`
    )

    const enormous = replay(build(40_000, 48_000), 400)
    assert.ok(
        enormous.stream < enormous.reference * 1.35,
        `40 kB block: incremental ${enormous.stream.toFixed(1)} ms vs ${enormous.reference.toFixed(1)} ms`
    )
})
