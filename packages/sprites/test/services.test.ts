import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createClient } from '../src/client'
import { parseServiceLogStream } from '../src/services'
import type { ServiceObject } from '../src/types'

interface RecordedCall {
    method: string
    path: string
    body: string
}

interface MockHandle {
    port: number
    calls: RecordedCall[]
    close: () => Promise<void>
}

type Responder = (
    method: string,
    path: string,
    body: string
) => { status?: number; body?: string }

const startMock = async (responder: Responder): Promise<MockHandle> => {
    const calls: RecordedCall[] = []
    const server: Server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
            const chunks: Buffer[] = []
            req.on('data', (c) => chunks.push(c))
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8')
                const method = req.method ?? 'GET'
                const path = req.url ?? '/'
                calls.push({ method, path, body })
                const response = responder(method, path, body)
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
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

const sampleService = (
    name: string,
    overrides: Partial<ServiceObject> = {}
): ServiceObject => ({
    name,
    cmd: 'bash',
    args: ['-c', 'true'],
    needs: [],
    state: { name, status: 'running', pid: 100 },
    ...overrides
})

test('upsertService PUTs definition then GETs final state', async () => {
    const mock = await startMock((method, path) => {
        if (method === 'PUT' && path.startsWith('/sprites/sp/services/svc')) {
            return { status: 200, body: '{"type":"started","timestamp":"now"}' }
        }
        if (method === 'GET' && path === '/sprites/sp/services/svc') {
            return { status: 200, body: JSON.stringify(sampleService('svc')) }
        }
        return { status: 404, body: '' }
    })
    try {
        const client = createClient({
            token: 't',
            baseUrl: `http://127.0.0.1:${mock.port}`
        })
        const result = await client.upsertService('sp', 'svc', {
            cmd: 'bash',
            args: ['-c', 'true'],
            env: { K: 'V' },
            http_port: 8080
        })
        assert.equal(result.name, 'svc')
        assert.equal(result.state.status, 'running')
        const put = mock.calls.find((c) => c.method === 'PUT')
        assert.ok(put, 'expected a PUT call')
        assert.match(put.path, /duration=0s/)
        assert.deepEqual(JSON.parse(put.body), {
            cmd: 'bash',
            args: ['-c', 'true'],
            env: { K: 'V' },
            http_port: 8080
        })
    } finally {
        await mock.close()
    }
})

test('startService passes durationSec query param then re-GETs state', async () => {
    const mock = await startMock((method, path) => {
        if (method === 'POST' && path.includes('/start')) {
            return { status: 200, body: '' }
        }
        if (method === 'GET') {
            return { status: 200, body: JSON.stringify(sampleService('svc')) }
        }
        return { status: 404, body: '' }
    })
    try {
        const client = createClient({
            token: 't',
            baseUrl: `http://127.0.0.1:${mock.port}`
        })
        await client.startService('sp', 'svc', { durationSec: 3 })
        const post = mock.calls.find((c) => c.method === 'POST')
        assert.ok(post, 'expected a POST call')
        assert.equal(post.path, '/sprites/sp/services/svc/start?duration=3s')
    } finally {
        await mock.close()
    }
})

test('stopService passes timeoutSec query param and surfaces post-call state', async () => {
    const mock = await startMock((method) => {
        if (method === 'POST') return { status: 200, body: '' }
        return {
            status: 200,
            body: JSON.stringify(
                sampleService('svc', {
                    state: { name: 'svc', status: 'stopped' }
                })
            )
        }
    })
    try {
        const client = createClient({
            token: 't',
            baseUrl: `http://127.0.0.1:${mock.port}`
        })
        const result = await client.stopService('sp', 'svc', { timeoutSec: 5 })
        assert.equal(result.state.status, 'stopped')
        const post = mock.calls.find((c) => c.method === 'POST')
        assert.ok(post)
        assert.equal(post.path, '/sprites/sp/services/svc/stop?timeout=5s')
    } finally {
        await mock.close()
    }
})

test('deleteService sends DELETE and resolves to void', async () => {
    const mock = await startMock((method) => {
        if (method === 'DELETE') return { status: 204, body: '' }
        return { status: 404, body: '' }
    })
    try {
        const client = createClient({
            token: 't',
            baseUrl: `http://127.0.0.1:${mock.port}`
        })
        await client.deleteService('sp', 'svc')
        assert.equal(mock.calls.length, 1)
        assert.equal(mock.calls[0].method, 'DELETE')
        assert.equal(mock.calls[0].path, '/sprites/sp/services/svc')
    } finally {
        await mock.close()
    }
})

test('listServices returns parsed list', async () => {
    const mock = await startMock(() => ({
        status: 200,
        body: JSON.stringify({ services: [sampleService('a'), sampleService('b')] })
    }))
    try {
        const client = createClient({
            token: 't',
            baseUrl: `http://127.0.0.1:${mock.port}`
        })
        const result = await client.listServices('sp')
        assert.equal(result.services.length, 2)
        assert.deepEqual(
            result.services.map((s) => s.name),
            ['a', 'b']
        )
    } finally {
        await mock.close()
    }
})

test('parseServiceLogStream splits NDJSON and ignores garbage lines', () => {
    const text = [
        '{"type":"started","timestamp":"t1"}',
        'banner: hello',
        '{"type":"stdout","data":"x","timestamp":"t2"}',
        '',
        '{"type":"complete","timestamp":"t3"}'
    ].join('\n')
    const events = parseServiceLogStream(text)
    assert.equal(events.length, 3)
    assert.equal(events[0].type, 'started')
    assert.equal(events[1].type, 'stdout')
    assert.equal(events[2].type, 'complete')
})

test('parseServiceLogStream tolerates empty input', () => {
    assert.deepEqual(parseServiceLogStream(''), [])
    assert.deepEqual(parseServiceLogStream('\n\n'), [])
})
