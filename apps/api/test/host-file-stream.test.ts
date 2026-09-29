import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
    readFileStream,
    writeFileStream
} from '../src/modules/agents/adapters/host-file-stream'

// Streamed file IO over a host session (DAEMON_FEATURE_FS_WRITE_STREAM, a
// chunked fs.read): the edges the files and backup callers lean on.

const session = (opts: { chunkMaxBytes?: number } = {}) => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
    let cancelled = 0
    let settle: () => void = () => {}
    let fail: (err: Error) => void = () => {}
    return {
        calls,
        cancelled: () => cancelled,
        settle: () => settle(),
        session: {
            rpc: async (call: { method: string; payload: Record<string, unknown> }) => {
                calls.push(call)
                return call.method === 'fs.write.begin'
                    ? { uploadId: 'upl-1', chunkMaxBytes: opts.chunkMaxBytes ?? 4 }
                    : {}
            },
            // One chunk arrives at once; the read ends when the test says so,
            // or fails when it is cancelled, as the registry's does.
            stream: (call: { onEvent: (kind: string, data: string) => void }) => {
                call.onEvent('fs.chunk', Buffer.from('ab').toString('base64'))
                const result = new Promise<Record<string, unknown>>((resolve, reject) => {
                    settle = () => resolve({})
                    fail = reject
                })
                return {
                    refId: 'ref-1',
                    result,
                    cancel: () => {
                        cancelled += 1
                        fail(new Error('cancelled'))
                    }
                }
            }
        } as never
    }
}

async function* pieces(...parts: Buffer[]): AsyncIterable<Uint8Array> {
    for (const part of parts) yield part
}

// An empty file is a commit with nothing before it: size 0, and the digest of
// no bytes.
test('an empty body commits without a chunk', async () => {
    const s = session()
    await writeFileStream(s.session, { path: '/w/empty', body: pieces() })
    assert.deepEqual(
        s.calls.map((c) => c.method),
        ['fs.write.begin', 'fs.write.commit']
    )
    assert.equal(s.calls[1].payload.size, 0)
    assert.equal(
        s.calls[1].payload.sha256,
        createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    )
})

// Pieces of any size are cut to the daemon's chunk limit, in order.
test('a body is cut to the daemon\'s chunk limit whatever the pieces it arrives in', async () => {
    const s = session({ chunkMaxBytes: 4 })
    await writeFileStream(s.session, {
        path: '/w/x',
        body: pieces(Buffer.from('abc'), Buffer.from('defgh'))
    })
    const chunks = s.calls.filter((c) => c.method === 'fs.write.chunk')
    assert.deepEqual(
        chunks.map((c) => Buffer.from(String(c.payload.data), 'base64').toString()),
        ['abcd', 'efgh']
    )
    assert.deepEqual(chunks.map((c) => c.payload.seq), [0, 1])
})

// A download the consumer walks away from stops the read, and the hold taken
// for it goes with it rather than at the read's deadline.
test('a read the consumer abandons is cancelled and lets go of its hold', async () => {
    const s = session()
    let released = 0
    const { stream, done } = readFileStream(s.session, {
        path: '/w/x',
        release: () => {
            released += 1
        }
    })
    for await (const chunk of stream) {
        assert.equal(chunk.toString(), 'ab')
        break
    }
    await done.catch(() => undefined)
    assert.equal(s.cancelled(), 1)
    assert.equal(released, 1)
})

test('a read that ends normally lets go of its hold once', async () => {
    const s = session()
    let released = 0
    const { stream, done } = readFileStream(s.session, {
        path: '/w/x',
        release: () => {
            released += 1
        }
    })
    s.settle()
    const parts: Buffer[] = []
    for await (const chunk of stream) parts.push(chunk)
    await done
    assert.equal(Buffer.concat(parts).toString(), 'ab')
    assert.equal(released, 1)
})
