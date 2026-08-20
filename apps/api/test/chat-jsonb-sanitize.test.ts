import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ASSISTANT_BLOCKS_TRUNCATION_MARKER } from '../src/modules/chat/assistant-blocks'
import { ChatService } from '../src/modules/chat/chat.service'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'
import { sanitizeForJsonb } from '../src/common/jsonb-sanitize'

const NUL = '\u0000'
const LONE_SURROGATE = '\uD800'
const REPLACEMENT = '\uFFFD'
// The two halves of 😀, handed to the stream as separate deltas.
const EMOJI_HIGH = String.fromCharCode(0xd83d)
const EMOJI_LOW = String.fromCharCode(0xde00)

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

test('sanitizeForJsonb strips NUL and replaces lone surrogates deeply', () => {
    const sanitized = sanitizeForJsonb({
        text: `a${NUL}b`,
        [`k${NUL}ey`]: [`x${NUL}`, `lo${LONE_SURROGATE}ne`],
        emoji: '😀',
        count: 3,
        ok: true,
        nothing: null
    })
    assert.deepEqual(sanitized, {
        text: 'ab',
        key: ['x', `lo${REPLACEMENT}ne`],
        emoji: '😀',
        count: 3,
        ok: true,
        nothing: null
    })
})

test('sanitizeForJsonb leaves non-plain objects untouched', () => {
    const at = new Date()
    assert.equal(sanitizeForJsonb(at), at)
})

test('turn with NUL in token and tool_result persists and ends with done', async () => {
    const harness = makeHarness([
        { type: 'token', text: `tok${NUL}` },
        { type: 'token', text: 'en' },
        {
            type: 'tool_result',
            toolCallId: 'tool-1',
            result: {
                output: `a${NUL}b`,
                broken: `x${LONE_SURROGATE}`,
                emoji: '😀'
            },
            elapsedMs: 5
        }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    const types = harness.streamEventRows.map((row) => row.eventType)
    assert.deepEqual(
        types,
        ['token', 'token', 'tool_result', 'done'],
        'turn must complete with done, not error'
    )

    const tokenPayload = harness.streamEventRows[0]?.payloadJson as {
        text: string
    }
    assert.equal(tokenPayload.text, 'tok')

    const toolPayload = harness.streamEventRows[2]?.payloadJson as {
        result: { output: string; broken: string; emoji: string }
    }
    assert.equal(toolPayload.result.output, 'ab')
    assert.equal(toolPayload.result.broken, `x${REPLACEMENT}`)
    assert.equal(toolPayload.result.emoji, '😀')

    const blocks = harness.persistedContentBlocks.at(-1) as Array<
        Record<string, unknown>
    >
    assert.deepEqual(blocks[0], { type: 'text', text: 'token' })
    const toolBlock = blocks.find(
        (block) => block.type === 'tool_result'
    ) as unknown as { result: { output: string; broken: string } }
    assert.equal(toolBlock.result.output, 'ab')
    assert.equal(toolBlock.result.broken, `x${REPLACEMENT}`)
})

// Content blocks are sanitized when each delta is buffered, not when the row
// is written, so the safety of a write now depends on EVERY producer going
// through the buffer. One case per block kind, and the turn is long enough to
// force a mid-turn checkpoint so the intermediate write is covered too — the
// fake db below rejects a NUL exactly like Postgres does.
test('every block kind is jsonb-safe by the time it is buffered', async () => {
    const harness = makeHarness([
        { type: 'thinking', text: `plan${NUL}ning` },
        {
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: `re${NUL}ad`,
            args: { path: `/tmp/${NUL}f`, [`k${NUL}`]: [`v${LONE_SURROGATE}`] }
        },
        {
            type: 'tool_result',
            toolCallId: 'call-1',
            result: { output: `ok${NUL}` }
        },
        // Past the 8 KiB checkpoint floor, so a partial write happens before
        // the terminal one and has to be safe on its own.
        { type: 'token', text: `${NUL}x`.repeat(6 * 1024) },
        { type: 'replace', text: `safe${NUL}r`, reason: 'output_moderation' }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.ok(
        harness.persistedContentBlocks.length >= 2,
        'expected a mid-turn checkpoint to land, not just the terminal write'
    )
    const blocks = harness.persistedContentBlocks.at(-1) as Array<
        Record<string, unknown>
    >
    assert.equal(containsNul(blocks), false)
    assert.deepEqual(
        blocks.map((block) => block.type),
        ['thinking', 'tool_call', 'tool_result', 'text']
    )
    assert.equal(blocks[0]?.text, 'planning')
    assert.deepEqual(blocks[1]?.args, {
        path: '/tmp/f',
        k: [`v${REPLACEMENT}`]
    })
    assert.equal(blocks[1]?.toolName, 'read')
    assert.deepEqual(blocks[2]?.result, { output: 'ok' })
    assert.equal(blocks[3]?.text, 'safer')
})

// A delta boundary is not a character boundary: an agent can split a surrogate
// PAIR across two token events. Sanitizing each delta on its own would see two
// lone surrogates and turn one emoji into two U+FFFD, so the buffer holds a
// trailing high surrogate back for the next delta instead.
test('a surrogate pair split across two token events stays one character', async () => {
    const harness = makeHarness([
        { type: 'token', text: `hi ${EMOJI_HIGH}` },
        { type: 'token', text: `${EMOJI_LOW} there` }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    const blocks = harness.persistedContentBlocks.at(-1) as Array<
        Record<string, unknown>
    >
    assert.deepEqual(blocks, [{ type: 'text', text: 'hi 😀 there' }])
})

// NUL can land between the two halves, which is why it is stripped before the
// held-back surrogate is chosen rather than after.
test('a split surrogate pair survives a NUL between its halves', async () => {
    const harness = makeHarness([
        { type: 'token', text: `${EMOJI_HIGH}${NUL}` },
        { type: 'token', text: EMOJI_LOW }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    assert.deepEqual(harness.persistedContentBlocks.at(-1), [
        { type: 'text', text: '😀' }
    ])
})

// The held-back surrogate is only ever a bet on the next delta. When the run
// ends — at a block of another kind, or at the terminal — the bet is off and
// it is a lone surrogate like any other.
test('a high surrogate with no partner is replaced at the run boundary', async () => {
    const harness = makeHarness([
        { type: 'token', text: `a${EMOJI_HIGH}` },
        { type: 'tool_result', toolCallId: 'call-1', result: 'r' },
        { type: 'token', text: EMOJI_LOW },
        { type: 'thinking', text: `t${EMOJI_HIGH}` }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    const blocks = harness.persistedContentBlocks.at(-1) as Array<
        Record<string, unknown>
    >
    assert.deepEqual(
        blocks.map((block) => block.text ?? block.type),
        [`a${REPLACEMENT}`, 'tool_result', REPLACEMENT, `t${REPLACEMENT}`]
    )
})

// The marker is written into content_blocks_json without going through the
// sanitizer, which is only safe while the constant itself is safe.
test('the truncation marker needs no sanitizing', () => {
    assert.equal(
        sanitizeForJsonb(ASSISTANT_BLOCKS_TRUNCATION_MARKER),
        ASSISTANT_BLOCKS_TRUNCATION_MARKER
    )
})

const containsNul = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(NUL)
    if (Array.isArray(value)) return value.some(containsNul)
    if (value !== null && typeof value === 'object')
        return Object.entries(value).some(
            ([key, item]) => key.includes(NUL) || containsNul(item)
        )
    return false
}

const makeHarness = (
    events: EmittedChatEvent[]
): {
    service: ChatService
    streamEventRows: Array<{ eventType: string; payloadJson: unknown }>
    persistedContentBlocks: unknown[]
    adapterFinished: Promise<void>
} => {
    let adapterFinishedResolve!: () => void
    const adapterFinished = new Promise<void>((r) => {
        adapterFinishedResolve = r
    })
    const insertedMessages: Array<Record<string, unknown>> = []
    const streamEventRows: Array<{ eventType: string; payloadJson: unknown }> =
        []
    const persistedContentBlocks: unknown[] = []

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agentRow]
                })
            })
        }),
        update: () => ({
            set: (values: { contentBlocksJson?: unknown }) => ({
                where: async () => {
                    if (!('contentBlocksJson' in values)) return
                    if (containsNul(values.contentBlocksJson))
                        throw new Error('unsupported Unicode escape sequence')
                    persistedContentBlocks.push(values.contentBlocksJson)
                }
            })
        })
    }
    const repo = {
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
        writeAssistantContent: async (_messageId: string, blocks: unknown) => {
            if (containsNul(blocks))
                throw new Error('unsupported Unicode escape sequence')
            persistedContentBlocks.push(blocks)
            return true
        },
        insertStreamEvent: async (
            row: {
                eventType: string
                payloadJson: unknown
            },
            terminalContent?: {
                contentBlocksJson: unknown
                contentCheckpointEventId: bigint | null
            }
        ) => {
            if (containsNul(row.payloadJson))
                throw new Error('unsupported Unicode escape sequence')
            streamEventRows.push(row)
            if (terminalContent) {
                if (containsNul(terminalContent.contentBlocksJson))
                    throw new Error('unsupported Unicode escape sequence')
                persistedContentBlocks.push(terminalContent.contentBlocksJson)
            }
            return { id: BigInt(streamEventRows.length) }
        },
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined
    }
    const bus = {
        onMessage: () => undefined,
        onListenEstablished: () => undefined,
        notify: () => undefined
    }
    const broadcaster = new ChatSseBroadcaster(repo as never, bus as never)
    const adapter = {
        sendMessage: async function* (
            ctx: ApiChatAdapterContext
        ): AsyncIterable<EmittedChatEvent> {
            for (const event of events) yield event
            yield { type: 'done', finalMessageId: ctx.messageId }
        }
    }
    const adapters = { get: () => adapter }
    const files = {
        build: async () => ({
            root: { id: 'workspace' }
        })
    }

    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        {} as never,
        files as never,
        { publishStatus: () => {} } as never,
        { event: () => {}, error: () => {} } as never,
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
        streamEventRows,
        persistedContentBlocks,
        adapterFinished
    }
}
