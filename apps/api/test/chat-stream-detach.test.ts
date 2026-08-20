import assert from 'node:assert/strict'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import { ChatService } from '../src/modules/chat/chat.service'

// The adapter read loop must not wait on a non-terminal row. What the
// broadcaster tests cannot show is which of its two entry points the loop
// actually calls, and that is the whole production change: a loop that went
// back to emit() would still pass every ordering and cap test and quietly
// reinstate one commit of transport stall per tool event.
//
// The fake here makes the difference observable rather than fast: emit()
// for a non-terminal never settles, emitDetached() returns. So the count of
// events the adapter managed to yield IS the answer.

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

const TOOL_EVENTS = 20
const TOKEN_EVENTS = 10

const toolTurn = (): EmittedChatEvent[] => {
    const events: EmittedChatEvent[] = []
    for (let i = 0; i < TOKEN_EVENTS; i += 1)
        events.push({ type: 'token', text: `tok${i} ` })
    for (let i = 0; i < TOOL_EVENTS / 2; i += 1) {
        events.push({
            type: 'tool_call',
            toolCallId: `call-${i}`,
            toolName: 'Bash',
            args: { command: 'ls' }
        })
        events.push({
            type: 'tool_result',
            toolCallId: `call-${i}`,
            result: 'ok'
        })
    }
    return events
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const makeHarness = (): {
    service: ChatService
    yielded: () => number
    detached: () => string[]
    awaited: () => string[]
} => {
    const insertedMessages: Array<Record<string, unknown>> = []
    let yielded = 0
    const detached: string[] = []
    const awaited: string[] = []

    const db = {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => [agentRow] })
            })
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) })
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
        insertStreamEvent: async () => ({ id: BigInt(1) }),
        touchSession: async () => undefined,
        updateTitleIfEmpty: async () => undefined
    }
    const broadcaster = {
        setStreamFence: () => undefined,
        beginStream: () => undefined,
        endStream: () => undefined,
        emit: async (_messageId: string, event: { type: string }) => {
            awaited.push(event.type)
            // token/thinking are SUPPOSED to come here — the broadcaster
            // merges them and returns without touching the write chain, so
            // they settle. Anything on the non-buffered path awaited here is
            // the regression under test, and a terminal has to settle or the
            // turn can never end.
            if (
                event.type !== 'done' &&
                event.type !== 'error' &&
                event.type !== 'token' &&
                event.type !== 'thinking'
            )
                await new Promise<void>(() => undefined)
            return { persisted: true }
        },
        emitDetached: async (_messageId: string, event: { type: string }) => {
            detached.push(event.type)
            return true
        }
    }
    const events = toolTurn()
    const adapter = {
        sendMessage: async function* (
            ctx: ApiChatAdapterContext
        ): AsyncIterable<EmittedChatEvent> {
            for (const event of events) {
                yielded += 1
                yield event
            }
            yielded += 1
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

    return {
        service,
        yielded: () => yielded,
        detached: () => detached,
        awaited: () => awaited
    }
}

test('the adapter loop consumes tool events without waiting for their rows', async () => {
    const harness = makeHarness()

    await harness.service.sendMessage('user-1', 'agent-1', 'session-1', 'hi')
    // Bounded rather than awaited: the point of failure is a loop that never
    // gets past its first tool event, so the assertion has to be reachable.
    await sleep(300)

    assert.equal(
        harness.yielded(),
        TOKEN_EVENTS + TOOL_EVENTS + 1,
        'the loop must reach the terminal with every tool row still in flight'
    )
    assert.deepEqual(
        new Set(harness.detached()),
        new Set(['tool_call', 'tool_result']),
        'only the non-buffered event types are detached'
    )
    assert.equal(harness.detached().length, TOOL_EVENTS)
    // token/thinking must NOT be detached: emit() already returns without a
    // write for them, so routing them through emitDetached would only add a
    // promise per token to the highest-rate path in the system.
    assert.deepEqual(
        harness.awaited(),
        [...Array.from({ length: TOKEN_EVENTS }, () => 'token'), 'done'],
        'buffered events stay on emit(), and only the terminal is awaited'
    )
})
