import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ASSISTANT_BLOCKS_TRUNCATION_MARKER } from '../src/modules/chat/assistant-blocks'
import { ChatService } from '../src/modules/chat/chat.service'

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
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

// A turn that produces its whole answer inside one 2s tick used to reach the
// terminal having written the row exactly once, so a cold page load mid-turn
// found an empty row and had to replay the entire stream log. The byte rule
// makes the number of writes track the answer's SIZE, which is the thing a
// reader actually has to catch up on.
test('a fast turn checkpoints on content growth, not on the clock', async () => {
    const chunk = 'x'.repeat(10 * 1024)
    const harness = makeHarness(
        Array.from({ length: 20 }, () => ({
            type: 'token' as const,
            text: chunk
        }))
    )

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.ok(
        harness.writes.length >= 8,
        `expected the row to be checkpointed as content grew, saw ${harness.writes.length} writes`
    )
    assert.ok(
        harness.writes.length <= 25,
        `expected the growth rule to bound the writes, saw ${harness.writes.length}`
    )
    assert.ok(
        harness.writes[0]!.textChars <= 20 * 1024,
        'the first write should carry the head of the answer, not all of it'
    )
    assert.deepEqual(harness.finalBlocks(), [
        { type: 'text', text: chunk.repeat(20) }
    ])
})

// The quadratic this replaces: every tool boundary rewrote the whole row, so a
// turn with hundreds of tool calls wrote O(events x content) bytes and left
// one dead row version behind per call. Tool boundaries still checkpoint, but
// under the same +10% growth rule, so the total tracks content instead.
test('a tool-heavy turn does not rewrite the row once per tool boundary', async () => {
    const events: EmittedChatEvent[] = []
    for (let i = 0; i < 200; i += 1) {
        events.push({
            type: 'tool_call',
            toolCallId: `call-${i}`,
            toolName: 'read',
            args: { path: `/tmp/f${i}` },
            elapsedMs: 1
        })
        events.push({
            type: 'tool_result',
            toolCallId: `call-${i}`,
            result: { ok: true, bytes: i },
            elapsedMs: 1
        })
    }
    const harness = makeHarness(events)

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.ok(
        harness.writes.length <= 10,
        `expected a handful of writes for 400 tool events, saw ${harness.writes.length}`
    )
    assert.equal(harness.finalBlocks().length, 400)
})

// The byte rule is a checkpoint rule only. Whatever it decides, the terminal
// write is what makes the turn's content durable and is unconditional.
test('the terminal write lands even when no threshold was crossed', async () => {
    const harness = makeHarness([{ type: 'token', text: 'short' }])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.equal(harness.writes.length, 1)
    assert.deepEqual(harness.finalBlocks(), [{ type: 'text', text: 'short' }])
})

// Moderation superseding the answer is the one content change that must not
// wait for a byte threshold: whatever the row already holds is text the
// product has decided nobody should read.
test('a replace is written out without waiting for the byte threshold', async () => {
    const harness = makeHarness([
        { type: 'token', text: 'here is how to do the bad thing' },
        {
            type: 'replace',
            text: 'I cannot help with that.',
            reason: 'output_moderation'
        }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.equal(harness.writes.length, 2)
    assert.equal(
        harness.writes[0]!.textChars,
        'I cannot help with that.'.length
    )
})

// #672's cap counted PUSHES and only measured every 512 of them, so a turn
// that blows the cap in a few large blocks — one 1 MiB tool payload or answer
// chunk at a time — never triggered it at all. The buffer accounts as it
// appends, so the cap is enforced on the block that crosses it.
test('text past the in-memory cap is dropped with the durability marker', async () => {
    const oneMib = 'y'.repeat(1024 * 1024)
    const harness = makeHarness(
        Array.from({ length: 33 }, () => ({
            type: 'token' as const,
            text: oneMib
        }))
    )

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    const blocks = harness.finalBlocks()
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]!.text, ASSISTANT_BLOCKS_TRUNCATION_MARKER)
})

// A checkpoint write is best-effort: it is caught and logged, and the row it
// failed to update is a cache. What must not happen is the turn dying with it,
// or the bytes it was carrying going missing from the terminal write.
test('a failed checkpoint neither stops the turn nor loses content', async () => {
    const chunk = 'x'.repeat(10 * 1024)
    const harness = makeHarness(
        Array.from({ length: 5 }, () => ({
            type: 'token' as const,
            text: chunk
        })),
        { failWriteAt: 1 }
    )

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    // The failed attempt plus the terminal, and nothing in between: the bytes
    // are still owed and still past the growth bar, so without the failure
    // backoff every one of the remaining tokens would retry against a
    // database that has just demonstrated it is unwell.
    assert.equal(
        harness.writes.length,
        2,
        `no retry storm inside the backoff window, saw ${harness.writes.length} attempts`
    )
    assert.deepEqual(
        harness.finalBlocks(),
        [{ type: 'text', text: chunk.repeat(5) }],
        'the terminal write carries everything, including the failed window'
    )
})

// The turn under test runs on its own — sendMessage dispatches it and returns
// — so these two are how the assertions find a known point in it. Both are
// bounded and say what they were waiting for: a hang is the bug here, and a
// test that hangs while proving it reports nothing.
const until = async (
    what: string,
    ready: () => boolean,
    ms: number
): Promise<void> => {
    const deadline = Date.now() + ms
    while (!ready()) {
        if (Date.now() > deadline)
            throw new Error(`timed out after ${ms}ms waiting for ${what}`)
        await new Promise((resolve) => setTimeout(resolve, 1))
    }
}

const fenceDrops = (harness: {
    telemetry: TelemetryEvent[]
}): TelemetryEvent[] =>
    harness.telemetry.filter(
        (e) =>
            e.name === 'chat.content.checkpoint' &&
            e.attrs.outcome === 'dropped' &&
            e.attrs.reason === 'terminal_fence'
    )

// #749, the regression this file exists to hold. A checkpoint UPDATE waited
// 30.327s on staging for a pool connection that was already gone. Awaited from
// the adapter loop, that wait WAS the turn: no transport event was read, no
// stream row was written and the client saw nothing for half a minute, over a
// row that is a cache. The write is now sampled and handed off, so the only
// thing a stalled checkpoint can delay is the next checkpoint.
test('a checkpoint that blocks does not stop the turn reading events', async () => {
    const chunk = 'x'.repeat(10 * 1024)
    const harness = makeHarness(
        Array.from({ length: 5 }, () => ({
            type: 'token' as const,
            text: chunk
        })),
        { blockWriteAt: 1, snapshotText: true }
    )

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    // The assertion the fix is for: every token reaches the log while the
    // first checkpoint is still stuck in the pool. Before the fix only one
    // ever did, and this deadline is what fails.
    await harness.waitForEmitted('token', 5, 2_000)
    // And then the turn runs out of transport events and parks in the fence,
    // which is where the rest of this test wants it: released any earlier and
    // the backlog would race the fence for the right to be written.
    await until(
        'the terminal to reach the checkpoint fence',
        () => fenceDrops(harness).length > 0,
        2_000
    )

    assert.equal(
        harness.writes.length,
        1,
        `one checkpoint may be in flight at a time, saw ${harness.writes.length}`
    )
    assert.equal(
        harness.writes[0]!.text,
        chunk,
        'the stuck write carries the content sampled with its cursor, not the 5x that has arrived since'
    )
    assert.ok(
        !harness.emitted.includes('done'),
        'the terminal must wait behind the in-flight write, or it lands under an older prefix of the same row'
    )

    harness.release()
    await harness.adapterFinished

    assert.equal(
        harness.writes.length,
        2,
        `the stuck checkpoint, then the terminal, in that order — saw ${harness.writes.length}`
    )
    assert.equal(harness.writes[1]!.text, chunk.repeat(5))
    assert.equal(harness.writes[1]!.cursor, null, 'the terminal is cursorless')
    assert.deepEqual(harness.finalBlocks(), [
        { type: 'text', text: chunk.repeat(5) }
    ])

    // #749 AC: the stall has to be legible afterwards. `queuedMs` is what the
    // loop no longer waits for, and the drops say which checkpoints the stall
    // cost — the four events that re-sampled behind it coalesced into one
    // snapshot, which is the fence's to drop.
    const points = harness.telemetry.filter(
        (e) => e.name === 'chat.content.checkpoint'
    )
    const written = points.filter((e) => e.attrs.outcome === 'written')
    assert.equal(written.length, 1)
    assert.equal(written[0]!.attrs.cursored, true)
    assert.equal(typeof written[0]!.attrs.queuedMs, 'number')
    assert.equal(typeof written[0]!.attrs.durationMs, 'number')
    assert.equal(written[0]!.attrs.sessionId, 'session-1')
    assert.equal(typeof written[0]!.attrs.assistantMessageId, 'string')
    assert.equal(fenceDrops(harness).length, 1)
    assert.ok(
        points.some(
            (e) =>
                e.attrs.outcome === 'dropped' &&
                e.attrs.reason === 'newer_snapshot'
        ),
        'a superseded snapshot must be distinguishable from one a stall ate'
    )
    assert.ok(
        !JSON.stringify(points).includes('xxxxxxxx'),
        'checkpoint telemetry carries sizes, never the turn content'
    )
})

// The incident's actual ending: the UPDATE waited, and then failed. The wait
// is over by the time anything can be caught, so the snapshot queued behind it
// was sampled in ignorance of a database that has since proved unwell —
// running it is the retry the failure backoff exists to refuse.
test('a checkpoint that blocks and then fails drops what queued behind it', async () => {
    const chunk = 'x'.repeat(10 * 1024)
    const harness = makeHarness(
        Array.from({ length: 5 }, () => ({
            type: 'token' as const,
            text: chunk
        })),
        {
            blockWriteAt: 1,
            failWriteAt: 1,
            // While the loop still has events to read, so the failure lands
            // on a live turn with a snapshot waiting — not on the fence,
            // which drops it for a different reason.
            releaseAtEmitted: 3,
            snapshotText: true
        }
    )

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.equal(
        harness.writes.length,
        2,
        `the failed write and the terminal, nothing behind the failure — saw ${harness.writes.length}`
    )
    assert.equal(harness.writes[0]!.text, chunk)
    assert.equal(harness.writes[1]!.text, chunk.repeat(5))
    assert.deepEqual(
        harness.finalBlocks(),
        [{ type: 'text', text: chunk.repeat(5) }],
        'a checkpoint that never landed costs nothing: the terminal still carries the whole turn'
    )
    assert.equal(
        harness.emitted.filter((e) => e === 'token').length,
        5,
        'the turn kept reading through the block and the failure'
    )

    const points = harness.telemetry.filter(
        (e) => e.name === 'chat.content.checkpoint'
    )
    const failed = points.filter((e) => e.attrs.outcome === 'failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0]!.attrs.error, 'checkpoint write failed')
    assert.ok(
        points.some(
            (e) =>
                e.attrs.outcome === 'dropped' &&
                e.attrs.reason === 'after_failure'
        ),
        'a checkpoint the failure ate must not look like one that was superseded'
    )
})

// A suspended turn writes no terminal, so its last checkpoint is the row's
// final state until someone resumes it. The held-back surrogate lives outside
// the block array precisely so that state is always a legal jsonb value.
test('a suspended turn never writes a held-back surrogate', async () => {
    const half = 'h'.repeat(8 * 1024)
    const harness = makeHarness([
        { type: 'token', text: half },
        { type: 'token', text: half + String.fromCharCode(0xd83d) },
        {
            type: 'suspended',
            daemonId: 'dh-1',
            daemonExecRef: 'ref-1',
            reason: 'sprite_suspended'
        } as EmittedChatEvent
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.equal(
        harness.writes.length,
        2,
        'a suspended turn checkpoints but writes no terminal'
    )
    assert.equal(
        harness.writes[1]!.textChars,
        16 * 1024,
        'the unpaired high surrogate must be held back, not written'
    )
})

// The reviewer's sequence: a checkpoint lands, a replace supersedes it, that
// replace's forced write fails. What must NOT happen is the turn forgetting a
// write is owed — the row is holding text the product has decided nobody
// should read, and under a byte rule nothing else will trigger for another
// max(8 KiB, 10%) of growth.
test('a forced write that fails is still owed afterwards', async () => {
    const chunk = 'x'.repeat(9 * 1024)
    const harness = makeHarness(
        [
            { type: 'token', text: chunk },
            {
                type: 'replace',
                text: 'moderated',
                reason: 'output_moderation'
            } as EmittedChatEvent,
            { type: 'token', text: '!' },
            // More content after the retry, so the retry's write and the
            // terminal's carry different text — otherwise "the retry
            // happened" and "only the terminal happened" look identical.
            { type: 'token', text: 'zzz' }
        ],
        {
            // 1: the growth checkpoint lands. 2: the forced write fails.
            failWriteAt: 2,
            snapshotText: true,
            // Past the failure backoff, so the next event may retry.
            pauseMsBeforeIndex: { 2: 2_400 }
        }
    )

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.equal(
        harness.writes.length,
        4,
        `growth write, failed forced write, retry, terminal — saw ${harness.writes.length}`
    )
    assert.equal(
        harness.writes[2]!.text,
        'moderated!',
        'the retry happens mid-turn and carries the superseded-away content'
    )
    assert.equal(harness.writes[3]!.text, 'moderated!zzz')
})

// runAdapterFromIterable is the path external convergence runs on, and
// convergence is where `replace` comes from. It writes content only at the
// terminal, so without an explicit forced write the row would never learn the
// answer was superseded until then.
test('the recovery path writes a superseded answer before its terminal', async () => {
    const harness = makeResumeHarness([
        { type: 'token', text: 'draft answer' },
        {
            type: 'replace',
            text: 'converged answer',
            reason: 'upstream_converged'
        } as EmittedChatEvent,
        { type: 'done', finalMessageId: 'msg-1' } as EmittedChatEvent
    ])

    await harness.resume()

    assert.equal(
        harness.writes.length,
        2,
        'one write at the replace, one at the terminal'
    )
    assert.equal(harness.writes[0]!.text, 'converged answer')
    assert.equal(harness.writes[1]!.text, 'converged answer')
    // And neither write claims a checkpoint cursor. This path seeds its
    // blocks from the WHOLE stream log and then appends, so its content is
    // not the fold of any prefix this instance can name — and the pre-crash
    // dispatch may well have left a cursor on the row that now describes
    // less content than it holds.
    assert.deepEqual(
        harness.writes.map((w) => w.cursor),
        [null, null]
    )
})

const resumeMessageRow = {
    id: 'msg-1',
    sessionId: 'session-1',
    daemonId: 'dh-1',
    daemonExecRef: 'ref-1',
    cancelRequestedAt: null,
    abortDispatchedAt: null,
    createdAt: new Date(Date.now() - 60_000)
}

const makeResumeHarness = (
    events: EmittedChatEvent[]
): {
    resume: () => ReturnType<ChatService['resumeAssistantTurn']>
    writes: ContentWrite[]
} => {
    const writes: ContentWrite[] = []
    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: () => ({
                        limit: async () => [
                            {
                                framework: 'dify',
                                runtime: 'external',
                                runtimeId: 'rt-1',
                                model: null,
                                modelProviderId: null,
                                modelProviderBuiltInId: null,
                                daemonId: 'dh-1',
                                spriteName: null,
                                workspacePath: null
                            }
                        ]
                    })
                })
            })
        }),
        update: () => ({
            set: (values: { contentBlocksJson?: unknown }) => ({
                where: async () => {
                    if (!('contentBlocksJson' in values)) return
                    const blocks = values.contentBlocksJson as Array<
                        Record<string, unknown>
                    >
                    writes.push({
                        types: blocks.map((block) => String(block.type)),
                        textChars: 0,
                        text: blocks
                            .map((block) =>
                                typeof block.text === 'string' ? block.text : ''
                            )
                            .join(''),
                        cursor:
                            (
                                values as {
                                    contentCheckpointEventId?: bigint | null
                                }
                            ).contentCheckpointEventId ?? null
                    })
                }
            })
        })
    }
    const repo = {
        writeAssistantContent: async (
            _messageId: string,
            blocks: Array<Record<string, unknown>>,
            cursor: bigint | null
        ) => {
            writes.push({
                types: blocks.map((block) => String(block.type)),
                textChars: 0,
                text: blocks
                    .map((block) =>
                        typeof block.text === 'string' ? block.text : ''
                    )
                    .join(''),
                cursor
            })
            return true
        },
        getSessionById: async () => sessionRow,
        getMessageById: async () => resumeMessageRow,
        getTurnExecution: async () => null,
        claimTurnForResume: async () => ({
            outcome: 'claimed' as const,
            row: {
                messageId: 'msg-1',
                sessionId: 'session-1',
                agentId: 'agent-1',
                runtime: 'external' as const,
                ownerId: 'owner-1',
                generation: 2,
                state: 'running' as const
            }
        }),
        renewTurnLease: async () => true,
        maxStreamEventSeq: async () => 0,
        boundedResumeStatusOrdinal: async () => 0,
        touchSession: async () => undefined,
        upsertMessageSources: async () => undefined,
        listStreamEventsSince: async () => [],
        releaseInflightTurn: async () => undefined
    }
    const broadcaster = {
        hasStream: () => false,
        beginStream: () => undefined,
        setStreamFence: () => undefined,
        beginResumeStream: async () => undefined,
        emit: async (
            _messageId: string,
            _event: { type: string },
            terminalContent?: {
                contentBlocksJson: Array<Record<string, unknown>>
                contentCheckpointEventId: bigint | null
            }
        ) => {
            if (terminalContent)
                await repo.writeAssistantContent(
                    _messageId,
                    terminalContent.contentBlocksJson,
                    terminalContent.contentCheckpointEventId
                )
            return { persisted: true }
        },
        emitDetached: async () => undefined,
        settle: async () => 42n,
        endStream: () => undefined
    }
    const adapters = {
        get: () => ({
            resumeMessage: async function* (): AsyncIterable<EmittedChatEvent> {
                for (const event of events) yield event
            }
        })
    }
    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        { record: async () => {} } as never,
        {} as never,
        {} as never,
        { event: () => {}, error: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { emit: () => undefined } as never,
        {
            ownerId: 'owner-1',
            enabled: true,
            kick: () => undefined
        } as never,
        undefined,
        undefined
    )
    return {
        writes,
        resume: () =>
            service.resumeAssistantTurn({
                message: resumeMessageRow as never,
                daemonId: 'dh-1',
                refId: 'ref-1'
            })
    }
}

interface ContentWrite {
    types: string[]
    textChars: number
    text: string
    cursor: bigint | null
}

interface TelemetryEvent {
    name: string
    attrs: Record<string, unknown>
}

const makeHarness = (
    events: EmittedChatEvent[],
    opts: {
        failWriteAt?: number
        snapshotText?: boolean
        pauseMsBeforeIndex?: Record<number, number>
        // Hold the Nth content write open until it is released: it has been
        // issued and neither succeeds nor fails until then. The incident
        // shape, with an unbounded ceiling instead of its 30.327s — a test
        // that slept for the real duration would prove less and cost more.
        blockWriteAt?: number
        // Release it from inside the loop, as the Nth stream event is
        // emitted, so a test can see a blocked write FAIL while the turn is
        // still running. Ordered by the event, not by a timer.
        releaseAtEmitted?: number
    } = {}
): {
    service: ChatService
    writes: ContentWrite[]
    emitted: string[]
    telemetry: TelemetryEvent[]
    // Resolve once `count` events of `type` have been emitted, and REJECT
    // after `ms`. A deadline, not a sleep: what is under test is that the loop
    // keeps moving while a write is stuck, so the test has to fail if it stops.
    waitForEmitted: (type: string, count: number, ms: number) => Promise<void>
    release: () => void
    finalBlocks: () => Array<Record<string, unknown>>
    adapterFinished: Promise<void>
} => {
    let adapterFinishedResolve!: () => void
    const adapterFinished = new Promise<void>((r) => {
        adapterFinishedResolve = r
    })
    let release!: () => void
    const blockedWrite = new Promise<void>((r) => {
        release = r
    })
    const insertedMessages: Array<Record<string, unknown>> = []
    const writes: ContentWrite[] = []
    const telemetry: TelemetryEvent[] = []
    // Facts about each write are captured as it is issued rather than read
    // back at the end, so the assertions can talk about what a given write
    // carried. Only cheap O(blocks) ones; the last array is read after the
    // turn ends, when nothing is writing any more.
    let lastBlocks: Array<Record<string, unknown>> = []

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({
            set: (values: { contentBlocksJson?: unknown }) => ({
                where: async () => {
                    if (!('contentBlocksJson' in values)) return
                    const blocks = values.contentBlocksJson as Array<
                        Record<string, unknown>
                    >
                    let textChars = 0
                    for (const block of blocks)
                        if (typeof block.text === 'string')
                            textChars += block.text.length
                    writes.push({
                        types: blocks.map((block) => String(block.type)),
                        textChars,
                        // O(content), so only where a test needs to see what
                        // a given write actually carried.
                        text: opts.snapshotText
                            ? blocks
                                  .map((block) =>
                                      typeof block.text === 'string'
                                          ? block.text
                                          : ''
                                  )
                                  .join('')
                            : '',
                        cursor:
                            (
                                values as {
                                    contentCheckpointEventId?: bigint | null
                                }
                            ).contentCheckpointEventId ?? null
                    })
                    const index = writes.length
                    // Block first, then fail: an UPDATE that waits and then
                    // reports a closed connection is the incident itself.
                    if (index === opts.blockWriteAt) await blockedWrite
                    if (index === opts.failWriteAt)
                        throw new Error('checkpoint write failed')
                    lastBlocks = blocks
                }
            })
        })
    }
    const repo = {
        writeAssistantContent: async (
            _messageId: string,
            blocks: Array<Record<string, unknown>>,
            cursor: bigint | null
        ) => {
            let textChars = 0
            for (const block of blocks)
                if (typeof block.text === 'string')
                    textChars += block.text.length
            writes.push({
                types: blocks.map((block) => String(block.type)),
                textChars,
                text: opts.snapshotText
                    ? blocks
                          .map((block) =>
                              typeof block.text === 'string' ? block.text : ''
                          )
                          .join('')
                    : '',
                cursor
            })
            const index = writes.length
            if (index === opts.blockWriteAt) await blockedWrite
            if (index === opts.failWriteAt)
                throw new Error('checkpoint write failed')
            lastBlocks = blocks
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
        insertStreamEvent: async () => ({ id: BigInt(1) }),
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined
    }
    const emitted: string[] = []
    let waiter: { type: string; count: number; resolve: () => void } | null =
        null
    const seen = (type: string): number =>
        emitted.filter((e) => e === type).length
    const recordEmit = (event: { type: string }): void => {
        emitted.push(event.type)
        if (emitted.length === opts.releaseAtEmitted) release()
        if (waiter && seen(waiter.type) >= waiter.count) {
            waiter.resolve()
            waiter = null
        }
    }
    const broadcaster = {
        beginStream: () => undefined,
        emit: async (
            _messageId: string,
            event: { type: string },
            terminalContent?: {
                contentBlocksJson: Array<Record<string, unknown>>
                contentCheckpointEventId: bigint | null
            }
        ) => {
            recordEmit(event)
            if (terminalContent)
                await repo.writeAssistantContent(
                    _messageId,
                    terminalContent.contentBlocksJson,
                    terminalContent.contentCheckpointEventId
                )
            return { persisted: true }
        },
        emitDetached: async (_messageId: string, event: { type: string }) => {
            recordEmit(event)
            return true
        },
        settle: async () => 42n,
        endStream: () => undefined
    }
    const adapter = {
        sendMessage: async function* (
            ctx: ApiChatAdapterContext
        ): AsyncIterable<EmittedChatEvent> {
            for (const [i, event] of events.entries()) {
                const pause = opts.pauseMsBeforeIndex?.[i]
                if (pause)
                    await new Promise((resolve) => setTimeout(resolve, pause))
                yield event
            }
            yield { type: 'done', finalMessageId: ctx.messageId }
        }
    }

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => adapter } as never,
        {} as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
        { publishStatus: () => {} } as never,
        {
            event: (name: string, attrs: Record<string, unknown>) =>
                telemetry.push({ name, attrs }),
            error: () => {}
        } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

    const originalRun = (
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
            await originalRun(...args)
        } finally {
            adapterFinishedResolve()
        }
    }

    return {
        service,
        writes,
        emitted,
        telemetry,
        waitForEmitted: (type, count, ms) =>
            seen(type) >= count
                ? Promise.resolve()
                : new Promise((resolve, reject) => {
                      const timer = setTimeout(
                          () =>
                              reject(
                                  new Error(
                                      `only ${seen(type)} of ${count} ${type} events reached the log within ${ms}ms`
                                  )
                              ),
                          ms
                      )
                      waiter = {
                          type,
                          count,
                          resolve: () => {
                              clearTimeout(timer)
                              resolve()
                          }
                      }
                  }),
        release,
        finalBlocks: () => lastBlocks,
        adapterFinished
    }
}
