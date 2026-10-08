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

const startMock = async (
    responder: (path: string) => { status?: number; body?: string }
): Promise<{ port: number; paths: string[]; close: () => Promise<void> }> => {
    const paths: string[] = []
    const server: Server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
            req.on('data', () => {})
            req.on('end', () => {
                paths.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
                const response = responder(req.url ?? '/')
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
        paths,
        close: () =>
            new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

const clientFor = (port: number) =>
    createClient({ token: 't', baseUrl: `http://127.0.0.1:${port}` })

// The three verdicts prod answered on 2026-10-08, verbatim in shape. The
// healthy one has not been seen yet, so nothing here assumes its literal.
const OBSERVED = [
    {
        status: 'unhealthy',
        reason: 'failed to start machine',
        sprite_name: 'sbx-a',
        sprite_id: 'sprite-da10be4f-8a36-4a08-8914-cab1da8c452a',
        elapsed: 1000,
        checked_at: '2026-10-08T11:20:54.176150Z'
    },
    {
        status: 'repaired',
        reason: 'restarted stopped machine',
        sprite_name: 'sbx-a',
        sprite_id: 'sprite-756d6d89-8819-4104-a177-5ea640858f55',
        elapsed: 1500,
        checked_at: '2026-10-08T11:21:50.424423Z'
    },
    {
        status: 'needs_repair',
        reason: 'machine in suspended state',
        sprite_name: 'sbx-a',
        sprite_id: 'sprite-3518d5aa-af46-41b3-86c2-866981d72551',
        elapsed: 100,
        checked_at: '2026-10-08T11:21:51.023522Z'
    }
] as const

test('checkSprite asks the named sprite and returns the verdict as answered', async () => {
    for (const verdict of OBSERVED) {
        const mock = await startMock(() => ({ body: JSON.stringify(verdict) }))
        try {
            const got = await clientFor(mock.port).checkSprite('sbx a/b')
            assert.deepEqual(got, verdict)
            // The name, encoded: the endpoint answers 404 for the sprite id.
            assert.deepEqual(mock.paths, ['GET /sprites/sbx%20a%2Fb/check'])
        } finally {
            await mock.close()
        }
    }
})

test('checkSprite surfaces a missing sprite and a provider fault as typed errors', async () => {
    for (const [status, code] of [
        [404, 'not_found'],
        [502, 'transient']
    ] as const) {
        const mock = await startMock(() => ({
            status,
            body: JSON.stringify({ error: 'sprite not found' })
        }))
        try {
            await assert.rejects(
                clientFor(mock.port).checkSprite('sbx-a'),
                (err: unknown) =>
                    err instanceof SpritesError &&
                    err.code === code &&
                    err.status === status
            )
        } finally {
            await mock.close()
        }
    }
})
