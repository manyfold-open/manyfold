import type { ChatStreamEvent } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatController } from '../src/modules/chat/chat.controller'
import {
    SSE_MAX_BUFFERED_BYTES,
    type BroadcastSubscriber
} from '../src/modules/chat/sse-broadcaster'

// The SSE socket runs with setNoDelay(true), so a write per line can leave as
// its own syscall and its own TCP segment. These pin both halves of writing
// the frame once: the write count, and the exact bytes that reach the client.

interface StreamHarness {
    send: (event: ChatStreamEvent) => void
    writes: string[]
    setBuffered: (bytes: number) => void
    ended: () => boolean
    close: () => void
}

const openStream = async (): Promise<StreamHarness> => {
    const writes: string[] = []
    const closeHandlers: Array<() => void> = []
    const captured: BroadcastSubscriber[] = []
    let buffered = 0
    let ended = false

    const raw = {
        socket: { setNoDelay: (): void => undefined },
        destroyed: false,
        get writableLength(): number {
            return buffered
        },
        writeHead: (): void => undefined,
        write: (chunk: string): boolean => {
            writes.push(chunk)
            return true
        },
        end: (): void => {
            ended = true
        }
    }
    const req = {
        headers: {},
        raw: {
            destroyed: false,
            on: (event: string, handler: () => void): void => {
                if (event === 'close') closeHandlers.push(handler)
            }
        }
    }
    const controller = new ChatController(
        { subscribeStream: async () => ({ id: 'session-1' }) } as never,
        {
            subscribe: async (
                _sessionId: string,
                subscriber: BroadcastSubscriber
            ): Promise<() => void> => {
                captured.push(subscriber)
                return () => undefined
            }
        } as never
    )
    await controller.stream(
        { userId: 'user-1' } as never,
        'agent-1',
        'session-1',
        undefined,
        undefined,
        req as never,
        { hijack: (): void => undefined, raw } as never
    )

    const subscriber = captured[0]
    if (!subscriber) throw new Error('stream never subscribed')
    // The handshake writes nothing itself; only events are counted.
    writes.length = 0
    return {
        send: subscriber.send,
        writes,
        setBuffered: (bytes: number): void => {
            buffered = bytes
        },
        ended: (): boolean => ended,
        close: (): void => {
            for (const handler of closeHandlers) handler()
        }
    }
}

const tokenEvent = (eventId: string, text: string): ChatStreamEvent => ({
    eventId,
    messageId: 'msg-1',
    sessionId: 'session-1',
    seq: Number(eventId),
    createdAt: '2026-08-09T00:00:00.000Z',
    type: 'token',
    text
})

test('one event is one socket write, byte-for-byte', async (t) => {
    const stream = await openStream()
    // The live keepalive interval outlives a failed assertion otherwise, and
    // node:test waits for the event loop before it reports anything.
    t.after(stream.close)
    const event = tokenEvent('100', 'hello')

    stream.send(event)

    assert.equal(stream.writes.length, 1)
    assert.equal(
        stream.writes[0],
        `id: 100\nevent: token\ndata: ${JSON.stringify(event)}\n\n`
    )
})

test('each further event adds exactly one more write', async (t) => {
    const stream = await openStream()
    t.after(stream.close)

    stream.send(tokenEvent('100', 'a'))
    stream.send(tokenEvent('101', 'b'))
    stream.send(tokenEvent('102', 'c'))

    assert.equal(stream.writes.length, 3)
    assert.deepEqual(
        stream.writes.map((frame) => frame.split('\n')[0]),
        ['id: 100', 'id: 101', 'id: 102']
    )
})

test('a client past the buffered-bytes cap is still cut off', async (t) => {
    const stream = await openStream()
    t.after(stream.close)
    stream.setBuffered(SSE_MAX_BUFFERED_BYTES + 1)

    assert.throws(
        () => stream.send(tokenEvent('100', 'hello')),
        /sse client too slow/
    )
    assert.equal(stream.writes.length, 0, 'nothing is written past the cap')
    assert.equal(stream.ended(), true)
})
