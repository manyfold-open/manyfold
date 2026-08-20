import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'
import { spriteReadFile } from '../src/file-io'
import { SpritesError } from '../src/errors'
import type { SpritesClient } from '../src/client'

// Mirrors READ_CHUNK_BYTES in src/file-io.ts (dd block size / chunk boundary).
const CHUNK = 65_536

// A file the fake sprite exposes. statSize is what `stat -c %s` reports; the dd
// reads come from readBytes. Keeping the two independent models a writer that
// appended between the initial stat and the chunk reads — the turn-adoption
// race where a transcript is read while the agent is still writing it.
interface FakeFile {
    statSize: number
    readBytes?: Buffer
    contentType?: string
}

const frame = (kind: number, payload: Buffer): Buffer =>
    Buffer.concat([Buffer.from([kind]), payload])

// Answers the two exec shapes spriteReadFile issues over the WSS exec channel:
// `bash -c "stat ...; file ..."` for the size probe and `dd if=... skip=N` for
// each chunk. Records dd skips so a test can assert no retry storm occurred.
const startFileServer = async (
    file: FakeFile
): Promise<{
    port: number
    ddSkips: number[]
    close: () => Promise<void>
}> => {
    const ddSkips: number[] = []
    const readBytes = file.readBytes ?? Buffer.alloc(file.statSize)
    const wss = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
    wss.on('connection', (ws: WebSocket, req) => {
        ws.on('message', () => {})
        ws.on('error', () => {})
        const argv = new URL(req.url ?? '', 'http://h').searchParams.getAll(
            'cmd'
        )
        if (argv[0] === 'bash') {
            const body = `${file.statSize}\n${file.contentType ?? 'text/plain'}\n`
            ws.send(frame(0x01, Buffer.from(body, 'utf8')))
            ws.send(frame(0x03, Buffer.from([0])))
            return
        }
        if (argv[0] === 'dd') {
            const skipArg = argv.find((a) => a.startsWith('skip=')) ?? 'skip=0'
            const skip = Number.parseInt(skipArg.slice('skip='.length), 10)
            ddSkips.push(skip)
            const start = skip * CHUNK
            const chunk = readBytes.subarray(start, start + CHUNK)
            if (chunk.length > 0) ws.send(frame(0x01, chunk))
            ws.send(frame(0x03, Buffer.from([0])))
            return
        }
        ws.send(frame(0x03, Buffer.from([1])))
    })
    const address = wss.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
        port,
        ddSkips,
        close: () => new Promise<void>((resolve) => wss.close(() => resolve()))
    }
}

const fakeClient = (port: number): SpritesClient =>
    ({
        wsBaseUrl: `ws://127.0.0.1:${port}`,
        authHeaderForInternalUse: () => ({}),
        killExecSession: async () => {}
    }) as unknown as SpritesClient

const readAll = async (
    client: SpritesClient,
    absPath: string
): Promise<{ bytes: Buffer; size: number }> => {
    const handle = await spriteReadFile(client, 'sprite', absPath)
    assert.ok(handle, 'expected a read handle')
    // done rejects in lockstep with the stream; attach a sink so a failing read
    // surfaces through the for-await below, not as an unhandled rejection.
    handle.done.catch(() => {})
    const parts: Buffer[] = []
    for await (const chunk of handle.stream) parts.push(chunk)
    await handle.done
    return { bytes: Buffer.concat(parts), size: handle.size }
}

const ramp = (length: number, step = 1): Buffer => {
    const buf = Buffer.alloc(length)
    for (let i = 0; i < length; i++) buf[i] = (i * step) % 256
    return buf
}

test('trailing chunk that grew during the read yields exactly the stat size, no short-read throw', async () => {
    // stat sees 100 bytes; by read time the writer had appended to 150, so dd
    // returns 150 for the single (trailing) chunk — the observed staging shape
    // (readChunk short read <full block>/<stat remainder>).
    const readBytes = ramp(150)
    const server = await startFileServer({ statSize: 100, readBytes })
    try {
        const { bytes, size } = await readAll(
            fakeClient(server.port),
            '/f.jsonl'
        )
        assert.equal(size, 100)
        assert.equal(bytes.length, 100)
        assert.deepEqual(bytes, readBytes.subarray(0, 100))
        assert.deepEqual(server.ddSkips, [0]) // one read, no retry storm
    } finally {
        await server.close()
    }
})

test('a growing multi-chunk file reads the interior chunk whole and truncates the grown trailing chunk to the stat size', async () => {
    const statSize = CHUNK + 100 // 2 chunks: [0, CHUNK) full + [CHUNK, CHUNK+100)
    const readBytes = ramp(CHUNK + 400, 7) // writer appended 300 bytes past the boundary
    const server = await startFileServer({ statSize, readBytes })
    try {
        const { bytes, size } = await readAll(
            fakeClient(server.port),
            '/f.jsonl'
        )
        assert.equal(size, statSize)
        assert.equal(bytes.length, statSize)
        assert.deepEqual(bytes, readBytes.subarray(0, statSize))
        assert.deepEqual(server.ddSkips, [0, 1]) // each chunk read once
    } finally {
        await server.close()
    }
})

test('a stable multi-chunk file still reads exactly, unchanged', async () => {
    const statSize = CHUNK + 100
    const readBytes = ramp(statSize, 3)
    const server = await startFileServer({ statSize, readBytes })
    try {
        const { bytes, size } = await readAll(
            fakeClient(server.port),
            '/f.jsonl'
        )
        assert.equal(size, statSize)
        assert.deepEqual(bytes, readBytes)
        assert.deepEqual(server.ddSkips, [0, 1])
    } finally {
        await server.close()
    }
})

test('a genuine short read on an interior chunk still fails — shrink/corruption is not masked by the growth tolerance', async () => {
    // stat claims two chunks but dd can only return part of the FIRST (interior)
    // chunk: a real truncation, not append growth. The growth tolerance is
    // trailing-only and must not swallow this.
    const server = await startFileServer({
        statSize: CHUNK + 100,
        readBytes: Buffer.alloc(CHUNK - 50)
    })
    try {
        await assert.rejects(
            readAll(fakeClient(server.port), '/f.jsonl'),
            (err: unknown) => {
                assert.ok(err instanceof SpritesError)
                assert.match(err.message, /readChunk 0 short read 65486\/65536/)
                return true
            }
        )
    } finally {
        await server.close()
    }
})
