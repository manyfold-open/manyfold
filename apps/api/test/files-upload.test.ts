import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { PayloadTooLargeException } from '@nestjs/common'
import {
    boundedChunks,
    collectBounded,
    isStreamBody
} from '../src/modules/agents/files/files-upload'

const bound = (maxBytes?: number) => ({
    maxBytes,
    rootId: 'workspace',
    transport: 'sprites'
})

const drain = async (chunks: AsyncIterable<Buffer>): Promise<Buffer> => {
    const parts: Buffer[] = []
    for await (const chunk of chunks) parts.push(chunk)
    return Buffer.concat(parts)
}

test('isStreamBody separates request streams from in-memory bodies', () => {
    assert.equal(isStreamBody(Buffer.from('abc')), false)
    assert.equal(isStreamBody(Readable.from([Buffer.from('abc')])), true)
})

test('boundedChunks passes a stream through unchanged', async () => {
    const body = Readable.from([Buffer.from('hello '), Buffer.from('world')])
    assert.deepEqual(
        await drain(boundedChunks(body, bound(1024))),
        Buffer.from('hello world')
    )
})

// the request stream is the only source of truth for size; a client that
// under-declares Content-Length must not get more bytes through than the
// transport allows
test('boundedChunks fails mid-stream once the bound is exceeded', async () => {
    const body = Readable.from([Buffer.alloc(4), Buffer.alloc(4)])
    await assert.rejects(
        () => drain(boundedChunks(body, bound(6))),
        (err: unknown) =>
            err instanceof PayloadTooLargeException &&
            err.message.includes('after 8 bytes')
    )
})

test('boundedChunks converts Uint8Array chunks to Buffers', async () => {
    const body = Readable.from([new Uint8Array([1, 2]), new Uint8Array([3])])
    const out = await drain(boundedChunks(body, bound()))
    assert.ok(Buffer.isBuffer(out))
    assert.deepEqual(out, Buffer.from([1, 2, 3]))
})

test('boundedChunks yields an in-memory body as a single chunk', async () => {
    const chunks: Buffer[] = []
    for await (const chunk of boundedChunks(Buffer.from('abc'), bound()))
        chunks.push(chunk)
    assert.equal(chunks.length, 1)
})

test('boundedChunks rejects an over-limit in-memory body without yielding', async () => {
    await assert.rejects(
        () => drain(boundedChunks(Buffer.alloc(10), bound(4))),
        (err: unknown) => err instanceof PayloadTooLargeException
    )
})

test('collectBounded assembles a stream for buffering transports', async () => {
    const body = Readable.from([Buffer.from('ab'), Buffer.from('cd')])
    assert.deepEqual(await collectBounded(body, bound()), Buffer.from('abcd'))
})

// pod-exec and daemon writes have to hold the whole body, so their cap is what
// keeps a large upload from being assembled in memory at all
test('collectBounded stops assembling once the cap is passed', async () => {
    const body = Readable.from([Buffer.alloc(3), Buffer.alloc(3)])
    await assert.rejects(
        () => collectBounded(body, bound(4)),
        (err: unknown) => err instanceof PayloadTooLargeException
    )
})

test('collectBounded returns an empty buffer for an empty stream', async () => {
    assert.equal(
        (await collectBounded(Readable.from([]), bound())).byteLength,
        0
    )
})
