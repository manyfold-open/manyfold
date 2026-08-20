import assert from 'node:assert/strict'
import test from 'node:test'
import {
    MockAgent,
    getGlobalDispatcher,
    setGlobalDispatcher,
    type Dispatcher
} from 'undici'
import {
    FileSourceError,
    resolveFileInput
} from '../src/modules/openai-compat/openai-file-source'

const MAX = 25 * 1024 * 1024
const PUBLIC_IP = 'http://93.184.216.34'

test('decodes a base64 data URL', async () => {
    const b64 = Buffer.from('hello').toString('base64')
    const r = await resolveFileInput(
        { kind: 'data', value: `data:image/png;base64,${b64}`, filename: 'x.png' },
        MAX
    )
    assert.equal(r.contentType, 'image/png')
    assert.equal(r.bytes.toString(), 'hello')
    assert.equal(r.name, 'x.png')
})

test('derives an extension for an extensionless data URL from its content type', async () => {
    // image_url parts carry no filename, so the name defaults to "upload".
    // Without an extension Claude Code's Read tool reads the file as raw bytes
    // instead of rendering the image, so we must append one from the mime type.
    const b64 = Buffer.from('png').toString('base64')
    const r = await resolveFileInput(
        { kind: 'data', value: `data:image/png;base64,${b64}` },
        MAX
    )
    assert.equal(r.name, 'upload.png')
})

test('derives an extension when the provided filename lacks one', async () => {
    const b64 = Buffer.from('jpg').toString('base64')
    const r = await resolveFileInput(
        { kind: 'data', value: `data:image/jpeg;base64,${b64}`, filename: 'photo' },
        MAX
    )
    assert.equal(r.name, 'photo.jpg')
})

test('leaves an extensionless name alone for an unknown content type', async () => {
    const b64 = Buffer.from('bin').toString('base64')
    const r = await resolveFileInput(
        {
            kind: 'data',
            value: `data:application/octet-stream;base64,${b64}`
        },
        MAX
    )
    assert.equal(r.name, 'upload')
})

test('rejects a non-base64 data URL', async () => {
    await assert.rejects(
        () => resolveFileInput({ kind: 'data', value: 'data:text/plain,hi' }, MAX),
        FileSourceError
    )
})

test('rejects an oversized base64 data URL', async () => {
    const b64 = Buffer.alloc(100).toString('base64')
    await assert.rejects(
        () =>
            resolveFileInput(
                { kind: 'data', value: `data:application/octet-stream;base64,${b64}` },
                10
            ),
        FileSourceError
    )
})

test('rejects a loopback URL even with the provider env bypass set', async () => {
    const KEY = 'MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS'
    const prev = process.env[KEY]
    process.env[KEY] = '1'
    try {
        await assert.rejects(
            () =>
                resolveFileInput(
                    { kind: 'url', value: 'http://127.0.0.1/secret' },
                    MAX
                ),
            FileSourceError
        )
    } finally {
        if (prev === undefined) delete process.env[KEY]
        else process.env[KEY] = prev
    }
})

const withMock = async (
    setup: (pool: ReturnType<MockAgent['get']>) => void,
    run: () => Promise<void>
): Promise<void> => {
    const previous: Dispatcher = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    try {
        setup(agent.get(PUBLIC_IP))
        await run()
    } finally {
        setGlobalDispatcher(previous)
    }
}

test('fetches a public-IP URL within the cap', async () => {
    await withMock(
        (pool) =>
            pool.intercept({ path: '/file.png', method: 'GET' }).reply(
                200,
                Buffer.from('imgbytes'),
                { headers: { 'content-type': 'image/png' } }
            ),
        async () => {
            const r = await resolveFileInput(
                { kind: 'url', value: `${PUBLIC_IP}/file.png` },
                MAX
            )
            assert.equal(r.bytes.toString(), 'imgbytes')
            assert.equal(r.contentType, 'image/png')
            assert.equal(r.name, 'file.png')
        }
    )
})

test('derives an extension when the URL path segment has none', async () => {
    // Mirrors placehold.co/700x220/png — the last path segment is "png" with
    // no dot, so nameFromUrl yields an extensionless "png"; the response
    // content type is the only signal that it is actually an image.
    await withMock(
        (pool) =>
            pool
                .intercept({ path: '/700x220/png', method: 'GET' })
                .reply(200, Buffer.from('imgbytes'), {
                    headers: { 'content-type': 'image/png' }
                }),
        async () => {
            const r = await resolveFileInput(
                { kind: 'url', value: `${PUBLIC_IP}/700x220/png` },
                MAX
            )
            assert.equal(r.name, 'png.png')
        }
    )
})

test('caps an oversized fetched body', async () => {
    await withMock(
        (pool) =>
            pool
                .intercept({ path: '/big.png', method: 'GET' })
                .reply(200, Buffer.alloc(100)),
        async () => {
            await assert.rejects(
                () =>
                    resolveFileInput(
                        { kind: 'url', value: `${PUBLIC_IP}/big.png` },
                        10
                    ),
                FileSourceError
            )
        }
    )
})

test('rejects a non-2xx file URL', async () => {
    await withMock(
        (pool) =>
            pool
                .intercept({ path: '/missing.png', method: 'GET' })
                .reply(404, 'nope'),
        async () => {
            await assert.rejects(
                () =>
                    resolveFileInput(
                        { kind: 'url', value: `${PUBLIC_IP}/missing.png` },
                        MAX
                    ),
                FileSourceError
            )
        }
    )
})
