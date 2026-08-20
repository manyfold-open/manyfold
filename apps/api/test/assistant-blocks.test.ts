import type { ChatContentBlock } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Logger } from '@nestjs/common'
import { sanitizeForJsonb } from '../src/common/jsonb-sanitize'
import {
    ASSISTANT_BLOCKS_TRUNCATION_MARKER,
    createAssistantBlockBuffer,
    type DurableContentEvent
} from '../src/modules/chat/assistant-blocks'

// origin/develop's composition, copied verbatim at 052dacf9 so the buffer can
// be diffed against the behaviour it replaces rather than against a
// paraphrase of it. Everything below this block is the test.
const ASSISTANT_BLOCKS_BOUND_EVERY = 512
const ASSISTANT_BLOCKS_TEXT_CAP_CHARS = 32 * 1024 * 1024

const boundAssistantBlocks = (
    blocks: ChatContentBlock[],
    sinceBound: number,
    logger: Logger,
    messageId: string
): number => {
    if (sinceBound + 1 < ASSISTANT_BLOCKS_BOUND_EVERY) return sinceBound + 1
    blocks.splice(0, blocks.length, ...collapseTokens(blocks))
    let totalText = 0
    for (const block of blocks)
        if (block.type === 'text' || block.type === 'thinking')
            totalText += block.text.length
    if (totalText > ASSISTANT_BLOCKS_TEXT_CAP_CHARS) {
        let dropped = 0
        while (blocks.length && totalText > ASSISTANT_BLOCKS_TEXT_CAP_CHARS) {
            const block = blocks.shift()!
            if (block.type === 'text' || block.type === 'thinking')
                totalText -= block.text.length
            dropped += 1
        }
        blocks.unshift({
            type: 'text',
            text: ASSISTANT_BLOCKS_TRUNCATION_MARKER
        })
        logger.warn(
            `assistant blocks truncated for message=${messageId}: dropped ${dropped} blocks over the ${ASSISTANT_BLOCKS_TEXT_CAP_CHARS}-char cap`
        )
    }
    return 0
}

// Output moderation supersedes the whole answer mid-turn. Thinking and tool
// blocks record how the turn ran and are not what was moderated, so they stay.
const replaceAnswerBlocks = (
    blocks: ChatContentBlock[],
    text: string
): void => {
    const kept = blocks.filter((block) => block.type !== 'text')
    blocks.splice(0, blocks.length, ...kept)
    if (text) blocks.push({ type: 'text', text })
}

const collapseTokens = (blocks: ChatContentBlock[]): ChatContentBlock[] => {
    const out: ChatContentBlock[] = []
    let textBuffer = ''
    let thinkingBuffer = ''
    const flushText = (): void => {
        if (textBuffer) {
            out.push({ type: 'text', text: textBuffer })
            textBuffer = ''
        }
    }
    const flushThinking = (): void => {
        if (thinkingBuffer) {
            out.push({ type: 'thinking', text: thinkingBuffer })
            thinkingBuffer = ''
        }
    }
    for (const block of blocks) {
        if (block.type === 'text') {
            flushThinking()
            textBuffer += block.text
        } else if (block.type === 'thinking') {
            flushText()
            thinkingBuffer += block.text
        } else {
            flushText()
            flushThinking()
            out.push(block)
        }
    }
    flushText()
    flushThinking()
    return out
}

type Op =
    | { kind: 'token'; text: string }
    | { kind: 'thinking'; text: string }
    | { kind: 'tool'; block: ChatContentBlock }
    | { kind: 'replace'; text: string }

const silent = new Logger('assistant-blocks-diff')
silent.warn = (): void => undefined

// One op as the durable row sse-broadcaster wrote for it: payloads are
// sanitised on the way into jsonb, so a replayed row is already safe.
const rowsFor = (ops: Op[]): DurableContentEvent[] =>
    ops.map((op) =>
        op.kind === 'tool'
            ? {
                  eventType: op.block.type,
                  payloadJson: sanitizeForJsonb(op.block)
              }
            : {
                  eventType: op.kind === 'token' ? 'token' : op.kind,
                  payloadJson: sanitizeForJsonb({ text: op.text })
              }
    )

// What develop's blocksFromStreamEvents() handed runAdapterFromIterable for
// those same rows: one block per event, collapsed only at the write. It had NO
// replace case — that omission is #689 — so a seed containing one has no
// develop counterpart to be compared against, only a live buffer.
const developSeed = (ops: Op[]): ChatContentBlock[] =>
    sanitizeForJsonb(
        ops.map(
            (op): ChatContentBlock =>
                op.kind === 'tool'
                    ? op.block
                    : op.kind === 'replace'
                      ? assert.fail(
                            'develop could not replay a replace; use assertReplayMatchesLive'
                        )
                      : {
                            type: op.kind === 'token' ? 'text' : 'thinking',
                            text: op.text
                        }
        )
    )

// runAdapter's event loop as origin/develop ran it, through to the terminal
// persist: push a block per event, bound every 512 pushes, then collapse and
// sanitize once at the write.
const developTerminal = (ops: Op[], initial: Op[] = []): ChatContentBlock[] => {
    const blocks: ChatContentBlock[] = developSeed(initial)
    let sinceBound = 0
    for (const op of ops) {
        if (op.kind === 'token') blocks.push({ type: 'text', text: op.text })
        if (op.kind === 'thinking')
            blocks.push({ type: 'thinking', text: op.text })
        if (op.kind === 'tool') blocks.push(op.block)
        if (op.kind === 'replace') replaceAnswerBlocks(blocks, op.text)
        if (op.kind !== 'replace')
            sinceBound = boundAssistantBlocks(
                blocks,
                sinceBound,
                silent,
                'msg-1'
            )
    }
    return sanitizeForJsonb(collapseTokens(blocks))
}

const bufferTerminal = (ops: Op[], initial: Op[] = []): ChatContentBlock[] => {
    const buffer = createAssistantBlockBuffer(silent, 'msg-1', rowsFor(initial))
    for (const op of ops) {
        if (op.kind === 'token') buffer.appendText('text', op.text)
        if (op.kind === 'thinking') buffer.appendText('thinking', op.text)
        if (op.kind === 'tool') buffer.pushBlock(op.block)
        if (op.kind === 'replace') buffer.replaceAnswer(op.text)
    }
    buffer.endInput()
    return buffer.blocks
}

const assertSameAsDevelop = (
    ops: Op[],
    why: string,
    initial: Op[] = []
): void =>
    assert.deepEqual(
        bufferTerminal(ops, initial),
        developTerminal(ops, initial),
        why
    )

// #689's central equivalence, and the reason replay folds through this buffer
// instead of through a reducer beside it: a turn recovered from its log and the
// same turn streamed live must reach byte-identical terminal blocks.
const assertReplayMatchesLive = (ops: Op[], why: string): void =>
    assert.deepEqual(bufferTerminal([], ops), bufferTerminal(ops), why)

const HIGH = String.fromCharCode(0xd83d)
const LOW = String.fromCharCode(0xde00)
const NUL = String.fromCharCode(0)
const REPLACEMENT = String.fromCharCode(0xfffd)
const CAP = 32 * 1024 * 1024

const tool = (i: number): ChatContentBlock => ({
    type: 'tool_call',
    toolCallId: `call-${i}`,
    toolName: 'read',
    args: { path: `/tmp/f${i}` },
    elapsedMs: 1
})

const textChars = (blocks: ChatContentBlock[]): number =>
    blocks.reduce(
        (n, block) =>
            block.type === 'text' || block.type === 'thinking'
                ? n + block.text.length
                : n,
        0
    )

test('ordinary streaming shapes match develop exactly', () => {
    assertSameAsDevelop(
        [
            { kind: 'thinking', text: 'let me ' },
            { kind: 'thinking', text: 'think' },
            { kind: 'token', text: 'the ' },
            { kind: 'token', text: `ans${NUL}wer` },
            { kind: 'tool', block: tool(1) },
            { kind: 'token', text: 'more' },
            { kind: 'thinking', text: 'hm' },
            { kind: 'token', text: 'end' }
        ],
        'collapsing on push must produce the same blocks as collapsing at write'
    )
    assertSameAsDevelop(
        [
            { kind: 'token', text: `a${HIGH}` },
            { kind: 'token', text: `${LOW}b` },
            { kind: 'tool', block: tool(2) },
            { kind: 'token', text: `c${HIGH}` },
            { kind: 'token', text: LOW }
        ],
        'split surrogate pairs must survive the same way'
    )
    assertSameAsDevelop(
        [
            { kind: 'token', text: 'draft answer' },
            { kind: 'thinking', text: 'reasoning' },
            { kind: 'tool', block: tool(3) },
            { kind: 'replace', text: 'moderated' },
            { kind: 'token', text: ' tail' }
        ],
        'a replace mid-turn must keep the same non-text blocks'
    )
})

// A thinking run's held-back surrogate belongs to a block a replace KEEPS, so
// dropping it with the answer text loses the run's last character.
test('a thinking carry survives a replace, a text carry does not', () => {
    assertSameAsDevelop(
        [
            { kind: 'thinking', text: `plan${HIGH}` },
            { kind: 'replace', text: 'safe' }
        ],
        'the thinking run keeps its resolved character'
    )
    assert.deepEqual(
        bufferTerminal([
            { kind: 'thinking', text: `plan${HIGH}` },
            { kind: 'replace', text: 'safe' }
        ]),
        [
            { type: 'thinking', text: `plan${REPLACEMENT}` },
            { type: 'text', text: 'safe' }
        ]
    )
    assertSameAsDevelop(
        [
            { kind: 'token', text: `draft${HIGH}` },
            { kind: 'replace', text: 'safe' }
        ],
        'a carry belonging to superseded answer text goes with it'
    )
})

// Truncation drops from the FRONT; the carry belongs to the TRAILING run, so
// it outlives the drop and its low half is still to come.
test('a carry survives a truncation that spares its block', () => {
    const ops: Op[] = [
        { kind: 'thinking', text: 't'.repeat(CAP) },
        ...Array.from(
            { length: 510 },
            (_, i): Op => ({
                kind: 'tool',
                block: tool(i)
            })
        ),
        { kind: 'token', text: `a${HIGH}` },
        { kind: 'token', text: LOW }
    ]
    const blocks = bufferTerminal(ops)
    assertSameAsDevelop(ops, 'the emoji must not become a replacement char')
    const last = blocks.at(-1)
    const first = blocks[0]
    assert.ok(last?.type === 'text')
    assert.ok(first?.type === 'text')
    assert.equal(last.text, 'a😀')
    assert.equal(first.text, ASSISTANT_BLOCKS_TRUNCATION_MARKER)
})

// The one deliberate divergence. develop's replaceAnswerBlocks filtered every
// text block, and the marker lives in one — so a truncated turn that was then
// replaced lost it, and stream-log-compaction, which decides whether the log
// may be deleted by looking for the marker at blocks[0], would then delete
// the only remaining full copy of the dropped output.
test('a replace after a truncation keeps the durability marker', () => {
    const ops: Op[] = [
        { kind: 'token', text: 'x'.repeat(CAP) },
        { kind: 'thinking', text: 'y' },
        { kind: 'replace', text: 'safe' }
    ]
    const developed = developTerminal(ops)
    assert.equal(
        developed.some(
            (block) =>
                block.type === 'text' &&
                block.text.startsWith(ASSISTANT_BLOCKS_TRUNCATION_MARKER)
        ),
        false,
        'the behaviour being fixed: develop drops the marker on a replace'
    )

    const blocks = bufferTerminal(ops)
    assert.equal(blocks[0]?.type, 'text')
    assert.ok(
        (blocks[0] as { text: string }).text.startsWith(
            ASSISTANT_BLOCKS_TRUNCATION_MARKER
        ),
        'the compaction sweep reads blocks[0].text, so the marker must lead it'
    )
    assert.equal(
        blocks.filter(
            (block) =>
                block.type === 'text' &&
                block.text.includes(ASSISTANT_BLOCKS_TRUNCATION_MARKER)
        ).length,
        1,
        'exactly one marker, never two'
    )
})

// external-api.adapter converges a turn by delivering the whole answer as one
// replace, so the cap has to be enforced on that path too and not only on
// token appends.
test('a replace larger than the cap is truncated', () => {
    const blocks = bufferTerminal([
        { kind: 'thinking', text: 'reasoning' },
        { kind: 'replace', text: 'z'.repeat(CAP + 1024) }
    ])
    assert.ok(
        textChars(blocks) <= CAP,
        `cap must hold after a replace, saw ${textChars(blocks)}`
    )
    assert.equal(blocks[0]?.type, 'text')
    assert.ok(
        (blocks[0] as { text: string }).text.startsWith(
            ASSISTANT_BLOCKS_TRUNCATION_MARKER
        )
    )
})

// When truncation spares a leading TEXT block the marker has to join it, not
// sit in front of it: develop's collapseTokens merged the two at the write,
// and blocks[0].text is what the compaction sweep reads.
test('the marker joins a surviving leading text block', () => {
    const ops: Op[] = [
        ...Array.from(
            { length: 510 },
            (_, i): Op => ({ kind: 'tool', block: tool(i) })
        ),
        { kind: 'thinking', text: 't'.repeat(CAP) },
        { kind: 'token', text: 'abc' }
    ]
    assertSameAsDevelop(ops, 'the marker must not split the text run in two')
    assert.deepEqual(bufferTerminal(ops), [
        { type: 'text', text: `${ASSISTANT_BLOCKS_TRUNCATION_MARKER}abc` }
    ])
})

test('the cap holds after every mutation, and the array stays collapsed', () => {
    const buffer = createAssistantBlockBuffer(silent, 'msg-1')
    const chunk = 'q'.repeat(4 * 1024 * 1024)
    for (let i = 0; i < 10; i += 1) buffer.appendText('text', chunk)
    buffer.pushBlock(tool(1))
    for (let i = 0; i < 3; i += 1) buffer.appendText('thinking', chunk)
    buffer.endInput()

    assert.ok(
        textChars(buffer.blocks) <= CAP,
        `cap must hold, saw ${textChars(buffer.blocks)}`
    )
    const kinds = buffer.blocks.map((block) => block.type)
    assert.deepEqual(
        kinds.filter(
            (kind, i) => kind === kinds[i - 1] && kind !== 'tool_call'
        ),
        [],
        'no two adjacent blocks of the same text kind'
    )
    assert.ok(
        (buffer.blocks[0] as { text: string }).text.startsWith(
            ASSISTANT_BLOCKS_TRUNCATION_MARKER
        )
    )
})

// runAdapterFromIterable seeds the buffer with the durable log itself, folded
// through the same mutations the live stream drives (#689). The seam between
// seeded prefix and resumed tail is where a rebuilt turn could gain or lose a
// block boundary.
//
// The seed is what a REAL log can hold: sse-broadcaster sanitises every
// payload on the way in, so a persisted row already has its NULs stripped
// and its unpaired surrogates replaced. A pair the crash split is therefore
// already two U+FFFD in the log and no buffer can put it back together —
// that is a property of the log, not of this code.
test('a seeded recovery buffer matches develop across the resume seam', () => {
    const seeded: Op[] = [
        { kind: 'token', text: 'pre-' },
        { kind: 'token', text: 'crash ' },
        { kind: 'thinking', text: 'why' },
        {
            kind: 'tool',
            block: {
                type: 'tool_result',
                toolCallId: 'call-1',
                result: { output: 'ok' }
            }
        },
        { kind: 'token', text: `tail${REPLACEMENT}` }
    ]
    assertSameAsDevelop(
        [
            { kind: 'token', text: LOW },
            { kind: 'token', text: ' resumed' },
            { kind: 'tool', block: tool(9) },
            { kind: 'token', text: 'end' }
        ],
        'seeded blocks and the resumed tail must collapse as one run',
        seeded
    )
    assert.deepEqual(bufferTerminal([{ kind: 'token', text: 'ing' }], seeded), [
        { type: 'text', text: 'pre-crash ' },
        { type: 'thinking', text: 'why' },
        {
            type: 'tool_result',
            toolCallId: 'call-1',
            result: { output: 'ok' }
        },
        { type: 'text', text: `tail${REPLACEMENT}ing` }
    ])
})

// #689's acceptance sequence. develop's replay folded the log as an append-only
// block list, so a `replace` row contributed nothing and the answer it had
// superseded came back — this is the shape that must fold identically whether
// the buffer sees it live or rebuilds it from the log.
test('a replayed turn with replaces matches the live turn byte for byte', () => {
    const ops: Op[] = [
        { kind: 'thinking', text: 'planning' },
        { kind: 'tool', block: tool(1) },
        { kind: 'token', text: 'draft ' },
        { kind: 'token', text: 'answer' },
        { kind: 'replace', text: 'first replacement' },
        { kind: 'token', text: ' plus tail' },
        { kind: 'replace', text: 'final answer' }
    ]
    assertReplayMatchesLive(ops, 'replay and live must reach the same blocks')
    assert.deepEqual(bufferTerminal([], ops), [
        { type: 'thinking', text: 'planning' },
        tool(1),
        { type: 'text', text: 'final answer' }
    ])

    // And the same log resumed rather than replayed to a terminal: the seeded
    // prefix ends in a replace, so the tail appends onto the REPLACEMENT.
    assert.deepEqual(bufferTerminal([{ kind: 'token', text: ' more' }], ops), [
        { type: 'thinking', text: 'planning' },
        tool(1),
        { type: 'text', text: 'final answer more' }
    ])
})

test('a replay cursor names the complete durable content prefix or nothing', () => {
    const withStatusAfterContent: DurableContentEvent[] = [
        { id: 1n, eventType: 'token', payloadJson: { text: 'draft' } },
        { id: 2n, eventType: 'replace', payloadJson: { text: 'safe' } },
        {
            id: 3n,
            eventType: 'turn_status',
            payloadJson: { phase: 'recovering' }
        }
    ]
    assert.equal(
        createAssistantBlockBuffer(silent, 'msg-1', withStatusAfterContent)
            .replayedThrough,
        2n,
        'a content checkpoint cursor stops at the last row its blocks contain'
    )
    assert.equal(
        createAssistantBlockBuffer(silent, 'msg-1', [
            withStatusAfterContent[0]!,
            { eventType: 'replace', payloadJson: { text: 'safe' } }
        ]).replayedThrough,
        null,
        'one content row without an id makes the whole prefix unnameable'
    )
})

// The sanitisation contract is the buffer's, so replaying through the buffer
// inherits it rather than restating it — including the case a one-shot
// sanitiser gets wrong, where a replacement's trailing half-pair is completed
// by the token after it.
test('replayed replaces keep the sanitisation contract', () => {
    assertReplayMatchesLive(
        [
            { kind: 'token', text: 'draft' },
            { kind: 'replace', text: 'second' },
            { kind: 'replace', text: 'third' },
            { kind: 'replace', text: '' }
        ],
        'consecutive replaces and an empty one'
    )

    // Rows a real log cannot hold: sse-broadcaster sanitises payloads on the
    // way in, so these can only come from rows written before it existed. The
    // NULs must not reach jsonb through the replay, and the replacement's
    // trailing high surrogate must be CARRIED to the low half in the next row
    // rather than resolved on the spot — the one thing a one-shot sanitiser
    // gets wrong, and the reason the fold appends through appendText.
    const hostile: DurableContentEvent[] = [
        { eventType: 'token', payloadJson: { text: `draft${NUL}` } },
        { eventType: 'replace', payloadJson: { text: `safe${NUL} ${HIGH}` } },
        { eventType: 'token', payloadJson: { text: `${LOW} more` } }
    ]
    const replayed = createAssistantBlockBuffer(silent, 'msg-1', hostile)
    replayed.endInput()
    assert.deepEqual(replayed.blocks, [
        { type: 'text', text: 'safe \u{1F600} more' }
    ])

    // And across the seam, where the low half is the first thing the resumed
    // stream sends: the seeded carry is deliberately not flushed at the end of
    // the seed.
    const resumed = createAssistantBlockBuffer(
        silent,
        'msg-1',
        hostile.slice(0, 2)
    )
    resumed.appendText('text', `${LOW} more`)
    resumed.endInput()
    assert.deepEqual(resumed.blocks, replayed.blocks)
})

// The log stores each delta sanitised on its own, so a pair the upstream split
// across two deltas is already two U+FFFD in the log and no replay can rejoin
// it. Pinned deliberately: the fix for that is not to stop sanitising rows.
test('a pair the log already split stays split on replay', () => {
    const split: Op[] = [
        { kind: 'token', text: `a${HIGH}` },
        { kind: 'token', text: `${LOW}b` }
    ]
    assert.deepEqual(bufferTerminal([], split), [
        { type: 'text', text: `a${REPLACEMENT}${REPLACEMENT}b` }
    ])
    assert.deepEqual(
        bufferTerminal(split),
        [{ type: 'text', text: 'a\u{1F600}b' }],
        'the live stream carries the high half across deltas; the log cannot'
    )
})

// #672's guard is fail-closed and SQL-side: stream-log-compaction refuses a
// message whose content_blocks_json -> 0 ->> 'text' starts with the marker,
// because for a truncated turn the log holds the only full copy. A replayed
// replace must not be the thing that makes that copy deletable.
test('a replayed replace keeps the truncation marker at blocks[0]', () => {
    const ops: Op[] = [
        { kind: 'token', text: 'x'.repeat(CAP) },
        { kind: 'thinking', text: 'y' },
        { kind: 'replace', text: 'safe' }
    ]
    const replayed = bufferTerminal([], ops)
    assert.deepEqual(replayed, bufferTerminal(ops))
    assert.equal(replayed[0]?.type, 'text')
    assert.ok(
        (replayed[0] as { text: string }).text.startsWith(
            ASSISTANT_BLOCKS_TRUNCATION_MARKER
        ),
        'the compaction sweep reads blocks[0].text, so the marker must lead it'
    )
    assert.equal(
        replayed.filter(
            (block) =>
                block.type === 'text' &&
                block.text.includes(ASSISTANT_BLOCKS_TRUNCATION_MARKER)
        ).length,
        1,
        'exactly one marker, never two'
    )
})

// Dify's output moderation replaces mid-stream and tokens keep arriving
// afterwards, so replacement text is a stream chunk like any other: a
// trailing half-pair has to be held back for the next delta, not resolved on
// the spot.
test('replacement text goes through the streaming sanitiser', () => {
    assertSameAsDevelop(
        [
            { kind: 'token', text: 'draft' },
            { kind: 'replace', text: `safe ${HIGH}` },
            { kind: 'token', text: `${LOW} more` }
        ],
        'a pair split across the replace boundary must survive'
    )
    assert.deepEqual(
        bufferTerminal([
            { kind: 'replace', text: HIGH },
            { kind: 'token', text: LOW }
        ]),
        [{ type: 'text', text: '\u{1F600}' }]
    )
    assertSameAsDevelop(
        [{ kind: 'replace', text: `unpaired${HIGH}` }],
        'and an unpaired one still resolves at the end of input'
    )
    assertSameAsDevelop(
        [
            { kind: 'thinking', text: 'kept' },
            { kind: 'replace', text: NUL }
        ],
        'a replacement that sanitises away still leaves what develop left'
    )
})

// A replace deletes from the MIDDLE of the array, so two thinking runs that
// were only separated by answer text end up adjacent — the one way the
// COLLAPSED invariant can be broken without a push.
test('a replace re-collapses the blocks it separates', () => {
    const ops: Op[] = [
        { kind: 'thinking', text: 'a' },
        { kind: 'token', text: 'draft' },
        { kind: 'thinking', text: 'b' },
        { kind: 'replace', text: 'safe' }
    ]
    assertSameAsDevelop(ops, 'the two thinking runs must merge into one')
    assert.deepEqual(bufferTerminal(ops), [
        { type: 'thinking', text: 'ab' },
        { type: 'text', text: 'safe' }
    ])
    assertSameAsDevelop(
        [
            { kind: 'thinking', text: 'a' },
            { kind: 'token', text: 'x' },
            { kind: 'thinking', text: 'b' },
            { kind: 'tool', block: tool(4) },
            { kind: 'thinking', text: 'c' },
            { kind: 'token', text: 'y' },
            { kind: 'thinking', text: 'd' },
            { kind: 'replace', text: '' }
        ],
        'a tool block between two runs still keeps them apart'
    )
})

// #749. The checkpoint write no longer runs inside the adapter loop, so the
// array it carries has to stop being the live one: appendText grows the
// trailing block's string IN PLACE, so a write still serialising while the
// next token arrives would otherwise emit content the cursor beside it does
// not cover — the pairing invariant broken from the writing side.
test('a snapshot does not move when the buffer does', () => {
    const buffer = createAssistantBlockBuffer(silent, 'msg-1')
    buffer.appendText('thinking', 'planning')
    buffer.pushBlock(tool(1))
    buffer.appendText('text', 'the answ')

    const snapshot = buffer.snapshot()
    const atSample = JSON.parse(JSON.stringify(snapshot.blocks))

    buffer.appendText('text', 'er continues')
    buffer.pushBlock(tool(2))
    buffer.replaceAnswer('superseded')

    assert.deepEqual(
        snapshot.blocks,
        atSample,
        'appends, pushes and a whole replace all landed after the sample'
    )
    assert.equal(
        textChars(buffer.blocks),
        'planning'.length + 'superseded'.length
    )
})

// Only what a write CONTAINED is retired by it. The bytes that arrived while
// it was in flight were never in the row, so they stay owed and the next
// checkpoint carries them — the alternative is a turn that goes quiet for
// another max(8 KiB, 10%) of growth because a stale write zeroed the debt.
test('a landed checkpoint retires its own bytes and no others', () => {
    const buffer = createAssistantBlockBuffer(silent, 'msg-1')
    buffer.appendText('text', 'x'.repeat(1000))
    const snapshot = buffer.snapshot()
    assert.equal(snapshot.pendingChars, 1000)

    buffer.appendText('text', 'y'.repeat(300))
    buffer.markCheckpointed(snapshot)

    assert.equal(
        buffer.pendingChars,
        300,
        'the 300 chars that arrived mid-write are still owed'
    )
    buffer.markCheckpointed(buffer.snapshot())
    assert.equal(buffer.pendingChars, 0)
})

// A queued latest-wins snapshot overlaps the in-flight snapshot: its debt
// count still includes the prefix the first write will retire. When that
// queued write later lands, it must not retire bytes that arrived after ITS
// sample merely because the old prefix made its count larger than the live
// debt.
test('overlapping checkpoint snapshots retire debt only once', () => {
    const buffer = createAssistantBlockBuffer(silent, 'msg-1')
    buffer.appendText('text', 'x'.repeat(1000))
    const inflight = buffer.snapshot()
    buffer.appendText('text', 'y'.repeat(300))
    const queued = buffer.snapshot()

    buffer.markCheckpointed(inflight)
    assert.equal(buffer.pendingChars, 300)

    buffer.appendText('text', 'z'.repeat(100))
    buffer.markCheckpointed(queued)
    assert.equal(
        buffer.pendingChars,
        100,
        'the queued snapshot did not contain the last 100 chars'
    )
})

// The same rule for the forced flag, where getting it wrong is worse than a
// late checkpoint: a replace the write did not contain means the row still
// holds text the product has decided nobody should read, and clearing the
// flag is the buffer forgetting to remove it.
test('a checkpoint clears the forced flag only if it contained the replace', () => {
    const buffer = createAssistantBlockBuffer(silent, 'msg-1')
    buffer.appendText('text', 'here is how to do the bad thing')
    buffer.replaceAnswer('I cannot help with that.')
    assert.equal(buffer.checkpointForced, true)

    const snapshot = buffer.snapshot()
    buffer.replaceAnswer('I really cannot help with that.')
    buffer.markCheckpointed(snapshot)
    assert.equal(
        buffer.checkpointForced,
        true,
        'the second replace is not in the row yet, so a write is still owed'
    )

    buffer.markCheckpointed(buffer.snapshot())
    assert.equal(buffer.checkpointForced, false)
})
