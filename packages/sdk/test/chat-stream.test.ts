import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatStreamEvent } from '@manyfold/shared'
import { ApiError } from '../src/errors'
import { createClient } from '../src/client'

const encoder = new TextEncoder()

const frame = (event: Record<string, unknown>): string =>
    `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

const token = (eventId: string, text: string) => ({
    type: 'token',
    eventId,
    messageId: 'msg_a',
    sessionId: 'cts_1',
    seq: Number(eventId),
    createdAt: '2026-09-29T00:00:00.000Z',
    text
})

interface Sent {
    url: URL
    headers: Headers
}

// Serves `chunks` as the body; `hold` keeps it open after them.
const clientFor = (
    chunks: string[],
    sent: Sent[],
    options: { hold?: boolean; onCancel?: () => void; status?: number } = {}
) =>
    createClient({
        baseUrl: 'http://api.test/api',
        token: 'tok',
        fetch: async (url, init) => {
            sent.push({
                url: new URL(String(url)),
                headers: new Headers(init?.headers)
            })
            if (options.status)
                return new Response(
                    JSON.stringify({
                        error: { code: 'not_found', message: 'no session' }
                    }),
                    {
                        status: options.status,
                        headers: { 'content-type': 'application/json' }
                    }
                )
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (const chunk of chunks)
                            controller.enqueue(encoder.encode(chunk))
                        if (!options.hold) controller.close()
                    },
                    cancel() {
                        options.onCancel?.()
                    }
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' }
                }
            )
        }
    })

const collect = async (
    events: AsyncIterable<ChatStreamEvent>
): Promise<ChatStreamEvent[]> => {
    const out: ChatStreamEvent[] = []
    for await (const event of events) out.push(event)
    return out
}

test('a session stream yields its events in order and skips the keepalives', async () => {
    const sent: Sent[] = []
    const body = `: trace abc\n\n${frame(token('1', 'Hel'))}: keepalive 1\n\n${frame(token('2', 'lo'))}`
    // Split mid-frame, and with CRLF line ends, as a proxy may send them.
    const chunks = [body.slice(0, 40), body.slice(40).replace(/\n/g, '\r\n')]
    const events = await collect(
        clientFor(chunks, sent).chat.streamSession('agt_1', 'cts_1', {
            replayMessageId: 'msg_a'
        })
    )
    assert.deepEqual(
        events.map((event) => [event.eventId, event.type]),
        [
            ['1', 'token'],
            ['2', 'token']
        ]
    )
    assert.equal(
        sent[0].url.pathname,
        '/api/agents/agt_1/sessions/cts_1/stream'
    )
    assert.equal(sent[0].url.searchParams.get('replayMessageId'), 'msg_a')
    assert.equal(sent[0].headers.get('accept'), 'text/event-stream')
    assert.equal(sent[0].headers.get('authorization'), 'Bearer tok')
})

test('a reconnect sends the last event id, in the query and as Last-Event-ID', async () => {
    const sent: Sent[] = []
    await collect(
        clientFor([], sent).chat.streamSession('agt_1', 'cts_1', {
            replayMessageId: 'msg_a',
            lastEventId: '41'
        })
    )
    assert.equal(sent[0].url.searchParams.get('lastEventId'), '41')
    assert.equal(sent[0].url.searchParams.get('replayMessageId'), null)
    assert.equal(sent[0].headers.get('last-event-id'), '41')
})

test('a refused stream throws the API error', async () => {
    await assert.rejects(
        collect(
            clientFor([], [], { status: 404 }).chat.streamSession(
                'agt_1',
                'cts_x'
            )
        ),
        (err: unknown) => err instanceof ApiError && err.status === 404
    )
})

test('a stream that goes quiet rejects after the idle timeout', async () => {
    await assert.rejects(
        collect(
            clientFor([frame(token('1', 'x'))], [], {
                hold: true
            }).chat.streamSession('agt_1', 'cts_1', { idleTimeoutMs: 50 })
        ),
        /the chat stream sent nothing/
    )
})

test('leaving the loop early closes the connection', async () => {
    let cancelled = false
    const stream = clientFor([frame(token('1', 'x'))], [], {
        hold: true,
        onCancel: () => {
            cancelled = true
        }
    }).chat.streamSession('agt_1', 'cts_1')
    for await (const event of stream) {
        assert.equal(event.type, 'token')
        break
    }
    assert.equal(cancelled, true)
})
