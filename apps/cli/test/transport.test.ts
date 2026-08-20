import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createCliClient,
    createCliFetch,
    DEFAULT_HTTP_TIMEOUT_MS,
    normalizeClientOs,
    resolveHttpTimeoutMs
} from '../src/transport'

interface CapturedCall {
    headers: Headers
    signal: AbortSignal | null | undefined
}

const capturingFetch = (): {
    calls: CapturedCall[]
    fetchImpl: typeof fetch
} => {
    const calls: CapturedCall[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
        calls.push({
            headers: new Headers(init?.headers),
            signal: init?.signal
        })
        return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    }
    return { calls, fetchImpl }
}

test('resolveHttpTimeoutMs defaults invalid values and parses seconds or duration suffixes', () => {
    assert.equal(resolveHttpTimeoutMs(''), DEFAULT_HTTP_TIMEOUT_MS)
    assert.equal(resolveHttpTimeoutMs('invalid'), DEFAULT_HTTP_TIMEOUT_MS)
    assert.equal(resolveHttpTimeoutMs('0'), DEFAULT_HTTP_TIMEOUT_MS)
    assert.equal(resolveHttpTimeoutMs('-1s'), DEFAULT_HTTP_TIMEOUT_MS)
    assert.equal(resolveHttpTimeoutMs('45'), 45_000)
    assert.equal(resolveHttpTimeoutMs('1500ms'), 1_500)
    assert.equal(resolveHttpTimeoutMs('1.5s'), 1_500)
    assert.equal(resolveHttpTimeoutMs('2m'), 120_000)
    assert.equal(resolveHttpTimeoutMs('1h'), 3_600_000)
})

test('resolveHttpTimeoutMs reads MF_HTTP_TIMEOUT when no value is passed', () => {
    const previous = process.env.MF_HTTP_TIMEOUT
    process.env.MF_HTTP_TIMEOUT = '250ms'
    try {
        assert.equal(resolveHttpTimeoutMs(), 250)
    } finally {
        if (previous === undefined) delete process.env.MF_HTTP_TIMEOUT
        else process.env.MF_HTTP_TIMEOUT = previous
    }
})

test('normalizeClientOs uses the shared client metadata vocabulary', () => {
    assert.equal(normalizeClientOs('darwin'), 'macos')
    assert.equal(normalizeClientOs('win32'), 'windows')
    assert.equal(normalizeClientOs('linux'), 'linux')
    assert.equal(normalizeClientOs('freebsd'), 'freebsd')
})

test('createCliFetch adds identity headers and a default ordinary-request signal', async () => {
    const { calls, fetchImpl } = capturingFetch()
    const cliFetch = createCliFetch({
        fetchImpl,
        timeoutMs: 1_000,
        version: '9.9.9-test',
        platform: 'darwin'
    })

    await cliFetch('https://api.test/me', {
        headers: { 'x-existing': 'kept' }
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get('x-existing'), 'kept')
    assert.equal(calls[0].headers.get('x-client-platform'), 'cli')
    assert.equal(calls[0].headers.get('x-client-version'), '9.9.9-test')
    assert.equal(calls[0].headers.get('x-client-os'), 'macos')
    assert.ok(calls[0].signal)
})

test('createCliClient routes SDK requests through the CLI transport', async () => {
    const { calls, fetchImpl } = capturingFetch()
    const client = createCliClient({
        baseUrl: 'https://api.test',
        fetch: fetchImpl
    })

    await client.auth.me()

    assert.equal(calls.length, 1)
    assert.equal(calls[0].headers.get('x-client-platform'), 'cli')
    assert.ok(calls[0].signal)
})

test('createCliFetch ordinary-request timeout aborts a pending fetch', async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
                'abort',
                () => reject(init.signal?.reason),
                { once: true }
            )
        })
    const cliFetch = createCliFetch({ fetchImpl, timeoutMs: 10 })
    const keepEventLoopAlive = setTimeout(() => {}, 100)

    try {
        await assert.rejects(
            () => cliFetch('https://api.test/slow'),
            (error: unknown) =>
                error instanceof DOMException && error.name === 'TimeoutError'
        )
    } finally {
        clearTimeout(keepEventLoopAlive)
    }
})

test('createCliFetch preserves an explicit caller signal unchanged', async () => {
    const { calls, fetchImpl } = capturingFetch()
    const controller = new AbortController()
    const cliFetch = createCliFetch({ fetchImpl, timeoutMs: 10 })

    await cliFetch('https://api.test/me', { signal: controller.signal })

    assert.equal(calls[0].signal, controller.signal)
})

test('createCliFetch skips default timeouts for SSE and NDJSON streams', async () => {
    for (const accept of ['text/event-stream', 'application/x-ndjson']) {
        const { calls, fetchImpl } = capturingFetch()
        const cliFetch = createCliFetch({ fetchImpl, timeoutMs: 10 })

        await cliFetch('https://api.test/stream', {
            headers: { accept }
        })

        assert.equal(calls[0].signal, undefined, accept)
    }
})

// the signal bounds the whole request, not just the connect, so a 30s cap
// aborted every download that took longer than 30s to transfer
test('createCliFetch skips default timeouts for file downloads', async () => {
    const { calls, fetchImpl } = capturingFetch()
    const cliFetch = createCliFetch({ fetchImpl, timeoutMs: 10 })

    await cliFetch('https://api.test/agents/agent-1/files/read?path=big.bin', {
        headers: { accept: 'application/octet-stream' }
    })

    assert.equal(calls[0].signal, undefined)
})

test('files.read announces a byte stream so the CLI transport exempts it', async () => {
    const { calls, fetchImpl } = capturingFetch()
    const client = createCliClient({
        baseUrl: 'https://api.test',
        fetch: fetchImpl
    })

    await client.files.read('agent-1', 'big.bin')

    assert.equal(calls[0].headers.get('accept'), 'application/octet-stream')
    assert.equal(calls[0].signal, undefined)
})

test('createCliFetch skips default timeouts for binary uploads', async () => {
    const uploads: Array<{ body: BodyInit; headers?: HeadersInit }> = [
        {
            body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
            headers: { 'content-type': 'application/octet-stream' }
        },
        { body: new Blob(['archive']) },
        { body: new FormData() }
    ]

    for (const upload of uploads) {
        const { calls, fetchImpl } = capturingFetch()
        const cliFetch = createCliFetch({ fetchImpl, timeoutMs: 10 })

        await cliFetch('https://api.test/upload', {
            method: 'POST',
            body: upload.body,
            headers: upload.headers
        })

        assert.equal(calls[0].signal, undefined)
    }
})
