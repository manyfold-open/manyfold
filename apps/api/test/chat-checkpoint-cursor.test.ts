import type { ChatContentBlock } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'
import { ChatService } from '../src/modules/chat/chat.service'

// The server half of the checkpoint-attach contract.
//
// A cold subscriber no longer replays a running turn from its first event: it
// renders chat_messages.content_blocks_json and subscribes from
// content_checkpoint_event_id. That is only sound under one invariant, and it
// is an equality, not a bound:
//
//   content_blocks_json === fold(content-bearing rows with id <= cursor)
//
// Under-cover and the tail replays events the content already holds — for a
// `replace`, that means deleting the answer a second time. Over-cover and the
// events between the two are never delivered to anyone.
//
// The invariant is hard because the in-memory blocks are structurally AHEAD
// of the table: token text sits in the broadcaster's 120ms merge window, and
// tool rows are handed to the write chain without being awaited. So these
// tests drive the REAL ChatSseBroadcaster over the REAL runAdapter and check
// the equality against the rows that actually landed, per checkpoint, over a
// corpus of turn shapes.
//
// This file owns the producer. That the CLIENT then reconstructs the same
// transcript from a correct pairing is proved separately, over every possible
// attach point, in apps/web/test/chatStreamStore.test.ts — the two compose:
// correct pairing here, correct application there.

interface StreamRow {
    id: bigint
    sessionId: string
    messageId: string
    seq: number
    eventType: string
    payloadJson: Record<string, unknown>
    sourceEventKey: string | null
    sourceEventOrdinal: number | null
    createdAt: Date
}

interface Checkpoint {
    blocks: ChatContentBlock[]
    cursor: bigint | null
}

// The fold every reader of the log performs, written out here rather than
// imported so this test states its own expectation. Mirrors the web store's
// reducer: text and thinking runs collapse, tool events are pushed as they
// come, and a `replace` supersedes the answer text while keeping the record
// of how the turn ran.
const foldRows = (rows: StreamRow[]): ChatContentBlock[] => {
    let blocks: ChatContentBlock[] = []
    const appendText = (kind: 'text' | 'thinking', text: string): void => {
        const tail = blocks.at(-1)
        if (tail && tail.type === kind) tail.text += text
        else blocks.push({ type: kind, text })
    }
    for (const row of rows) {
        const p = row.payloadJson
        if (row.eventType === 'token') appendText('text', String(p.text))
        else if (row.eventType === 'thinking')
            appendText('thinking', String(p.text))
        else if (row.eventType === 'tool_call')
            blocks.push({
                type: 'tool_call',
                toolCallId: String(p.toolCallId),
                toolName: String(p.toolName),
                args: p.args ?? null,
                ...(typeof p.elapsedMs === 'number'
                    ? { elapsedMs: p.elapsedMs }
                    : {})
            })
        else if (row.eventType === 'tool_result')
            blocks.push({
                type: 'tool_result',
                toolCallId: String(p.toolCallId),
                result: p.result ?? null,
                ...(typeof p.elapsedMs === 'number'
                    ? { elapsedMs: p.elapsedMs }
                    : {})
            })
        else if (row.eventType === 'replace') {
            const kept: ChatContentBlock[] = []
            for (const block of blocks) {
                if (block.type === 'text') continue
                const tail = kept.at(-1)
                if (block.type === 'thinking' && tail?.type === 'thinking')
                    tail.text += block.text
                else kept.push(block)
            }
            blocks = kept
            if (String(p.text)) appendText('text', String(p.text))
        }
    }
    return blocks
}

// Blocks come off the live buffer, which keeps mutating; the fold builds
// fresh objects. Compare them as the client would see them on the wire.
const wire = (blocks: ChatContentBlock[]): string =>
    JSON.stringify(blocks.filter((b) => !isEmptyText(b)))

const isEmptyText = (block: ChatContentBlock): boolean =>
    (block.type === 'text' || block.type === 'thinking') && block.text === ''

const textChars = (blocks: ChatContentBlock[]): number =>
    blocks.reduce(
        (n, block) =>
            block.type === 'text' || block.type === 'thinking'
                ? n + block.text.length
                : n,
        0
    )

const assertPairingHolds = (harness: Harness, shape: string): void => {
    const cursored = harness.checkpoints.filter((c) => c.cursor !== null)
    for (const [i, checkpoint] of cursored.entries()) {
        const cursor = checkpoint.cursor as bigint
        const covered = harness.rows.filter((row) => row.id <= cursor)
        assert.equal(
            wire(checkpoint.blocks),
            wire(foldRows(covered)),
            `${shape}: checkpoint ${i} at cursor ${cursor} does not equal the fold of the rows it claims`
        )
        // The other direction. A cursor that covered a terminal would hide it
        // from every attaching subscriber, and the turn would never end for
        // them.
        for (const row of covered)
            assert.ok(
                !['done', 'error', 'suspended'].includes(row.eventType),
                `${shape}: cursor ${cursor} covers a ${row.eventType} row`
            )
    }
}

test('a token-only turn pairs every checkpoint with the rows it covers', async () => {
    const chunk = 'x'.repeat(6 * 1024)
    const harness = makeHarness(
        Array.from({ length: 24 }, () => ({
            type: 'token' as const,
            text: chunk
        }))
    )
    await harness.run()

    assert.ok(
        harness.checkpoints.filter((c) => c.cursor !== null).length >= 5,
        `expected several cursored checkpoints, saw ${harness.checkpoints.filter((c) => c.cursor !== null).length}`
    )
    assertPairingHolds(harness, 'tokens only')
})

test('a tool-heavy turn pairs every checkpoint with the rows it covers', async () => {
    const events: EmittedChatEvent[] = []
    for (let i = 0; i < 120; i += 1) {
        events.push({ type: 'token', text: 'thinking about it '.repeat(40) })
        events.push({
            type: 'tool_call',
            toolCallId: `call-${i}`,
            toolName: 'read',
            args: { path: `/tmp/f${i}` },
            elapsedMs: 3
        })
        events.push({
            type: 'tool_result',
            toolCallId: `call-${i}`,
            result: { ok: true, bytes: i },
            elapsedMs: 4
        })
    }
    const harness = makeHarness(events)
    await harness.run()

    assert.ok(harness.checkpoints.some((c) => c.cursor !== null))
    assertPairingHolds(harness, 'tool heavy')
})

test('a turn with interleaved thinking pairs every checkpoint', async () => {
    const events: EmittedChatEvent[] = []
    for (let i = 0; i < 40; i += 1) {
        events.push({ type: 'thinking', text: 'reasoning '.repeat(120) })
        events.push({ type: 'token', text: 'answer '.repeat(120) })
    }
    const harness = makeHarness(events)
    await harness.run()

    assert.ok(harness.checkpoints.some((c) => c.cursor !== null))
    assertPairingHolds(harness, 'thinking interleaved')
})

// The hazard in its sharpest form. `replace` deletes every answer token so
// far, so a checkpoint whose cursor stops SHORT of the replace row leaves
// that row in the tail, and the attaching client applies it a second time —
// over content that has already absorbed it, deleting the answer the user is
// looking at. It is also the one event whose checkpoint bypasses the byte
// rule, so it is guaranteed to be sampled at exactly the awkward moment.
test('a replace is inside its own checkpoint cursor, never left in the tail', async () => {
    const harness = makeHarness([
        { type: 'token', text: 'here is how to do the bad thing' },
        { type: 'thinking', text: 'weighing it up' },
        {
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: 'search',
            args: {},
            elapsedMs: 1
        },
        { type: 'replace', text: 'I cannot help with that.', reason: 'mod' },
        { type: 'token', text: ' Anything else?' }
    ])
    await harness.run()

    const afterReplace = harness.checkpoints.filter(
        (c) =>
            c.cursor !== null &&
            c.blocks.some(
                (b) => b.type === 'text' && b.text.startsWith('I cannot help')
            )
    )
    assert.ok(
        afterReplace.length > 0,
        'the replace must produce a cursored checkpoint'
    )
    for (const checkpoint of afterReplace) {
        const replaceRow = harness.rows.find((r) => r.eventType === 'replace')
        assert.ok(replaceRow, 'the replace row must have been written')
        assert.ok(
            (checkpoint.cursor as bigint) >= replaceRow.id,
            `cursor ${checkpoint.cursor} must cover the replace row ${replaceRow.id}`
        )
    }
    assertPairingHolds(harness, 'with replace')
})

// A suspend ends the local stream without a terminal, so the last checkpoint
// is the row's state until somebody resumes it. It must still be a legal
// pairing: a subscriber attaching to a suspended turn has to receive the
// `suspended` row itself, or the UI has no idea why the turn went quiet.
test('a suspended turn leaves a pairing that still delivers the suspend', async () => {
    const harness = makeHarness([
        { type: 'token', text: 'y'.repeat(12 * 1024) },
        { type: 'token', text: 'y'.repeat(12 * 1024) },
        {
            type: 'suspended',
            daemonId: 'dh-1',
            daemonExecRef: 'ref-1',
            reason: 'sprite_suspended'
        } as EmittedChatEvent
    ])
    await harness.run()

    assertPairingHolds(harness, 'suspend')
    const suspendRow = harness.rows.find((r) => r.eventType === 'suspended')
    assert.ok(suspendRow, 'the suspend row must have been written')
    for (const checkpoint of harness.checkpoints)
        if (checkpoint.cursor !== null)
            assert.ok(checkpoint.cursor < suspendRow.id)
})

// The one shape where the content is provably NOT a prefix fold: over the
// in-memory cap the buffer drops its oldest blocks and prepends a marker, so
// it becomes a SUFFIX. There is no id that describes it, and the checkpoint
// must give up its cursor rather than name one that is wrong.
test('a truncated turn checkpoints without a cursor', async () => {
    const oneMib = 'z'.repeat(1024 * 1024)
    const harness = makeHarness(
        Array.from({ length: 34 }, () => ({
            type: 'token' as const,
            text: oneMib
        }))
    )
    await harness.run()

    const truncatedWrites = harness.checkpoints.filter((c) =>
        c.blocks.some(
            (b) => b.type === 'text' && b.text.startsWith('[earlier output')
        )
    )
    assert.ok(
        truncatedWrites.length > 0,
        'the corpus must actually cross the cap'
    )
    for (const checkpoint of truncatedWrites)
        assert.equal(
            checkpoint.cursor,
            null,
            'a truncated buffer must not claim a cursor'
        )
})

// A surrogate pair the transport split across two ROWS is the one case where
// the content and the log disagree permanently rather than momentarily: each
// row is sanitised alone, so the halves land as two U+FFFD, while the block
// buffer holds the first half back and rejoins the character. Neither is
// wrong, but they are not equal — so the turn gives up its cursor from that
// row onward instead of pairing content with rows that say something else.
test('a turn that splits a surrogate pair across rows gives up its cursor', async () => {
    // Over STREAM_FLUSH_MAX_CHARS, so each delta is its own row and the pair
    // really does straddle a row boundary rather than merging inside one.
    const filler = 'q'.repeat(9 * 1024)
    const harness = makeHarness([
        { type: 'token', text: filler },
        { type: 'token', text: filler + String.fromCharCode(0xd83d) },
        { type: 'token', text: String.fromCharCode(0xde00) + filler },
        { type: 'token', text: filler },
        { type: 'token', text: filler }
    ])
    await harness.run()

    assert.ok(
        harness.checkpoints.length >= 3,
        `expected several checkpoints, saw ${harness.checkpoints.length}`
    )
    const splitRow = harness.rows.findIndex((row) => {
        const text = String(row.payloadJson.text ?? '')
        return text.includes('�')
    })
    assert.ok(splitRow >= 0, 'the corpus must actually split a pair')
    // Everything after the split is cursor-less; the pairing that DID go out
    // before it still has to hold.
    const cursored = harness.checkpoints.filter((c) => c.cursor !== null)
    for (const checkpoint of cursored)
        assert.ok(
            (checkpoint.cursor as bigint) < harness.rows[splitRow]!.id,
            `cursor ${checkpoint.cursor} must predate the split row ${harness.rows[splitRow]!.id}`
        )
    assertPairingHolds(harness, 'split surrogate')
})

// The terminal is the end of the tail, not part of the checkpoint. It also
// flushes a held carry into the content, which no single row contains — so it
// clears the cursor rather than leaving the last mid-turn one in place beside
// content that has moved past it.
test('the terminal write clears the cursor', async () => {
    const harness = makeHarness([
        { type: 'token', text: 'x'.repeat(20 * 1024) },
        { type: 'token', text: 'x'.repeat(20 * 1024) }
    ])
    await harness.run()

    const last = harness.checkpoints.at(-1)
    assert.ok(last)
    assert.equal(last.cursor, null, 'the terminal write must clear the cursor')
    assert.ok(
        harness.checkpoints.slice(0, -1).some((c) => c.cursor !== null),
        'mid-turn checkpoints still carry cursors'
    )
})

// A raw line the transport delivers twice. The block buffer folds every event
// it consumes, so the content gains the tokens a second time; the row insert
// hits chat_stream_events_source_dedup on (message, sourceEventKey,
// sourceEventOrdinal) and is dropped. The content is then one application
// ahead of the log FOREVER, and the last committed id under-covers it — a
// cursor there would replay the tail onto content that already holds it.
test('a deduped content row gives up the cursor', async () => {
    // Over STREAM_FLUSH_MAX_CHARS so each token is its own row rather than
    // merging with its twin, which is what puts the second one in front of
    // the dedup index instead of concatenating it into the first one's row.
    const big = 'd'.repeat(9 * 1024)
    const harness = makeHarness([
        rawSourceEvent(1, 'line-one'),
        { type: 'token', text: big },
        // The same line again: same sourceSeq and same payload, so the same
        // key, and the ordinal counter restarts at 0 behind it.
        rawSourceEvent(1, 'line-one'),
        { type: 'token', text: big },
        { type: 'token', text: big }
    ])
    await harness.run()

    const dedupedAt = harness.dedupedAtRows()
    assert.ok(
        dedupedAt !== null,
        'the corpus must actually hit the dedup index'
    )
    // A cursor sampled BEFORE the drop is still exact and stays allowed; it
    // is everything after it that can no longer describe the content.
    assertPairingHolds(harness, 'deduped row')
    // Identified by the content, not by when the write went out: the token
    // whose row the index rejected is the SECOND `big`, so a snapshot holding
    // two of them was taken on the far side of the divergence. #749 detached
    // the write from the sample, so "how many rows existed when this write
    // ran" no longer answers the question the sample answers.
    const diverged = harness.checkpoints.filter(
        (c) => textChars(c.blocks) >= 2 * big.length
    )
    assert.ok(diverged.length > 0, 'the corpus must checkpoint after the dedup')
    for (const checkpoint of diverged)
        assert.equal(
            checkpoint.cursor,
            null,
            'no checkpoint may claim a cursor once a content row was deduped'
        )
    assert.ok(
        harness.checkpoints.some((c) => c.cursor !== null),
        'and the checkpoints taken before the drop still carried one'
    )
})

// The NUL case. Both sanitisers strip NUL before either looks at surrogates,
// so a row can end on a NUL and still leave the buffer holding half a pair —
// the raw last code unit says nothing.
test('a surrogate pair split behind a NUL still gives up the cursor', async () => {
    const filler = 'n'.repeat(9 * 1024)
    const harness = makeHarness([
        { type: 'token', text: filler },
        {
            type: 'token',
            text: filler + String.fromCharCode(0xd83d) + '\u0000'
        },
        { type: 'token', text: String.fromCharCode(0xde00) + filler },
        { type: 'token', text: filler }
    ])
    await harness.run()

    assertPairingHolds(harness, 'NUL-shifted surrogate')
    const splitRow = harness.rows.findIndex((row) =>
        String(row.payloadJson.text ?? '').includes('\uFFFD')
    )
    assert.ok(splitRow >= 0, 'the corpus must actually split a pair')
    for (const checkpoint of harness.checkpoints.filter(
        (c) => c.cursor !== null
    ))
        assert.ok(
            (checkpoint.cursor as bigint) < harness.rows[splitRow]!.id,
            `cursor ${checkpoint.cursor} must predate the split row`
        )
})

// `replace` installs its text through the same streaming sanitiser a token
// uses, so it can leave a carry behind exactly as a token can — and it is a
// content row, so a cursor could otherwise be sampled right past it.
test('a replace that ends mid surrogate pair gives up the cursor', async () => {
    const filler = 'r'.repeat(9 * 1024)
    const harness = makeHarness([
        { type: 'token', text: filler },
        {
            type: 'replace',
            text: filler + String.fromCharCode(0xd83d),
            reason: 'output_moderation'
        },
        { type: 'token', text: String.fromCharCode(0xde00) + filler },
        { type: 'token', text: filler }
    ])
    await harness.run()

    assertPairingHolds(harness, 'replace mid surrogate')
    const replaceRow = harness.rows.find((row) => row.eventType === 'replace')
    assert.ok(replaceRow, 'the replace row must have been written')
    for (const checkpoint of harness.checkpoints.filter(
        (c) => c.cursor !== null
    ))
        assert.ok(
            (checkpoint.cursor as bigint) < replaceRow.id,
            `cursor ${checkpoint.cursor} must predate the replace row`
        )
})

// Direct broadcaster tests for the three things settle() must refuse. They
// cannot be reached through runAdapter: it never checkpoints after a suspend
// or a terminal (both break the loop), while the writer that puts one of
// those rows on the chain mid-turn is a DIFFERENT call stack — an offline
// cancel, a restart terminal. So the guards are exercised where they live.
test('settle reports the last content row, not a status row behind it', async () => {
    const rows: StreamRow[] = []
    const broadcaster = makeBroadcaster(rows)
    broadcaster.beginStream('session-1', 'msg-1')

    await broadcaster.emit('msg-1', {
        type: 'token',
        payload: { type: 'token', text: 'answer' }
    })
    // What an offline cancel or a recovery notice queues from outside the
    // adapter loop. It is delivered, never folded into content — so a cursor
    // that covered it would hide it from everyone attaching afterwards.
    await broadcaster.emit('msg-1', {
        type: 'turn_status',
        payload: { type: 'turn_status', phase: 'recovering' }
    })
    await broadcaster.emit('msg-1', {
        type: 'suspended',
        payload: { type: 'suspended', reason: 'sprite_suspended' }
    })

    assert.equal(rows.length, 3)
    assert.equal(await broadcaster.settle('msg-1'), rows[0]!.id)
})

test('settle refuses a cursor once a write on the stream has failed', async () => {
    const rows: StreamRow[] = []
    let failNext = false
    const broadcaster = makeBroadcaster(rows, () => {
        if (failNext) throw new Error('insert failed')
    })
    broadcaster.beginStream('session-1', 'msg-1')

    await broadcaster.emit('msg-1', {
        type: 'token',
        payload: { type: 'token', text: 'head' }
    })
    assert.equal(await broadcaster.settle('msg-1'), rows[0]!.id)

    failNext = true
    await broadcaster
        .emit('msg-1', {
            type: 'tool_call',
            payload: { type: 'tool_call', toolCallId: 'c1', toolName: 'ls' }
        })
        .catch(() => undefined)

    // The rows behind the failure are abandoned, so the log has a hole the
    // content does not. No id describes that, and the turn falls back.
    assert.equal(await broadcaster.settle('msg-1'), null)
})

test('settle refuses a cursor for a turn this instance is not streaming', async () => {
    const broadcaster = makeBroadcaster([])
    assert.equal(await broadcaster.settle('msg-nobody-owns'), null)
})

const makeBroadcaster = (
    rows: StreamRow[],
    beforeInsert?: () => void
): ChatSseBroadcaster =>
    new ChatSseBroadcaster(
        {
            insertStreamEvent: async (row: Omit<StreamRow, 'id'>) => {
                beforeInsert?.()
                const id = 1000n + BigInt(rows.length)
                rows.push({ ...row, id })
                return { id }
            },
            maxStreamEventSeq: async () => 0
        } as never,
        noopBus
    )

interface Harness {
    run: () => Promise<void>
    checkpoints: Checkpoint[]
    rows: StreamRow[]
    dedupedAtRows: () => number | null
}

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    runtimeId: 'runtime-1',
    model: null
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: 'seeded',
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

// One live_stream raw line. Its sourceEventKey is a hash over the message id,
// the sourceSeq and the payload, so repeating both fields repeats the key.
const rawSourceEvent = (
    sourceSeq: number,
    rawText: string
): EmittedChatEvent => ({
    type: 'raw_source',
    source: {
        sourceSeq,
        rawFormat: 'jsonl',
        rawText,
        parserName: 'test',
        parserVersion: '1'
    }
})

const noopBus = {
    onMessage: () => undefined,
    onListenEstablished: () => undefined,
    notify: () => undefined
} as unknown as ChatStreamBus

const makeHarness = (events: EmittedChatEvent[]): Harness => {
    const rows: StreamRow[] = []
    const checkpoints: Checkpoint[] = []
    let dedupedAtRows: number | null = null

    // A real broadcaster over an in-memory log. Everything that makes the
    // pairing hard is inside it — the merge window, the detached chain, the
    // per-row ids — so stubbing it would test nothing.
    const streamRepo = {
        insertStreamEvent: async (
            row: Omit<StreamRow, 'id'>,
            terminalContent?: {
                contentBlocksJson: ChatContentBlock[]
                contentCheckpointEventId: bigint | null
            }
        ) => {
            // The chat_stream_events_source_dedup unique index, modelled.
            // Without it this harness would happily write a duplicate row and
            // the pairing would look sound where production drops one.
            if (
                row.sourceEventKey !== null &&
                rows.some(
                    (existing) =>
                        existing.sourceEventKey === row.sourceEventKey &&
                        existing.sourceEventOrdinal === row.sourceEventOrdinal
                )
            ) {
                dedupedAtRows ??= rows.length
                return { id: null }
            }
            const id = 1000n + BigInt(rows.length)
            if (terminalContent)
                checkpoints.push({
                    blocks: JSON.parse(
                        JSON.stringify(terminalContent.contentBlocksJson)
                    ) as ChatContentBlock[],
                    cursor: terminalContent.contentCheckpointEventId
                })
            rows.push({ ...row, id })
            return { id }
        },
        maxStreamEventSeq: async () => 0
    }
    const broadcaster = new ChatSseBroadcaster(streamRepo as never, noopBus)

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({
            set: (values: {
                contentBlocksJson?: ChatContentBlock[]
                contentCheckpointEventId?: bigint | null
            }) => ({
                where: async () => {
                    if (!('contentBlocksJson' in values)) return
                    checkpoints.push({
                        // Deep-copied because these assertions run after the
                        // turn, and a snapshot shares its tool blocks with
                        // the buffer that produced it.
                        blocks: JSON.parse(
                            JSON.stringify(values.contentBlocksJson)
                        ) as ChatContentBlock[],
                        cursor: values.contentCheckpointEventId ?? null
                    })
                }
            })
        })
    }

    const insertedMessages: Array<Record<string, unknown>> = []
    const repo = {
        writeAssistantContent: async (
            _messageId: string,
            blocks: ChatContentBlock[],
            cursor: bigint | null
        ) => {
            checkpoints.push({
                blocks: JSON.parse(
                    JSON.stringify(blocks)
                ) as ChatContentBlock[],
                cursor
            })
            return true
        },
        getSession: async () => sessionRow,
        insertMessage: async (row: Record<string, unknown>) => {
            insertedMessages.push(row)
            return row
        },
        listMessages: async () => insertedMessages,
        latestInflightMessageId: async () => null,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        upsertMessageSources: async () => ({ upserted: 0 }),
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined
    }

    const adapter = {
        sendMessage: async function* (ctx: {
            messageId: string
        }): AsyncIterable<EmittedChatEvent> {
            for (const event of events) yield event
            if (events.at(-1)?.type !== 'suspended')
                yield { type: 'done', finalMessageId: ctx.messageId }
        }
    }

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => adapter } as never,
        { record: async () => {} } as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: () => {} } as never,
        { event: () => {}, error: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

    let finished!: () => void
    const done = new Promise<void>((resolve) => {
        finished = resolve
    })
    const original = (
        service as unknown as {
            runAdapter: (...args: unknown[]) => Promise<void>
        }
    ).runAdapter.bind(service)
    ;(
        service as unknown as {
            runAdapter: (...args: unknown[]) => Promise<void>
        }
    ).runAdapter = async (...args: unknown[]): Promise<void> => {
        try {
            await original(...args)
        } finally {
            finished()
        }
    }

    return {
        checkpoints,
        rows,
        dedupedAtRows: () => dedupedAtRows,
        run: async () => {
            await service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
            await done
        }
    }
}
