import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse
} from 'node:http'
import { createClient } from '../src/client'
import { SpritesError } from '../src/errors'
import type { Sprite } from '../src/types'

interface RecordedCall {
    method: string
    path: string
}

interface MockHandle {
    port: number
    calls: RecordedCall[]
    close: () => Promise<void>
}

type Responder = (
    method: string,
    url: string
) => { status?: number; body?: string }

const startMock = async (responder: Responder): Promise<MockHandle> => {
    const calls: RecordedCall[] = []
    const server: Server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
            req.on('data', () => {})
            req.on('end', () => {
                const method = req.method ?? 'GET'
                const path = req.url ?? '/'
                calls.push({ method, path })
                const response = responder(method, path)
                res.statusCode = response.status ?? 200
                res.setHeader('Content-Type', 'application/json')
                res.end(response.body ?? '')
            })
        }
    )
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
        port,
        calls,
        close: () =>
            new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

const clientFor = (port: number) =>
    createClient({ token: 't', baseUrl: `http://127.0.0.1:${port}` })

const makeSprites = (prefix: string, n: number): Sprite[] =>
    Array.from({ length: n }, (_, i) => ({
        id: `${prefix}-${i}`,
        name: `${prefix}-${i}`,
        status: 'running'
    }))

const page = (sprites: Sprite[], next: string | null): string =>
    JSON.stringify({
        sprites,
        running: sprites.length,
        warm: 0,
        cold: 0,
        has_more: next !== null,
        next_continuation_token: next
    })

const continuationOf = (url: string): string | null =>
    new URL(url, 'http://x').searchParams.get('continuation_token')

// The incident sprite lived only on page 2 of a >50-sprite account, so the
// single-page client treated it as deleted. listSprites must now return every
// page merged, with the target present.
test('listSprites follows next_continuation_token across pages', async () => {
    const p1 = makeSprites('p1', 50)
    const p2 = [
        ...makeSprites('p2', 16),
        { id: 'target', name: 'sbx-target', status: 'running' }
    ]
    const mock = await startMock((method, url) => {
        if (method !== 'GET' || !url.startsWith('/sprites'))
            return { status: 404, body: '' }
        const token = continuationOf(url)
        if (!token) return { status: 200, body: page(p1, 'tok-2') }
        if (token === 'tok-2') return { status: 200, body: page(p2, null) }
        return { status: 400, body: '' }
    })
    try {
        const res = await clientFor(mock.port).listSprites()
        assert.equal(res.sprites.length, 67)
        assert.ok(
            res.sprites.some((s) => s.name === 'sbx-target'),
            'page-2 target sprite must be present'
        )
        const gets = mock.calls.filter((c) => c.method === 'GET')
        assert.equal(gets.length, 2)
        assert.match(gets[1].path, /continuation_token=tok-2/)
    } finally {
        await mock.close()
    }
})

// has_more without a usable cursor must terminate, not spin.
test('listSprites stops when has_more is true but the token is null', async () => {
    const mock = await startMock((method, url) => {
        if (method === 'GET' && url.startsWith('/sprites'))
            return {
                status: 200,
                body: JSON.stringify({
                    sprites: makeSprites('p1', 3),
                    running: 3,
                    warm: 0,
                    cold: 0,
                    has_more: true,
                    next_continuation_token: null
                })
            }
        return { status: 404, body: '' }
    })
    try {
        const res = await clientFor(mock.port).listSprites()
        assert.equal(res.sprites.length, 3)
        assert.equal(mock.calls.filter((c) => c.method === 'GET').length, 1)
    } finally {
        await mock.close()
    }
})

// A repeated cursor must break the loop rather than page forever.
test('listSprites terminates on a repeated continuation token', async () => {
    const mock = await startMock((method, url) => {
        if (method !== 'GET' || !url.startsWith('/sprites'))
            return { status: 404, body: '' }
        // always hand back the same token, forever
        return { status: 200, body: page(makeSprites('x', 2), 'loop') }
    })
    try {
        const res = await clientFor(mock.port).listSprites()
        // page 1 + one continuation, then the repeat is detected
        assert.equal(mock.calls.filter((c) => c.method === 'GET').length, 2)
        assert.equal(res.sprites.length, 4)
    } finally {
        await mock.close()
    }
})

// A partial listing would re-introduce the false-missing bug, so any page
// failing must fail the whole call.
test('listSprites rejects if a continuation page fails (no partial listing)', async () => {
    const mock = await startMock((method, url) => {
        if (method !== 'GET' || !url.startsWith('/sprites'))
            return { status: 404, body: '' }
        if (!continuationOf(url))
            return { status: 200, body: page(makeSprites('p1', 50), 'tok-2') }
        return { status: 500, body: '{"error":"boom"}' }
    })
    try {
        await assert.rejects(
            clientFor(mock.port).listSprites(),
            (err: unknown) =>
                err instanceof SpritesError && err.code === 'transient'
        )
    } finally {
        await mock.close()
    }
})
