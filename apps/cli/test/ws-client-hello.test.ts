import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

// The hello's inflightStreams field is the server's ONLY evidence for "this
// daemon holds no stream for that open turn" — evidence it acts on by writing
// a retryable terminal (#518). The old wire shape omitted the field both for
// "no streams" and "enumeration failed", so the server could not tell proof
// from ignorance. Pin the new contract: a successful (even empty) enumeration
// always sends the field, and the client declares the feature that lets the
// server trust its absence to mean failure.

// daemonPaths resolves from homedir() at import time — redirect before the
// dynamic import so the enumeration sees an empty temp profile, not the
// developer's real daemon.
const home = mkdtempSync(join(tmpdir(), 'mf-ws-hello-'))
process.env.HOME = home
process.env.MF_PROFILE = 'hellotest'

const { DaemonWsClient } = await import('../src/daemon/ws-client')

test('hello carries inflightStreams even when empty, plus the feature flag', async () => {
    const httpServer = createServer()
    const wss = new WebSocketServer({ server: httpServer })
    const firstMessage = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
            wss.on('connection', (socket: WebSocket) => {
                socket.once('message', (raw) =>
                    resolve(JSON.parse(String(raw)) as Record<string, unknown>)
                )
                socket.once('error', reject)
            })
        }
    )
    await new Promise<void>((resolve) =>
        httpServer.listen(0, '127.0.0.1', resolve)
    )
    const address = httpServer.address()
    assert.ok(address && typeof address === 'object')

    const client = new DaemonWsClient({
        apiUrl: `http://127.0.0.1:${address.port}`,
        token: 'test-token',
        daemonUuid: 'uuid-hello-test',
        cliVersion: '0.0.0-test'
    })
    client.start()
    try {
        const hello = await firstMessage
        assert.equal(hello.type, 'hello')
        assert.deepEqual(
            hello.inflightStreams,
            [],
            'an empty enumeration is proof, not an omission'
        )
        // The literal wire value on purpose (not the shared constant): the
        // server keys off this exact string, so a rename must fail here.
        assert.ok(
            (hello.clientFeatures as string[]).includes(
                'hello.inflight-authoritative'
            ),
            'the client declares that absence would mean enumeration failure'
        )
        assert.ok(
            (hello.clientFeatures as string[]).includes('turn.budgets'),
            'the client declares it parses the split turn budgets (#513/#556)'
        )
        assert.ok(
            (hello.clientFeatures as string[]).includes(
                'model.credential-facts'
            ),
            'the client declares model.inspect responses carry credentialFacts'
        )
        assert.ok(
            (hello.clientFeatures as string[]).includes('account.inspect'),
            'the client declares it answers account.inspect for the runtime page'
        )
    } finally {
        client.stop()
        wss.close()
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve())
        })
    }
})
