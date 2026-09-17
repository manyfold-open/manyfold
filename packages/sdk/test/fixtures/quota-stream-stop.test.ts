import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { apiPaths, createObjectId } from '@manyfold/shared'
import { createClient } from '../../src/client'

test(
    'stream owns its pending ACK transport and timer',
    { timeout: 3000 },
    async (t) => {
        let stream: ServerResponse | undefined
        let ackSeen!: () => void, ackClosed!: () => void
        const received = new Promise<void>((resolve) => {
            ackSeen = resolve
        })
        const closed = new Promise<void>((resolve) => {
            ackClosed = resolve
        })
        const server = createServer((req, res) => {
            if (req.url === apiPaths.AGENT_SPRITE_STATUS_STREAM) {
                stream = res
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                res.write(
                    `data: ${JSON.stringify({ type: 'quota-warning', code: 'automation_runs', usage: 1, limit: 1, planName: 'Fixture', at: new Date().toISOString(), receiptId: createObjectId('quotaWarningReceipt') })}\n\n`
                )
            } else if (
                req.url === apiPaths.ME_RUNTIME_ACCESS_QUOTA_WARNING_ACK
            ) {
                req.resume()
                res.on('close', () => {
                    assert.equal(res.writableFinished, false)
                    ackClosed()
                })
                ackSeen()
            } else {
                res.writeHead(404).end()
            }
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const address = server.address()
        assert.ok(address && typeof address === 'object')
        const errors: Error[] = []
        const client = createClient({
            baseUrl: `http://127.0.0.1:${address.port}`
        })
        const handle = client.agents.streamSpriteStatus({
            onQuotaWarning: () => {},
            onError: (error) => errors.push(error)
        })
        t.after(async () => {
            handle.close()
            await new Promise<void>((resolve) => {
                server.close(() => resolve())
                server.closeAllConnections()
            })
        })
        await received
        if (process.env.QUOTA_STREAM_FIXTURE_MODE === 'eof') stream!.end()
        else handle.close()
        await closed
        assert.deepEqual(errors, [])
        console.log('ACK transport closed without a server response')
    }
)
