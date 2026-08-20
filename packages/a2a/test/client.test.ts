import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildJsonRpcRequest,
    parseJsonRpcResult
} from '../src/client'
import { parseSseStream } from '../src/sse'
import { A2aError } from '../src/errors'
import type {
    A2aStreamEvent,
    TaskArtifactUpdateEvent,
    TaskStatusUpdateEvent
} from '../src/types'

const toBody = (text: string): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(text)
    }
})

test('buildJsonRpcRequest emits a valid 2.0 envelope', () => {
    const req = buildJsonRpcRequest(
        'message/send',
        { message: { kind: 'message' } },
        'id-1'
    )
    assert.equal(req.jsonrpc, '2.0')
    assert.equal(req.method, 'message/send')
    assert.equal(req.id, 'id-1')
})

test('parseJsonRpcResult returns result, or throws typed A2aError', () => {
    const ok = parseJsonRpcResult<{ kind: string }>(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'task' } })
    )
    assert.equal(ok.kind, 'task')

    assert.throws(
        () =>
            parseJsonRpcResult(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    error: { code: -32001, message: 'no task' }
                })
            ),
        (e: unknown) => e instanceof A2aError && e.code === -32001
    )

    assert.throws(() => parseJsonRpcResult('not json'))
    assert.throws(() => parseJsonRpcResult(JSON.stringify({ jsonrpc: '2.0', id: 1 })))
})

test('SSE stream decodes status-update and artifact-update events in order', async () => {
    const frame = (result: unknown): string =>
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`
    const wire =
        frame({
            kind: 'status-update',
            taskId: 't1',
            contextId: 'c1',
            status: { state: 'working' },
            final: false
        }) +
        frame({
            kind: 'artifact-update',
            taskId: 't1',
            contextId: 'c1',
            artifact: {
                artifactId: 'a1',
                parts: [{ kind: 'text', text: 'hello' }]
            }
        }) +
        frame({
            kind: 'status-update',
            taskId: 't1',
            contextId: 'c1',
            status: { state: 'completed' },
            final: true
        })

    const events: A2aStreamEvent[] = []
    for await (const sse of parseSseStream(
        toBody(wire),
        new AbortController().signal
    )) {
        if (!sse.data) continue
        events.push(parseJsonRpcResult<A2aStreamEvent>(sse.data))
    }

    assert.equal(events.length, 3)
    assert.equal(events[0].kind, 'status-update')
    assert.equal(events[1].kind, 'artifact-update')
    assert.equal(
        (events[1] as TaskArtifactUpdateEvent).artifact.parts[0].kind,
        'text'
    )
    assert.equal((events[2] as TaskStatusUpdateEvent).final, true)
})

test('SSE stream surfaces a JSON-RPC error frame as A2aError', async () => {
    const wire = `data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32004, message: 'terminal task' }
    })}\n\n`
    await assert.rejects(async () => {
        for await (const sse of parseSseStream(
            toBody(wire),
            new AbortController().signal
        )) {
            if (!sse.data) continue
            parseJsonRpcResult<A2aStreamEvent>(sse.data)
        }
    }, (e: unknown) => e instanceof A2aError && e.code === -32004)
})
