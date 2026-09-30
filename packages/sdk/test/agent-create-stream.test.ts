import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '../src/client'

const encoder = new TextEncoder()
const line = (event: object): Uint8Array =>
    encoder.encode(JSON.stringify(event) + '\n')
const step = line({
    type: 'step',
    step: 'creating_sprite',
    index: 3,
    total: 11,
    startedAt: ''
})
const complete = line({
    type: 'complete',
    agent: { id: 'agt_1', name: 'x' }
})

// A stream that sends one step, then nothing until `closeAfterMs` (or ever).
const quietStream = (closeAfterMs?: number): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start(controller) {
            controller.enqueue(step)
            if (closeAfterMs !== undefined)
                setTimeout(() => {
                    controller.enqueue(complete)
                    controller.close()
                }, closeAfterMs)
        }
    })

const clientFor = (
    body: () => ReadableStream<Uint8Array>,
    requestId: string | null,
    sent: Headers[] = []
) =>
    createClient({
        baseUrl: 'http://api.test/api',
        token: 'tok',
        fetch: async (_url, init) => {
            sent.push(new Headers(init?.headers))
            return new Response(body(), {
                status: 201,
                headers: {
                    'content-type': 'application/x-ndjson',
                    ...(requestId
                        ? { 'x-agent-create-request': requestId }
                        : {})
                }
            })
        }
    })

test('a create reports the request the API named, and a resume sends it back', async () => {
    const sent: Headers[] = []
    const client = clientFor(() => quietStream(0), 'acq_1', sent)
    const accepted: Array<string | null> = []
    const agent = await client.agents.createStream(
        { name: 'x', framework: 'codex' },
        () => undefined,
        { onAccepted: (id) => accepted.push(id), resume: 'acq_0' }
    )
    assert.equal(agent.id, 'agt_1')
    assert.deepEqual(accepted, ['acq_1'])
    assert.equal(sent[0].get('x-agent-create-request'), 'acq_0')

    const fromOlder: Array<string | null> = []
    const older = clientFor(() => quietStream(0), null)
    await older.agents.createStream(
        { name: 'x', framework: 'codex' },
        () => undefined,
        { onAccepted: (id) => fromOlder.push(id) }
    )
    assert.deepEqual(fromOlder, [null])
})

test('a stream that goes quiet is abandoned, but only where the API sends keepalives', async () => {
    const events: string[] = []
    await assert.rejects(
        clientFor(() => quietStream(), 'acq_1').agents.createStream(
            { name: 'x', framework: 'codex' },
            (event) => events.push(event.type),
            { idleTimeoutMs: 50 }
        ),
        /sent nothing for 0 s/
    )
    assert.deepEqual(events, ['step'])

    // An API that names no request sends no keepalives either: a long step
    // is silence there, not a dead stream.
    const agent = await clientFor(
        () => quietStream(150),
        null
    ).agents.createStream({ name: 'x', framework: 'codex' }, () => undefined, {
        idleTimeoutMs: 50
    })
    assert.equal(agent.id, 'agt_1')
})
