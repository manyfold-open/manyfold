import test from 'node:test'
import assert from 'node:assert/strict'
import type { FastifyReply } from 'fastify'
import { streamFileToReply } from '../src/modules/agents/files/files-download'

interface FakeRaw {
    head?: { status: number; headers: Record<string, string> }
    written: Buffer[]
    ended: boolean
    destroyed: boolean
}

const fakeReply = (): { reply: FastifyReply; raw: FakeRaw } => {
    const raw: FakeRaw = { written: [], ended: false, destroyed: false }
    const rawStub = {
        writeHead: (status: number, headers: Record<string, string>) => {
            raw.head = { status, headers }
        },
        write: (buf: Buffer) => {
            raw.written.push(buf)
            return true
        },
        once: () => {},
        end: () => {
            raw.ended = true
        },
        destroy: () => {
            raw.destroyed = true
        }
    }
    const reply = {
        hijack: () => {},
        raw: rawStub,
        request: { headers: {} }
    }
    return { reply: reply as unknown as FastifyReply, raw }
}

const target = {
    agentId: 'agent-1',
    rootId: 'workspace',
    path: '/w/blob.bin',
    transport: 'daemon'
}

const streamOf = (...chunks: Buffer[]): AsyncIterable<Buffer> => ({
    [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk
    }
})

const sent = (raw: FakeRaw): Buffer => Buffer.concat(raw.written)

test('streamFileToReply declares the reported size and ends cleanly on a match', async () => {
    const { reply, raw } = fakeReply()
    const body = Buffer.from('hello world')

    await streamFileToReply(
        reply,
        {
            stream: streamOf(body.subarray(0, 5), body.subarray(5)),
            size: body.byteLength,
            contentType: 'text/plain'
        },
        target
    )

    assert.equal(raw.head?.status, 200)
    assert.equal(raw.head?.headers['content-length'], '11')
    assert.equal(raw.head?.headers['content-type'], 'text/plain')
    assert.deepEqual(sent(raw), body)
    assert.equal(raw.ended, true)
    assert.equal(raw.destroyed, false)
})

// the daemon adapter used to report size 0 while still streaming a real body,
// so the response claimed Content-Length: 0 and clients saw an empty file;
// a declared length that the body contradicts must fail, not look successful
test('streamFileToReply destroys the socket when the body contradicts the declared size', async () => {
    const { reply, raw } = fakeReply()

    await streamFileToReply(
        reply,
        {
            stream: streamOf(Buffer.from('0123456789')),
            size: 0,
            contentType: 'application/octet-stream'
        },
        target
    )

    assert.equal(raw.head?.headers['content-length'], '0')
    assert.equal(raw.ended, false)
    assert.equal(raw.destroyed, true)
})

// a short read is the truncation case: the 200 already went out, so ending
// cleanly would present a partial file as a complete download
test('streamFileToReply destroys the socket on a truncated body', async () => {
    const { reply, raw } = fakeReply()

    await streamFileToReply(
        reply,
        {
            stream: streamOf(Buffer.alloc(4)),
            size: 64,
            contentType: 'application/octet-stream'
        },
        target
    )

    assert.equal(raw.ended, false)
    assert.equal(raw.destroyed, true)
})

test('streamFileToReply destroys the socket when the upstream stream errors', async () => {
    const { reply, raw } = fakeReply()
    const failing: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('partial')
            throw new Error('sprite exec died')
        }
    }

    await streamFileToReply(
        reply,
        { stream: failing, size: 32, contentType: 'application/octet-stream' },
        target
    )

    assert.equal(raw.ended, false)
    assert.equal(raw.destroyed, true)
})

// the transfer itself can fail after the last chunk (the daemon reports the RPC
// outcome only in its final frame), which must not read as success
test('streamFileToReply destroys the socket when the transfer promise rejects', async () => {
    const { reply, raw } = fakeReply()
    const body = Buffer.from('abc')

    await streamFileToReply(
        reply,
        {
            stream: streamOf(body),
            size: body.byteLength,
            contentType: 'application/octet-stream',
            done: Promise.reject(new Error('daemon rpc failed'))
        },
        target
    )

    assert.equal(raw.ended, false)
    assert.equal(raw.destroyed, true)
})

// transports that cannot know the length up front (a gateway response without
// content-length) must fall back to chunked encoding rather than claim 0
test('streamFileToReply omits content-length when the size is unknown', async () => {
    const { reply, raw } = fakeReply()
    const body = Buffer.from('unknown length')

    await streamFileToReply(
        reply,
        { stream: streamOf(body), contentType: 'application/octet-stream' },
        target
    )

    assert.equal('content-length' in (raw.head?.headers ?? {}), false)
    assert.deepEqual(sent(raw), body)
    assert.equal(raw.ended, true)
    assert.equal(raw.destroyed, false)
})

test('streamFileToReply sends an empty body for a zero-byte file', async () => {
    const { reply, raw } = fakeReply()

    await streamFileToReply(
        reply,
        {
            stream: streamOf(),
            size: 0,
            contentType: 'application/octet-stream'
        },
        target
    )

    assert.equal(raw.head?.headers['content-length'], '0')
    assert.equal(raw.ended, true)
    assert.equal(raw.destroyed, false)
})
