import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliClient } from '../src/transport'
import { downloadToFile, uploadFile } from '../src/commands/files/transfer'

interface Received {
    method: string
    url: string
    contentLength?: string
    bytes: Buffer
    // the largest single in-memory buffer the server ever held
    peakChunk: number
}

const startServer = async (
    handler: (
        received: Received,
        respond: (
            status: number,
            body?: Buffer,
            headers?: Record<string, string>
        ) => void
    ) => void
): Promise<{ server: Server; baseUrl: string; calls: Received[] }> => {
    const calls: Received[] = []
    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        let peakChunk = 0
        req.on('data', (chunk: Buffer) => {
            peakChunk = Math.max(peakChunk, chunk.byteLength)
            chunks.push(chunk)
        })
        req.on('end', () => {
            const received: Received = {
                method: req.method ?? 'GET',
                url: req.url ?? '',
                contentLength: req.headers['content-length'],
                bytes: Buffer.concat(chunks),
                peakChunk
            }
            calls.push(received)
            handler(received, (status, body, headers) => {
                res.writeHead(status, {
                    'content-type': 'application/octet-stream',
                    ...(body ? { 'content-length': String(body.length) } : {}),
                    ...headers
                })
                res.end(body)
            })
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return { server, baseUrl: `http://127.0.0.1:${port}`, calls }
}

const withServer = async (
    handler: Parameters<typeof startServer>[0],
    run: (baseUrl: string, calls: Received[]) => Promise<void>
): Promise<void> => {
    const { server, baseUrl, calls } = await startServer(handler)
    try {
        await run(baseUrl, calls)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

const clientFor = (baseUrl: string) =>
    createCliClient({ baseUrl: `${baseUrl}/api`, token: 'test-token' })

// the upload used to be read into memory in full before the request started;
// streaming it means the process never holds more than one chunk
test('uploadFile streams the file and declares its length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-upload-'))
    const localPath = join(dir, 'payload.bin')
    const payload = Buffer.alloc(3 * 1024 * 1024, 7)
    await writeFile(localPath, payload)

    await withServer(
        (_received, respond) => respond(200, Buffer.from('{"ok":true}')),
        async (baseUrl, calls) => {
            const result = await uploadFile(
                {
                    client: clientFor(baseUrl),
                    agentId: 'agent-1',
                    remotePath: 'payload.bin'
                },
                localPath
            )

            assert.equal(result.bytes, payload.byteLength)
            assert.equal(calls.length, 1)
            assert.equal(calls[0].method, 'PUT')
            assert.equal(
                calls[0].contentLength,
                String(payload.byteLength),
                'content-length must be declared so the server can reject early'
            )
            assert.deepEqual(calls[0].bytes, payload)
            assert.ok(
                calls[0].peakChunk < payload.byteLength,
                `body arrived in chunks (peak ${calls[0].peakChunk} of ${payload.byteLength})`
            )
        }
    )
})

test('uploadFile fails before connecting when the local file is missing', async () => {
    await withServer(
        (_received, respond) => respond(200),
        async (baseUrl, calls) => {
            await assert.rejects(
                () =>
                    uploadFile(
                        {
                            client: clientFor(baseUrl),
                            agentId: 'agent-1',
                            remotePath: 'x.bin'
                        },
                        join(tmpdir(), 'mf-missing-source.bin')
                    ),
                /no such local file/
            )
            assert.equal(calls.length, 0)
        }
    )
})

test('downloadToFile writes through a temp file and renames it into place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-download-'))
    const localPath = join(dir, 'out.bin')
    const payload = Buffer.alloc(256 * 1024, 3)

    await withServer(
        (_received, respond) => respond(200, payload),
        async (baseUrl) => {
            const result = await downloadToFile(
                {
                    client: clientFor(baseUrl),
                    agentId: 'agent-1',
                    remotePath: 'out.bin'
                },
                localPath
            )

            assert.equal(result.bytes, payload.byteLength)
            assert.deepEqual(await readFile(localPath), payload)
            assert.equal((await stat(localPath)).size, payload.byteLength)
            assert.equal(existsSync(`${localPath}.mf-part`), false)
        }
    )
})

// a download that dies mid-body must not overwrite what is already there, and
// must not leave its temp file behind
test('downloadToFile leaves the destination intact when the body is truncated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-truncate-'))
    const localPath = join(dir, 'keep.bin')
    await writeFile(localPath, Buffer.from('original contents'))

    await withServer(
        (_received, respond) =>
            // claims 1 KiB, sends 8 bytes
            respond(200, Buffer.alloc(8), { 'content-length': '1024' }),
        async (baseUrl) => {
            await assert.rejects(() =>
                downloadToFile(
                    {
                        client: clientFor(baseUrl),
                        agentId: 'agent-1',
                        remotePath: 'keep.bin'
                    },
                    localPath
                )
            )
            assert.equal(await readFile(localPath, 'utf8'), 'original contents')
            assert.equal(existsSync(`${localPath}.mf-part`), false)
        }
    )
})

test('downloadToFile surfaces a non-2xx response with its body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-error-'))
    const localPath = join(dir, 'never.bin')

    await withServer(
        (_received, respond) =>
            respond(413, Buffer.from('too big for this root'), {
                'content-type': 'text/plain'
            }),
        async (baseUrl) => {
            await assert.rejects(
                () =>
                    downloadToFile(
                        {
                            client: clientFor(baseUrl),
                            agentId: 'agent-1',
                            remotePath: 'never.bin'
                        },
                        localPath
                    ),
                /too big for this root/
            )
            assert.equal(existsSync(localPath), false)
            assert.equal(existsSync(`${localPath}.mf-part`), false)
        }
    )
})
