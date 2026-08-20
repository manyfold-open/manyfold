import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'dify',
    runtime: 'external',
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
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({
            set: (values: { contentBlocksJson?: unknown }) => ({
                where: async () => {
                    if (!('contentBlocksJson' in values)) return
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
            streamEventRows.push(row)
            if (terminalContent)
                persistedContentBlocks.push(terminalContent.contentBlocksJson)
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
    const service = new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        { get: () => adapter } as never,
        {} as never,
        { build: async () => ({ root: { id: 'workspace' } }) } as never,
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

// The whole point of the event: what gets stored (and therefore what history,
// /v1/conversations and a reload show) must be the superseding answer, never
// the text that moderation took away.
test('a replace event supersedes the answer text that was already streamed', async () => {
    const harness = makeHarness([
        { type: 'token', text: 'here is how to ' },
        { type: 'token', text: 'do the bad thing' },
        {
            type: 'replace',
            text: 'I cannot help with that.',
            reason: 'output_moderation'
        }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    const blocks = harness.persistedContentBlocks.at(-1) as Array<
        Record<string, unknown>
    >
    assert.deepEqual(blocks, [
        { type: 'text', text: 'I cannot help with that.' }
    ])
})

// Reasoning and tool blocks describe how the turn ran; moderation replaced the
// answer, not the transcript of the work.
test('a replace event keeps thinking and tool blocks', async () => {
    const harness = makeHarness([
        { type: 'thinking', text: 'weighing options' },
        {
            type: 'tool_call',
            toolCallId: 'call-1',
            toolName: 'search',
            args: {}
        },
        { type: 'token', text: 'original answer' },
        { type: 'replace', text: 'replaced', reason: 'output_moderation' }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    const blocks = harness.persistedContentBlocks.at(-1) as Array<
        Record<string, unknown>
    >
    assert.deepEqual(
        blocks.map((block) => block.type),
        ['thinking', 'tool_call', 'text']
    )
    assert.equal(blocks.at(-1)?.text, 'replaced')
})

test('the last replace wins when moderation fires repeatedly', async () => {
    const harness = makeHarness([
        { type: 'token', text: 'first' },
        { type: 'replace', text: 'second', reason: 'output_moderation' },
        { type: 'token', text: ' continues' },
        { type: 'replace', text: 'final', reason: 'output_moderation' }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    const blocks = harness.persistedContentBlocks.at(-1) as Array<
        Record<string, unknown>
    >
    assert.deepEqual(blocks, [{ type: 'text', text: 'final' }])
})

test('a replace reaches subscribers as its own stream event', async () => {
    const harness = makeHarness([
        { type: 'token', text: 'original' },
        { type: 'replace', text: 'replaced', reason: 'output_moderation' }
    ])

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    await harness.adapterFinished

    const replaceRow = harness.streamEventRows.find(
        (row) => row.eventType === 'replace'
    )
    assert.ok(replaceRow, 'expected a persisted replace stream event')
    assert.deepEqual(replaceRow.payloadJson, {
        type: 'replace',
        text: 'replaced',
        reason: 'output_moderation'
    })
})
