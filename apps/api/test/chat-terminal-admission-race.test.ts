import type { ChatStreamEvent } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { EmittedChatEvent } from '../src/modules/chat/chat-adapter'
import type { ChatStreamBus } from '../src/modules/chat/chat-stream-bus'
import { ChatSseBroadcaster } from '../src/modules/chat/sse-broadcaster'
import { ChatService } from '../src/modules/chat/chat.service'

// The race #701 was reported from, driven through ChatService and the real
// broadcaster/pump with deterministic in-memory repository fakes.
//
// Two writers, one message. completeOfflineCancel() terminalizes a turn whose
// daemon is gone; the adapter this instance is still reading has not stopped
// and keeps handing over tool events. The cancel's terminal used to close
// admission only AFTER its row committed, so everything the adapter produced
// during that commit drew a seq and queued behind it — and the adapter's own
// `done` landed as a second terminal on top.
//
// The reader here is the real SSE pump. It delivers every durable row in id
// order, including a bad row after a terminal; the web consumer would then
// make the finished turn appear live again.

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

const TERMINAL_TYPES = new Set(['done', 'error'])

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

const noopBus = {
    onMessage: () => undefined,
    onListenEstablished: () => undefined,
    notify: () => undefined
} as unknown as ChatStreamBus

const signal = (): { wait: Promise<void>; fire: () => void } => {
    let fire = (): void => undefined
    const wait = new Promise<void>((resolve) => {
        fire = resolve
    })
    // Not unref'd, and deliberately: a regression that never reaches one of
    // these steps must end in the assertion below rather than in a runner
    // timeout with no explanation.
    const safety = setTimeout(() => fire(), 5_000)
    return {
        wait,
        fire: () => {
            clearTimeout(safety)
            fire()
        }
    }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

interface Harness {
    rows: StreamRow[]
    delivered: ChatStreamEvent[]
    telemetry: Array<{ name: string; properties: Record<string, unknown> }>
    contentBlocks: () => unknown
    run: () => Promise<void>
}

const makeHarness = (): Harness => {
    const rows: StreamRow[] = []
    const delivered: ChatStreamEvent[] = []
    const adapterStarted = signal()
    const adapterReleased = signal()
    const lateEventAttempted = signal()
    const terminalInsertStarted = signal()
    const terminalInsertReleased = signal()
    let assistantMessageId = ''
    const insertedMessages: Array<Record<string, unknown>> = []
    const telemetry: Array<{
        name: string
        properties: Record<string, unknown>
    }> = []

    const streamRepo = {
        insertStreamEvent: async (
            row: Omit<StreamRow, 'id'>,
            terminalContent?:
                | {
                      contentBlocksJson: unknown[]
                      contentCheckpointEventId: bigint | null
                  }
                | { replayFromStream: true }
        ) => {
            // The cancel's terminal is held mid-INSERT. Everything the
            // adapter produces from here until it is released arrives while
            // the terminal is admitted but not yet durable — the window.
            if (row.eventType === 'error') {
                terminalInsertStarted.fire()
                await terminalInsertReleased.wait
            }
            // chat_stream_events_source_dedup, modelled.
            if (
                row.sourceEventKey !== null &&
                rows.some(
                    (existing) =>
                        existing.messageId === row.messageId &&
                        existing.sourceEventKey === row.sourceEventKey &&
                        existing.sourceEventOrdinal === row.sourceEventOrdinal
                )
            )
                return { id: null }
            if (terminalContent) {
                const assistant = insertedMessages.find(
                    (message) => message.role === 'assistant'
                )
                if (assistant)
                    Object.assign(
                        assistant,
                        'replayFromStream' in terminalContent
                            ? {
                                  contentBlocksJson: rows
                                      .filter(
                                          (candidate) =>
                                              candidate.messageId ===
                                                  row.messageId &&
                                              candidate.eventType === 'token'
                                      )
                                      .map((candidate) => ({
                                          type: 'text',
                                          text: candidate.payloadJson.text
                                      })),
                                  contentCheckpointEventId: null
                              }
                            : terminalContent
                    )
            }
            const id = 1000n + BigInt(rows.length)
            rows.push({ ...row, id })
            return { id }
        },
        maxStreamEventSeq: async (messageId: string) =>
            rows
                .filter((row) => row.messageId === messageId)
                .reduce((max, row) => Math.max(max, row.seq), 0),
        findTerminalStreamEvent: async (messageId: string) => {
            const row = rows.find(
                (candidate) =>
                    candidate.messageId === messageId &&
                    TERMINAL_TYPES.has(candidate.eventType)
            )
            return row
                ? { eventType: row.eventType, payloadJson: row.payloadJson }
                : null
        },
        streamAttachAnchor: async (sessionId: string) => ({
            inflightMessageId: null,
            maxEventId: rows
                .filter((row) => row.sessionId === sessionId)
                .reduce((max, row) => (row.id > max ? row.id : max), 0n)
        }),
        minStreamEventId: async (messageId: string) =>
            rows.find((row) => row.messageId === messageId)?.id ?? null,
        listSessionStreamEventsSince: async (
            sessionId: string,
            afterId: bigint,
            limit: number
        ) =>
            rows
                .filter(
                    (row) => row.sessionId === sessionId && row.id > afterId
                )
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .slice(0, limit)
    }
    const broadcaster = new ChatSseBroadcaster(streamRepo as never, noopBus)

    const db = {
        select: () => ({
            from: () => ({
                leftJoin: () => ({
                    where: () => ({ limit: async () => [agentRow] })
                }),
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({
            set: (values: Record<string, unknown>) => ({
                where: async () => {
                    const assistant = insertedMessages.find(
                        (row) => row.role === 'assistant'
                    )
                    if (assistant) Object.assign(assistant, values)
                }
            })
        })
    }

    const repo = {
        writeAssistantContent: async (
            _messageId: string,
            blocks: unknown[],
            cursor: bigint | null
        ) => {
            const assistant = insertedMessages.find(
                (row) => row.role === 'assistant'
            )
            if (assistant)
                Object.assign(assistant, {
                    contentBlocksJson: blocks,
                    contentCheckpointEventId: cursor
                })
            return true
        },
        getSession: async () => sessionRow,
        getSessionById: async () => sessionRow,
        getMessageById: async () =>
            insertedMessages.find((row) => row.role === 'assistant') ?? null,
        listContentStreamEvents: async (messageId: string) =>
            rows
                .filter(
                    (row) =>
                        row.messageId === messageId &&
                        !TERMINAL_TYPES.has(row.eventType)
                )
                .map((row) => ({
                    id: row.id,
                    eventType: row.eventType,
                    payloadJson: row.payloadJson
                })),
        insertMessage: async (row: Record<string, unknown>) => {
            insertedMessages.push(row)
            return row
        },
        listMessages: async () => insertedMessages,
        latestInflightMessageId: async () => null,
        getTurnExecution: async () => null,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        upsertMessageSources: async () => ({ upserted: 0 }),
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined,
        ...streamRepo
    }

    const adapter = {
        sendMessage: async function* (ctx: {
            messageId: string
        }): AsyncIterable<EmittedChatEvent> {
            assistantMessageId = ctx.messageId
            yield { type: 'token', text: 'working on it' }
            adapterStarted.fire()
            await adapterReleased.wait
            lateEventAttempted.fire()
            yield {
                type: 'tool_call',
                toolCallId: 'call-late',
                toolName: 'Bash',
                args: { command: 'ls' }
            }
            yield { type: 'tool_result', toolCallId: 'call-late', result: 'ok' }
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
        {
            event: (name: string, properties: Record<string, unknown>) =>
                telemetry.push({ name, properties }),
            error: () => {}
        } as never,
        undefined as never,
        undefined as never,
        undefined as never
    )

    return {
        rows,
        delivered,
        telemetry,
        contentBlocks: () =>
            insertedMessages.find((row) => row.role === 'assistant')
                ?.contentBlocksJson,
        run: async () => {
            // Attached before the turn, like an open tab: it sees every row
            // from the start, in id order, exactly as production does.
            await broadcaster.subscribe(
                'session-1',
                {
                    send: (event) => delivered.push(event),
                    close: () => undefined
                },
                null
            )
            await service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
            await adapterStarted.wait

            const message = {
                id: assistantMessageId,
                sessionId: 'session-1',
                role: 'assistant',
                createdAt: new Date()
            }
            const cancel = service.completeOfflineCancel({
                message: message as never,
                daemonId: 'daemon-1',
                refId: 'ref-1'
            })
            await terminalInsertStarted.wait
            adapterReleased.fire()
            await lateEventAttempted.wait
            terminalInsertReleased.fire()

            await cancel
            const deadline = Date.now() + 5_000
            while (service.activeTurnCount() > 0) {
                if (Date.now() > deadline)
                    throw new Error('turn did not finish')
                await sleep(5)
            }
            // The pump is asynchronous, so give a row that DID commit behind
            // the terminal every chance to be delivered before reading.
            await sleep(100)
        }
    }
}

test('an offline cancel racing a live adapter leaves exactly one terminal, last', async () => {
    const harness = makeHarness()
    await harness.run()

    const terminals = harness.rows.filter((row) =>
        TERMINAL_TYPES.has(row.eventType)
    )
    assert.equal(
        terminals.length,
        1,
        `the turn must have exactly one terminal row, saw ${harness.rows.map((row) => row.eventType).join(', ')}`
    )
    assert.equal(terminals[0]?.eventType, 'error')
    assert.equal(
        (terminals[0]?.payloadJson.error as { code: string } | undefined)?.code,
        'cancelled_by_user'
    )
    assert.equal(
        harness.rows.at(-1)?.eventType,
        'error',
        'no row may commit after the terminal'
    )

    // The pump exposes durable order exactly, so a row after the terminal
    // would be visible here rather than hidden by the test harness.
    const seen = harness.delivered.map((event) => event.type)
    assert.equal(
        seen.filter((type) => TERMINAL_TYPES.has(type)).length,
        1,
        `a subscriber must see one terminal, saw ${seen.join(', ')}`
    )
    assert.equal(seen.at(-1), 'error')
    assert.deepEqual(seen, ['token', 'error'])
    assert.deepEqual(
        harness.delivered.map((event) => event.eventId),
        harness.rows.map((row) => String(row.id))
    )
    const terminalTelemetry = harness.telemetry.filter(
        (event) => event.name === 'chat.turn.terminal'
    )
    assert.equal(terminalTelemetry.length, 1)
    assert.equal(terminalTelemetry[0]?.properties.outcome, 'cancelled')
    assert.equal(terminalTelemetry[0]?.properties.via, 'offline_cancel')
    assert.equal(
        harness.telemetry.filter(
            (event) => event.name === 'chat.stream.complete'
        ).length,
        0
    )
    assert.deepEqual(harness.contentBlocks(), [
        { type: 'text', text: 'working on it' }
    ])
})
