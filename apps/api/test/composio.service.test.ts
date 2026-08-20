import assert from 'node:assert/strict'
import test from 'node:test'
import { ComposioService } from '../src/modules/connections/composio.service'

// Composio Connect has no REST verify endpoint, so verifyKey probes the MCP
// server with a JSON-RPC `initialize` handshake using the x-consumer-api-key
// header. These pin that contract: an explicit auth rejection (401/403) ⇒
// invalid; any other status is accepted so a good key is never false-rejected
// by a transport/protocol quirk; a network error fails CLOSED.

interface Captured {
    url: string
    method?: string
    headers: Record<string, string>
    body?: string
}

const withFetch = async (
    status: number,
    fn: (svc: ComposioService, seen: Captured) => Promise<void>
): Promise<void> => {
    const seen: Captured = { url: '', headers: {} }
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        seen.url = String(url)
        seen.method = init?.method
        seen.headers = (init?.headers as Record<string, string>) ?? {}
        seen.body = init?.body as string | undefined
        return { ok: status >= 200 && status < 300, status }
    }) as never
    try {
        await fn(new ComposioService(), seen)
    } finally {
        globalThis.fetch = original
    }
}

test('verifyKey accepts a key when the MCP initialize handshake succeeds', async () => {
    await withFetch(200, async (svc, seen) => {
        assert.deepEqual(await svc.verifyKey('ck_consumer_xyz'), { valid: true })
        assert.equal(seen.url, 'https://connect.composio.dev/mcp')
        assert.equal(seen.method, 'POST')
        assert.equal(seen.headers['x-consumer-api-key'], 'ck_consumer_xyz')
        assert.match(String(seen.body), /"method":"initialize"/)
    })
})

test('verifyKey rejects a key the MCP server refuses with 401', async () => {
    await withFetch(401, async (svc) => {
        assert.deepEqual(await svc.verifyKey('bad'), { valid: false })
    })
})

test('verifyKey rejects a key the MCP server refuses with 403', async () => {
    await withFetch(403, async (svc) => {
        assert.deepEqual(await svc.verifyKey('bad'), { valid: false })
    })
})

test('verifyKey does not false-reject a good key on a non-auth error (400)', async () => {
    await withFetch(400, async (svc) => {
        assert.deepEqual(await svc.verifyKey('ck_ok'), { valid: true })
    })
})

test('verifyKey fails closed on a network error', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
        throw new Error('ECONNRESET')
    }) as never
    try {
        assert.deepEqual(
            await new ComposioService().verifyKey('whatever'),
            { valid: false }
        )
    } finally {
        globalThis.fetch = original
    }
})
