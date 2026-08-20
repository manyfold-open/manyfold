import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import Fastify from 'fastify'
import { registerOctetStreamParser } from '../src/modules/agents/files/octet-stream-parser'

// Proves the Fastify contract the streaming write path depends on: an
// octet-stream body must reach the route as a readable stream, not a Buffer.
// Getting this wrong would break every upload at runtime while typechecking fine.
const withServer = async (
    run: (baseUrl: string, seen: () => unknown) => Promise<void>
): Promise<void> => {
    const app = Fastify({ logger: false })
    registerOctetStreamParser(app)
    let observed: unknown
    let chunkCount = 0
    let bytes = 0
    app.put('/upload', async (req) => {
        observed = req.body
        for await (const chunk of req.body as AsyncIterable<Buffer>) {
            chunkCount += 1
            bytes += chunk.byteLength
        }
        return { chunkCount, bytes }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
        await run(`http://127.0.0.1:${port}`, () => observed)
    } finally {
        await app.close()
    }
}

test('octet-stream bodies reach the route as a stream, in chunks', async () => {
    await withServer(async (baseUrl, seen) => {
        const payload = Buffer.alloc(512 * 1024, 9)
        const res = await fetch(`${baseUrl}/upload`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: payload
        })

        assert.equal(res.status, 200)
        const body = (await res.json()) as { chunkCount: number; bytes: number }
        assert.equal(body.bytes, payload.byteLength)
        assert.ok(
            body.chunkCount > 1,
            `body must arrive in pieces, saw ${body.chunkCount}`
        )
        assert.equal(seen() instanceof Readable, true)
        assert.equal(Buffer.isBuffer(seen()), false)
    })
})

test('an empty octet-stream body still reaches the route', async () => {
    await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/upload`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: new Uint8Array()
        })

        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), { chunkCount: 0, bytes: 0 })
    })
})
