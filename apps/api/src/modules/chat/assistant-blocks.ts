import type { ChatContentBlock } from '@manyfold/shared'
import type { Logger } from '@nestjs/common'
import {
    sanitizeForJsonb,
    sanitizePgText,
    sanitizeStreamDelta
} from '@/common/jsonb-sanitize'

// #672. This marker is a durability contract, not a display string. When the
// buffer drops the oldest blocks of a runaway turn it writes this prefix into
// content_blocks_json, and from that moment chat_stream_events holds the ONLY
// full copy of what the turn produced. The stream-log compaction sweep reads
// the same constant to refuse those messages, so the two must never drift
// apart — hence one exported constant rather than a literal in each place.
export const ASSISTANT_BLOCKS_TRUNCATION_MARKER =
    '[earlier output truncated: turn exceeded the in-memory content cap]\n'

// Every streamed block sits in the buffer until the terminal persist, so a
// long chatty turn would grow API-process memory without bound. Above this
// hard text cap the oldest blocks are dropped with the marker above (fail
// loud, keep the turn alive) — the full history still exists in
// chat_stream_events.
const ASSISTANT_BLOCKS_TEXT_CAP_CHARS = 32 * 1024 * 1024

type StreamTextKind = 'text' | 'thinking'

// A turn's content blocks, maintained under two invariants that make a
// content write O(1) in the turn's length instead of O(n):
//
//  1. COLLAPSED. A token delta is appended to the trailing block of the same
//     kind instead of becoming its own block (`s += delta` is amortised O(1)
//     in V8; the flatten happens once, at serialisation), so a write never
//     has to rebuild a collapsed copy first.
//  2. SANITISED. Every string that reaches `blocks` has already been through
//     the jsonb sanitiser, so a write hands the array straight to drizzle
//     instead of re-sanitising text that earlier writes already sanitised.
//
// Both invariants say the same thing: `blocks` is only ever written through
// this buffer. Anything that pushes into the array directly reintroduces the
// per-write O(n) passes, or writes a NUL into jsonb and fails the turn.

// A copy of the buffer's content at one instant, and the debt that copy would
// retire. #749: the checkpoint write no longer runs inside the adapter loop,
// so what it writes cannot be the live array — appendText grows the trailing
// block's string in place and replaceAnswer rewrites the array, so a detached
// write would serialise content that has moved on from the cursor sampled
// beside it. Everything the write needs is fixed here, at the instant both
// halves of the pairing are true together.
export interface AssistantContentSnapshot {
    readonly blocks: ChatContentBlock[]
    readonly truncated: boolean
    // What landing this copy is worth: its pending-byte count for telemetry,
    // a monotonic debt watermark for retirement, and the number of replaces
    // folded into it. Bytes that arrive while it is in flight are not in it
    // and stay owed — see markCheckpointed.
    readonly pendingChars: number
    readonly debtThrough: number
    readonly replaceSeq: number
}

export interface AssistantBlockBuffer {
    readonly blocks: ChatContentBlock[]
    // Approximate serialised size of `blocks`, and how much of it arrived
    // since the last markCheckpointed() — the inputs to the checkpoint rule.
    readonly contentChars: number
    readonly pendingChars: number
    // A `replace` supersedes answer text a checkpoint may already have
    // written, so the next checkpoint must not wait for the byte threshold.
    readonly checkpointForced: boolean
    // Whether the cap above has ever dropped blocks from the front. Once it
    // has, `blocks` is no longer the fold of any PREFIX of this turn's stream
    // events — it is a suffix with a marker — so a checkpoint of it can carry
    // no event cursor and a mid-turn subscriber must replay the whole turn.
    readonly truncated: boolean
    // Last durable content row folded into the recovery seed. Null when any
    // content row had no id, because then no cursor can name the whole seed.
    readonly replayedThrough: bigint | null
    appendText: (kind: StreamTextKind, delta: string) => void
    pushBlock: (block: ChatContentBlock) => void
    replaceAnswer: (text: string) => void
    // Resolve a surrogate pair the stream split and never completed. Call it
    // before the terminal write and never before a checkpoint: flushing early
    // turns a pair whose halves straddle the checkpoint into two U+FFFD.
    endInput: () => void
    // Freeze the current content, and with it the debt a write of that
    // content would retire.
    snapshot: () => AssistantContentSnapshot
    // Retire the debt of a write that actually landed. It takes the snapshot
    // that was written, never the buffer's current state: between the sample
    // and the write the buffer has usually moved on, and that difference is
    // exactly what is still owed.
    markCheckpointed: (snapshot: AssistantContentSnapshot) => void
}

const blockChars = (block: ChatContentBlock): number =>
    block.type === 'text' || block.type === 'thinking'
        ? block.text.length
        : JSON.stringify(block).length

// A persisted chat_stream_events row, narrowed to the two columns content
// replay reads. `eventType` is widened from the schema's union on purpose: this
// fold answers "what content does the log prove was delivered", and a row type
// it does not recognise is a row that contributes no content.
export interface DurableContentEvent {
    readonly id?: bigint
    readonly eventType: string
    readonly payloadJson: unknown
}

export const createAssistantBlockBuffer = (
    logger: Logger,
    messageId: string,
    // The durable stream-event log of what this turn has ALREADY delivered,
    // for a recovery that continues it. Folded here, through the same
    // mutations the live stream drives, rather than by a reducer beside the
    // buffer: `replace` is not a block, it is a state transition (#689), and a
    // second implementation of it is a second thing to keep in step.
    initial?: readonly DurableContentEvent[]
): AssistantBlockBuffer => {
    const blocks: ChatContentBlock[] = []
    let textChars = 0
    let contentChars = 0
    let debtThrough = 0
    let retiredThrough = 0
    let checkpointForced = false
    let replayedThrough: bigint | null = null
    let replayCursorValid = true
    // How many replaces this buffer has folded in. A checkpoint clears the
    // forced flag only if it contained every one of them — see snapshot().
    let replaceSeq = 0
    // Whether this turn has ever been truncated, i.e. whether the marker is
    // owed a place at the front of the array. Cheaper and more exact than
    // asking whether blocks[0] still starts with it: after a truncation the
    // next text delta is appended onto the marker's own block.
    let truncated = false
    // Trailing high surrogate held back from the last delta, waiting for the
    // low half that may open the next one. See sanitizeStreamDelta.
    let carry = ''
    let carryKind: StreamTextKind | null = null

    const add = (chars: number): void => {
        contentChars += chars
        debtThrough += chars
    }

    // Not via appendChars: the marker is the thing truncation adds, so it
    // must not itself be able to trigger another truncation pass. It goes
    // INTO a leading text block rather than in front of one — the array is
    // kept collapsed, and the marker has to be the prefix of blocks[0].text
    // for the compaction sweep to see it.
    const prependMarker = (): void => {
        const head = blocks[0]
        if (head && head.type === 'text')
            head.text = ASSISTANT_BLOCKS_TRUNCATION_MARKER + head.text
        else
            blocks.unshift({
                type: 'text',
                text: ASSISTANT_BLOCKS_TRUNCATION_MARKER
            })
        textChars += ASSISTANT_BLOCKS_TRUNCATION_MARKER.length
        add(ASSISTANT_BLOCKS_TRUNCATION_MARKER.length)
        truncated = true
    }

    // Room kept for the marker, so `textChars <= cap` still holds once it has
    // been added back. Dropping to the bare cap instead leaves the array a
    // few dozen chars over it, and the next delta immediately truncates a
    // second time — dropping everything that just survived.
    const TRUNCATE_TARGET_CHARS =
        ASSISTANT_BLOCKS_TEXT_CAP_CHARS -
        ASSISTANT_BLOCKS_TRUNCATION_MARKER.length

    const truncateOverCap = (): void => {
        if (textChars <= ASSISTANT_BLOCKS_TEXT_CAP_CHARS) return
        let dropped = 0
        // Drops from the FRONT, and an over-cap array always loses block 0
        // first — which is why a marker already sitting there goes with it
        // and the marker re-added below can never stack into a second one.
        while (blocks.length && textChars > TRUNCATE_TARGET_CHARS) {
            const block = blocks.shift()!
            const chars = blockChars(block)
            if (block.type === 'text' || block.type === 'thinking')
                textChars -= chars
            contentChars -= chars
            dropped += 1
        }
        // The carry belongs to the TRAILING run, and truncation eats the
        // leading ones, so it normally outlives the drop and its low half is
        // still to come. It only dies when the drop took everything — which
        // it does whenever one collapsed run is itself over the cap.
        if (blocks.length === 0) {
            carry = ''
            carryKind = null
        }
        prependMarker()
        logger.warn(
            `assistant blocks truncated for message=${messageId}: dropped ${dropped} blocks over the ${ASSISTANT_BLOCKS_TEXT_CAP_CHARS}-char cap`
        )
    }

    // Every path that can grow text funnels through here, so the cap check
    // lives here too rather than at one call site: a replace can install a
    // whole over-cap answer in one event (external-api.adapter converges a
    // turn that way), and a carry flush can be the character that crosses it.
    const appendChars = (kind: StreamTextKind, text: string): void => {
        const tail = blocks.at(-1)
        if (tail && tail.type === kind) tail.text += text
        else blocks.push({ type: kind, text })
        textChars += text.length
        add(text.length)
        truncateOverCap()
    }

    const flushCarry = (): void => {
        if (!carry) return
        const kind = carryKind ?? 'text'
        const flushed = sanitizePgText(carry)
        carry = ''
        carryKind = null
        if (flushed) appendChars(kind, flushed)
    }

    const appendText = (kind: StreamTextKind, delta: string): void => {
        if (carryKind !== null && carryKind !== kind) flushCarry()
        const out = sanitizeStreamDelta(carry, delta)
        carry = out.carry
        carryKind = out.carry ? kind : null
        if (out.text) appendChars(kind, out.text)
    }

    const pushBlock = (block: ChatContentBlock): void => {
        if (block.type === 'text' || block.type === 'thinking') {
            appendText(block.type, block.text)
            return
        }
        flushCarry()
        const safe = sanitizeForJsonb(block)
        blocks.push(safe)
        add(blockChars(safe))
    }

    // Output moderation supersedes the whole answer mid-turn. Thinking and
    // tool blocks record how the turn ran and are not what was moderated, so
    // they stay.
    const replaceAnswer = (text: string): void => {
        // A text carry is the tail of answer text that is about to be
        // deleted, so it goes with it. A thinking carry belongs to a block
        // that SURVIVES the replace, so it has to be resolved into that block
        // first or the run silently loses its last character.
        if (carryKind === 'thinking') flushCarry()
        carry = ''
        carryKind = null
        // Deleting the text blocks can leave two thinking runs that were only
        // separated by one of them, so the filter has to re-collapse as it
        // goes: this is the one mutation that removes from the MIDDLE of the
        // array, and the COLLAPSED invariant the write path depends on has no
        // other way to be restored.
        const kept: ChatContentBlock[] = []
        for (const block of blocks) {
            if (block.type === 'text') {
                textChars -= block.text.length
                contentChars -= block.text.length
                continue
            }
            const tail = kept.at(-1)
            if (block.type === 'thinking' && tail?.type === 'thinking')
                tail.text += block.text
            else kept.push(block)
        }
        blocks.splice(0, blocks.length, ...kept)
        // Deliberate divergence from the pre-buffer behaviour, which filtered
        // the marker out with every other text block. A message that has been
        // truncated has its ONLY full copy in chat_stream_events, and the
        // compaction sweep decides whether to delete that copy by looking for
        // this marker at blocks[0] — so a replace dropping it hands the sweep
        // permission to destroy the output. A replace supersedes ANSWER text;
        // the marker is not answer text, it is what says the answer is
        // incomplete.
        if (truncated) prependMarker()
        if (text) {
            // Through the streaming path, not a one-shot sanitise: Dify's
            // output moderation replaces mid-stream and tokens keep arriving
            // afterwards, so a replacement ending in half a surrogate pair
            // has to hold that half back for the next delta exactly as a
            // token would.
            const before = textChars
            appendText('text', text)
            // A replacement that sanitises away to nothing still left an
            // (empty) text block behind before the buffer existed, since the
            // raw block was pushed and only emptied at the write.
            if (textChars === before && !carry) appendChars('text', '')
        }
        // appendChars covers the growth case; this covers a replace whose
        // text is empty and whose marker was the last straw.
        truncateOverCap()
        checkpointForced = true
        replaceSeq += 1
    }

    // The durable log folded through the mutations above. Payload guards are
    // per type because a row is only as good as the column it was written
    // from, and a row that fails its guard contributes nothing — except for
    // `replace`, where the row's mere existence is the proof that the answer
    // was superseded, so an unreadable replacement supersedes it with nothing
    // rather than being skipped. Skipping it is #689.
    const applyDurableEvent = (event: DurableContentEvent): void => {
        const p = (event.payloadJson ?? {}) as Record<string, unknown>
        const contentEvent =
            event.eventType === 'token' ||
            event.eventType === 'thinking' ||
            event.eventType === 'tool_call' ||
            event.eventType === 'tool_result' ||
            event.eventType === 'replace'
        if (contentEvent) {
            if (replayCursorValid && typeof event.id === 'bigint')
                replayedThrough = event.id
            else {
                replayedThrough = null
                replayCursorValid = false
            }
        }
        if (event.eventType === 'token') {
            if (typeof p.text === 'string') appendText('text', p.text)
        } else if (event.eventType === 'thinking') {
            if (typeof p.text === 'string') appendText('thinking', p.text)
        } else if (event.eventType === 'tool_call') {
            if (typeof p.toolCallId === 'string')
                pushBlock({
                    type: 'tool_call',
                    toolCallId: p.toolCallId,
                    toolName: typeof p.toolName === 'string' ? p.toolName : '',
                    args: p.args ?? null,
                    ...(typeof p.elapsedMs === 'number'
                        ? { elapsedMs: p.elapsedMs }
                        : {})
                })
        } else if (event.eventType === 'tool_result') {
            if (typeof p.toolCallId === 'string')
                pushBlock({
                    type: 'tool_result',
                    toolCallId: p.toolCallId,
                    result: p.result ?? null,
                    ...(typeof p.elapsedMs === 'number'
                        ? { elapsedMs: p.elapsedMs }
                        : {})
                })
        } else if (event.eventType === 'replace') {
            replaceAnswer(typeof p.text === 'string' ? p.text : '')
        }
    }

    // A seeded prefix is the same logical run the resumed stream continues,
    // so a carry left at the end of it is NOT flushed here: the low half may
    // be the first thing the resumed stream sends, and a pair the crash split
    // has to rejoin exactly as the pre-buffer collapse-at-write did.
    for (const event of initial ?? []) applyDurableEvent(event)
    retiredThrough = debtThrough

    return {
        blocks,
        get contentChars() {
            return contentChars
        },
        get pendingChars() {
            return debtThrough - retiredThrough
        },
        get checkpointForced() {
            return checkpointForced
        },
        get truncated() {
            return truncated
        },
        get replayedThrough() {
            return replayedThrough
        },
        appendText,
        pushBlock,
        replaceAnswer,
        endInput: flushCarry,
        snapshot: (): AssistantContentSnapshot => ({
            // Copied per block, and only for the kinds this buffer mutates in
            // place: text and thinking runs grow with `tail.text += delta`,
            // and truncation prepends its marker into blocks[0]. A tool block
            // is frozen the moment it is pushed, so copying its payload would
            // be pure cost on the largest objects in the array. Strings are
            // immutable, so a copied text block cannot be changed under a
            // write that is already carrying it.
            blocks: blocks.map((block) =>
                block.type === 'text' || block.type === 'thinking'
                    ? { ...block }
                    : block
            ),
            truncated,
            pendingChars: debtThrough - retiredThrough,
            debtThrough,
            replaceSeq
        }),
        markCheckpointed: (snapshot: AssistantContentSnapshot): void => {
            // Retire through a monotonic watermark rather than subtracting
            // snapshot.pendingChars. Two snapshots sampled around one slow
            // writer overlap: the newer one's pending count still includes
            // bytes the older writer will retire first, so subtracting it in
            // full would also erase debt that arrived after the newer sample.
            retiredThrough = Math.max(retiredThrough, snapshot.debtThrough)
            // Same rule for the forced flag: a replace that landed in the
            // buffer after this snapshot was taken is not in the row yet, so
            // the flag survives the write that did not contain it.
            if (snapshot.replaceSeq === replaceSeq) checkpointForced = false
        }
    }
}
