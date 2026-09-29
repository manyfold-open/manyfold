import type { ChatStreamEvent } from '@manyfold/shared'

// A session's chat stream as the API sends it, for fake-api routes and
// test servers.

export type StreamEvent = Record<string, unknown> & {
    type: ChatStreamEvent['type']
    eventId: string
}

// One event; `eventId` also orders it. Events belong to the turn msg_a of
// session cts_1 unless said otherwise.
export const chatEvent = (
    type: ChatStreamEvent['type'],
    eventId: number,
    fields: Record<string, unknown> = {}
): StreamEvent => ({
    type,
    eventId: String(eventId),
    messageId: 'msg_a',
    sessionId: 'cts_1',
    seq: eventId,
    createdAt: '2026-09-30T00:00:00.000Z',
    ...fields
})

export const sseFrame = (event: StreamEvent): string =>
    `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

// The events after a keepalive, then the end of the stream.
export const sse = (events: readonly StreamEvent[]): Response => {
    const encoder = new TextEncoder()
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(': keepalive 1\n\n'))
                for (const event of events)
                    controller.enqueue(encoder.encode(sseFrame(event)))
                controller.close()
            }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
}
