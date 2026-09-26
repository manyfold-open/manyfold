import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { A2aClient, parseJsonRpcResult } from '../src/client'
import { A2aError, A2aTransportError } from '../src/errors'

for (const [status, body, message] of [
    [401, { error: 'missing bearer token' }, 'missing bearer token'],
    [
        403,
        { error: { code: 'forbidden', message: 'grant revoked' } },
        'grant revoked'
    ],
    [429, { message: 'quota reached' }, 'quota reached'],
    [503, 'temporarily unavailable', 'temporarily unavailable']
] as const) {
    test(`HTTP ${status} preserves status and detail for RPC and SSE`, async () => {
        const server = createServer((req, res) => {
            req.resume()
            req.on('end', () => {
                res.writeHead(status, {
                    'content-type': 'application/json',
                    'retry-after': '7'
                })
                res.end(typeof body === 'string' ? body : JSON.stringify(body))
            })
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        const client = new A2aClient({
            endpointUrl: `http://127.0.0.1:${address.port}/rpc`,
            allowPrivate: true
        })
        const isExpected = (error: unknown) =>
            error instanceof A2aTransportError &&
            error.status === status &&
            error.retryAfter === '7' &&
            error.message.includes(message)
        try {
            await assert.rejects(client.getTask({ id: 't' }), isExpected)
            await assert.rejects(async () => {
                for await (const _event of client.resubscribe(
                    { id: 't' },
                    new AbortController().signal
                ))
                    assert.fail('must not yield an event on an HTTP error')
            }, isExpected)
        } finally {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    })
}

test('malformed JSON-RPC errors cannot manufacture an undefined code', () => {
    for (const body of ['null', '{"error":"missing bearer"}', '{"error":{}}'])
        assert.throws(
            () => parseJsonRpcResult(body),
            (error: unknown) =>
                error instanceof A2aError &&
                Number.isFinite(error.code) &&
                !error.message.includes('undefined')
        )
    assert.throws(
        () =>
            parseJsonRpcResult(
                '{"jsonrpc":"2.0","error":{"code":-32001,"message":"missing"}}'
            ),
        (error: unknown) => error instanceof A2aError && error.code === -32001
    )
})
