import assert from 'node:assert/strict'
import test from 'node:test'
import {
    CHANNEL_PROVIDER_HTTP_TIMEOUT_MS,
    channelProviderJsonRequest
} from '../src/modules/channels/providers/channel-http'

test('channelProviderJsonRequest attaches a timeout signal and parses JSON', async () => {
    const originalFetch = globalThis.fetch
    let seenUrl: string | URL | Request | undefined
    let seenInit: RequestInit | undefined
    globalThis.fetch = async (url, init) => {
        seenUrl = url
        seenInit = init
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    try {
        const res = await channelProviderJsonRequest<{ ok: boolean }>({
            provider: 'slack',
            operation: 'auth.test',
            url: 'https://slack.com/api/auth.test',
            init: { method: 'POST' }
        })
        assert.equal(seenUrl, 'https://slack.com/api/auth.test')
        assert.equal(seenInit?.method, 'POST')
        assert.equal(seenInit?.signal instanceof AbortSignal, true)
        assert.equal(res.ok, true)
        assert.equal(res.status, 200)
        assert.deepEqual(res.json, { ok: true })
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('channelProviderJsonRequest returns null JSON for malformed bodies', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('not-json', { status: 502 })
    try {
        const res = await channelProviderJsonRequest({
            provider: 'lark',
            operation: 'api GET',
            url: 'https://open.feishu.cn/open-apis/bot/v3/info'
        })
        assert.equal(res.ok, false)
        assert.equal(res.status, 502)
        assert.equal(res.text, 'not-json')
        assert.equal(res.json, null)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('channelProviderJsonRequest aborts stalled requests at the channel timeout', async () => {
    const originalFetch = globalThis.fetch
    let seenSignal: AbortSignal | undefined
    globalThis.fetch = async (_url, init) => {
        seenSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
            seenSignal?.addEventListener(
                'abort',
                () => {
                    const err = new Error('aborted')
                    err.name = 'AbortError'
                    reject(err)
                },
                { once: true }
            )
        })
    }
    try {
        await assert.rejects(
            channelProviderJsonRequest({
                provider: 'telegram',
                operation: 'sendMessage',
                url: 'https://api.telegram.org/botTOKEN/sendMessage',
                timeoutMs: 1
            }),
            /telegram sendMessage timed out after 1ms/
        )
        assert.equal(seenSignal?.aborted, true)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('channel provider HTTP timeout default stays aligned with Discord REST', () => {
    assert.equal(CHANNEL_PROVIDER_HTTP_TIMEOUT_MS, 15_000)
})

test('channelProviderJsonRequest retries transient fetch failures and succeeds', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
        calls++
        if (calls < 3) throw new TypeError('fetch failed')
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    try {
        const res = await channelProviderJsonRequest<{ ok: boolean }>({
            provider: 'lark',
            operation: 'api POST',
            url: 'https://open.feishu.cn/open-apis/im/v1/messages',
            init: { method: 'POST' },
            retryBackoffMs: [1, 1]
        })
        assert.equal(calls, 3, 'should attempt three times')
        assert.equal(res.ok, true)
        assert.deepEqual(res.json, { ok: true })
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('channelProviderJsonRequest throws after exhausting retries on persistent network error', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
        calls++
        throw new TypeError('fetch failed')
    }
    try {
        await assert.rejects(
            channelProviderJsonRequest({
                provider: 'lark',
                operation: 'api POST',
                url: 'https://open.feishu.cn/api',
                retryBackoffMs: [1, 1]
            }),
            /lark api POST network error: fetch failed/
        )
        assert.equal(calls, 3, 'should attempt three times before giving up')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('channelProviderJsonRequest does not retry timeouts', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async (_url, init) => {
        calls++
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
                'abort',
                () => {
                    const err = new Error('aborted')
                    err.name = 'AbortError'
                    reject(err)
                },
                { once: true }
            )
        })
    }
    try {
        await assert.rejects(
            channelProviderJsonRequest({
                provider: 'lark',
                operation: 'api POST',
                url: 'https://open.feishu.cn/api',
                timeoutMs: 1,
                retryBackoffMs: [1, 1]
            }),
            /lark api POST timed out after 1ms/
        )
        assert.equal(calls, 1, 'timeout must not trigger retry')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('channelProviderJsonRequest does not retry a successful HTTP error response', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
        calls++
        return new Response('boom', { status: 500 })
    }
    try {
        const res = await channelProviderJsonRequest({
            provider: 'lark',
            operation: 'api POST',
            url: 'https://open.feishu.cn/api',
            retryBackoffMs: [1, 1]
        })
        assert.equal(calls, 1, '5xx is a server response, not a retryable error')
        assert.equal(res.ok, false)
        assert.equal(res.status, 500)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('channelProviderJsonRequest surfaces Retry-After as milliseconds', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
        new Response('slow down', {
            status: 429,
            headers: { 'retry-after': '7' }
        })
    try {
        const res = await channelProviderJsonRequest({
            provider: 'slack',
            operation: 'chat.postMessage',
            url: 'https://slack.com/api/chat.postMessage'
        })
        assert.equal(res.status, 429)
        assert.equal(res.retryAfterMs, 7000)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('channelProviderJsonRequest parses HTTP-date Retry-After and null when absent', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
        new Response('slow down', {
            status: 429,
            headers: {
                'retry-after': new Date(Date.now() + 60_000).toUTCString()
            }
        })
    try {
        const dated = await channelProviderJsonRequest({
            provider: 'slack',
            operation: 'chat.postMessage',
            url: 'https://slack.com/api/chat.postMessage'
        })
        assert.ok((dated.retryAfterMs ?? 0) > 50_000)
        assert.ok((dated.retryAfterMs ?? 0) <= 60_000)
        globalThis.fetch = async () => new Response('ok', { status: 200 })
        const bare = await channelProviderJsonRequest({
            provider: 'slack',
            operation: 'chat.postMessage',
            url: 'https://slack.com/api/chat.postMessage'
        })
        assert.equal(bare.retryAfterMs, null)
    } finally {
        globalThis.fetch = originalFetch
    }
})
