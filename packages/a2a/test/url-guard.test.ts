import assert from 'node:assert/strict'
import test from 'node:test'
import type { LookupAllOptions } from 'node:dns'
import dns from 'node:dns/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { assertSafeUrl, guardedFetch } from '../src/url-guard'

test('blocks loopback, link-local metadata, and private ranges', async () => {
    await assert.rejects(() =>
        assertSafeUrl('http://127.0.0.1:8080/rpc', { allowHttp: true })
    )
    await assert.rejects(() =>
        assertSafeUrl('https://169.254.169.254/latest/meta-data')
    )
    await assert.rejects(() =>
        assertSafeUrl('http://[::1]:3000/rpc', { allowHttp: true })
    )
    await assert.rejects(() => assertSafeUrl('https://10.0.0.5/rpc'))
    await assert.rejects(() => assertSafeUrl('https://192.168.1.10/rpc'))
    await assert.rejects(() => assertSafeUrl('https://localhost/rpc'))
    await assert.rejects(() =>
        assertSafeUrl('https://metadata.google.internal/rpc')
    )
})

test('allows a public IP literal without DNS', async () => {
    assert.equal(await assertSafeUrl('https://8.8.8.8/rpc'), 'https://8.8.8.8/rpc')
})

test('IPv4-mapped IPv6 obeys the IPv4 private and reserved ranges', async () => {
    for (const address of [
        '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
        '::ffff:169.254.169.254', '::ffff:10.0.0.1', '::ffff:192.168.1.1',
        '::ffff:172.16.0.1', '::ffff:100.64.0.1', '::ffff:0.0.0.0',
        '::ffff:224.0.0.1', '::ffff:198.51.100.1'
    ])
        await assert.rejects(
            assertSafeUrl(`http://[${address}]/rpc`, { allowHttp: true }),
            /private or reserved/
        )
    assert.equal(await assertSafeUrl('https://[::ffff:8.8.8.8]/rpc'),
        'https://[::ffff:808:808]/rpc')
    assert.equal(await assertSafeUrl('http://[::ffff:127.0.0.1]/rpc', { allowPrivate: true }),
        'http://[::ffff:7f00:1]/rpc')
})

test('allowPrivate bypass enables local dev targets', async () => {
    assert.equal(
        await assertSafeUrl('http://127.0.0.1:8080/rpc', { allowPrivate: true }),
        'http://127.0.0.1:8080/rpc'
    )
})

test('rejects non-http(s), embedded credentials, and bare http', async () => {
    await assert.rejects(() => assertSafeUrl('ftp://example.com'))
    await assert.rejects(() => assertSafeUrl('https://user:pass@8.8.8.8/rpc'))
    await assert.rejects(() => assertSafeUrl('http://8.8.8.8/rpc'))
})

test('a second DNS answer cannot rebind a checked public host to loopback', async (t) => {
    let requests = 0
    const server = createServer((_req, res) => { requests++; res.end('private') })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const hostname = 'a2a-rebind.example'
    let resolutions = 0
    const originalLookup = dns.lookup
    t.mock.method(dns, 'lookup', async (host: string, options: LookupAllOptions) => {
        if (host !== hostname) return originalLookup(host, options)
        resolutions++
        return [{ address: resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]
    })
    try {
        await assert.rejects(guardedFetch(`http://${hostname}:${address.port}/rpc`, {
            signal: AbortSignal.timeout(2000)
        }, { allowHttp: true }), (err: unknown) =>
            /^A2A endpoint a2a-rebind\.example:\d+ could not be reached \(.*private or reserved/.test(
                (err as Error).message
            ))
        assert.equal(resolutions, 2)
        assert.equal(requests, 0)
    } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

test('the request deadline also bounds DNS validation', async (t) => {
    let resolve!: (value: Array<{ address: string; family: number }>) => void
    t.mock.method(dns, 'lookup', () => new Promise((done) => { resolve = done }))
    const controller = new AbortController()
    const pending = guardedFetch('https://waiting.example/rpc', { signal: controller.signal })
    controller.abort(new Error('deadline'))
    await assert.rejects(pending, /deadline/)
    resolve([{ address: '8.8.8.8', family: 4 }])
})

// The standalone mf runs on Bun, where the bundled undici never delivers a
// streamed body; there the guard hands Bun's own fetch the checked address.
const onBun = (t: { after: (fn: () => void) => void }): void => {
    Object.defineProperty(process.versions, 'bun', {
        value: '1.3.9',
        configurable: true
    })
    t.after(() => {
        delete (process.versions as Record<string, string | undefined>).bun
    })
}

const answers = (
    t: { mock: { method: typeof test.mock.method } },
    hostname: string,
    replies: Array<{ address: string; family: number }>
): { count: () => number } => {
    let resolutions = 0
    const originalLookup = dns.lookup
    t.mock.method(dns, 'lookup', async (host: string, options: LookupAllOptions) => {
        if (host !== hostname) return originalLookup(host, options)
        const reply = replies[Math.min(resolutions, replies.length - 1)]
        resolutions++
        return [reply]
    })
    return { count: () => resolutions }
}

const capturedFetch = (t: {
    mock: { method: typeof test.mock.method }
}): Array<{ url: string; init: RequestInit }> => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    t.mock.method(globalThis, 'fetch', async (url: URL | string, init: RequestInit) => {
        calls.push({ url: String(url), init })
        return new Response('ok')
    })
    return calls
}

test('on Bun the native fetch connects to the checked address under the original Host', async (t) => {
    onBun(t)
    answers(t, 'a2a-bun.example', [{ address: '8.8.8.8', family: 4 }])
    const calls = capturedFetch(t)

    await guardedFetch('https://a2a-bun.example:8443/rpc?x=1', {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: '{}'
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'https://8.8.8.8:8443/rpc?x=1')
    const headers = calls[0]?.init.headers as Record<string, string>
    assert.equal(headers.host, 'a2a-bun.example:8443')
    assert.equal(headers.accept, 'text/event-stream')
    assert.equal(calls[0]?.init.redirect, 'error')
    assert.ok(!('dispatcher' in (calls[0]?.init ?? {})))
})

test('on Bun a second DNS answer cannot rebind a checked host to loopback', async (t) => {
    onBun(t)
    const lookups = answers(t, 'a2a-bun-rebind.example', [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 }
    ])
    const calls = capturedFetch(t)

    await assert.rejects(
        guardedFetch('https://a2a-bun-rebind.example/rpc', {}),
        /private or reserved/
    )
    assert.equal(lookups.count(), 2)
    assert.equal(calls.length, 0)
})

test('on Bun an IPv6 answer is bracketed and a private dev target is left alone', async (t) => {
    onBun(t)
    answers(t, 'a2a-bun6.example', [
        { address: '2001:4860:4860::8888', family: 6 }
    ])
    const calls = capturedFetch(t)

    await guardedFetch('https://a2a-bun6.example/rpc', {})
    await guardedFetch('http://127.0.0.1:8080/rpc', {}, { allowPrivate: true })

    assert.equal(calls[0]?.url, 'https://[2001:4860:4860::8888]/rpc')
    assert.equal(calls[1]?.url, 'http://127.0.0.1:8080/rpc')
    assert.equal((calls[1]?.init.headers as Record<string, string>).host, undefined)
})

const causeCodes = (err: unknown): string[] => {
    const codes: string[] = []
    let current = err as { code?: unknown; cause?: unknown } | undefined
    while (current && typeof current === 'object') {
        if (typeof current.code === 'string') codes.push(current.code)
        current = current.cause as typeof current
    }
    return codes
}

test('a host that does not resolve keeps the DNS error as its cause', async (t) => {
    t.mock.method(dns, 'lookup', async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND gone.example'), {
            code: 'ENOTFOUND'
        })
    })
    await assert.rejects(assertSafeUrl('https://gone.example/rpc'), (err: unknown) => {
        assert.equal((err as Error).message, 'A2A endpoint host gone.example could not be resolved')
        assert.deepEqual(causeCodes(err), ['ENOTFOUND'])
        return true
    })
})

test('an endpoint that refuses the connection is named, with the socket error as the cause', async () => {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await new Promise<void>((resolve) => server.close(() => resolve()))

    await assert.rejects(
        guardedFetch(`http://127.0.0.1:${address.port}/rpc`, {}, { allowPrivate: true }),
        (err: unknown) => {
            assert.match(
                (err as Error).message,
                new RegExp(`^A2A endpoint 127\\.0\\.0\\.1:${address.port} could not be reached \\(`)
            )
            assert.ok(causeCodes(err).includes('ECONNREFUSED'), causeCodes(err).join(','))
            return true
        }
    )
})

test('an abort during the request is not dressed up as an unreachable endpoint', async (t) => {
    const server = createServer(() => {})
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    t.after(() => {
        server.closeAllConnections()
        server.close()
    })
    const controller = new AbortController()
    const pending = guardedFetch(
        `http://127.0.0.1:${address.port}/rpc`,
        { signal: controller.signal },
        { allowPrivate: true }
    )
    setTimeout(() => controller.abort(new Error('deadline')), 50)
    await assert.rejects(pending, (err: unknown) => {
        assert.doesNotMatch(String((err as Error)?.message), /could not be reached/)
        return true
    })
})

