import type { DaemonStreamKind } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { ConfigService } from '@nestjs/config'
import type { WebSocket as WsClient } from 'ws'
import type { Database, RuntimeHostRow } from '@manyfold/db'
import { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'

interface PublishedBrokerMessage {
    channel: string
    payload: string
}

interface RegistryPrivate {
    inbox: string
    brokerSql: {
        notify(channel: string, payload: string): Promise<void>
    }
    handleBrokerEnvelope(raw: string): Promise<void>
}

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'dh-1',
        userId: 'user-1',
        daemonUuid: 'daemon-uuid',
        name: 'laptop',
        hostname: 'laptop.local',
        os: 'darwin',
        arch: 'arm64',
        cliVersion: '0.0.1',
        homeDir: '/Users/me',
        workspaceBaseDir: '/Users/me/.nca/workspaces',
        detectedFrameworks: [],
        lastSeenAt: new Date(),
        rpcInstanceId: 'owner-instance',
        rpcInbox: 'owner-inbox',
        rpcConnectedAt: new Date(),
        rpcLastSeenAt: new Date(),
        lastIp: null,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as RuntimeHostRow

class RegistryDb {
    constructor(private readonly row: RuntimeHostRow | null) {}

    select() {
        return {
            from: () => ({
                where: () => ({
                    limit: async () => (this.row ? [this.row] : [])
                })
            })
        }
    }

    update() {
        return {
            set: () => ({
                where: async () => undefined
            })
        }
    }
}

test('daemon registry forwards rpc to the websocket owner inbox', async () => {
    const published: PublishedBrokerMessage[] = []
    const registry = makeRegistry(published)
    const internal = registry as unknown as RegistryPrivate

    const result = registry.rpc({
        daemonId: 'dh-1',
        method: 'fs.stat',
        payload: { path: '/Users/me/.nca/workspaces/a.txt' },
        timeoutMs: 1_000
    })

    await waitFor(() => published.length > 0)
    const request = decodeBrokerMessage(published.map((p) => p.payload)) as {
        type: 'request'
        requestId: string
        replyInbox: string
        stream: boolean
    }

    assert.equal(published[0].channel, 'owner-inbox')
    assert.equal(request.type, 'request')
    assert.equal(request.replyInbox, internal.inbox)
    assert.equal(request.stream, false)

    for (const payload of encodeBrokerMessage({
        type: 'response',
        requestId: request.requestId,
        ok: true,
        payload: { size: 42 }
    }))
        await internal.handleBrokerEnvelope(payload)

    assert.deepEqual(await result, { size: 42 })
})

test('daemon registry forwards stream events and cancel across inboxes', async () => {
    const published: PublishedBrokerMessage[] = []
    const registry = makeRegistry(published)
    const internal = registry as unknown as RegistryPrivate
    const events: Array<{ kind: DaemonStreamKind; data: string }> = []

    const stream = registry.streamRpc({
        daemonId: 'dh-1',
        method: 'exec.start',
        payload: { cmd: ['printf', 'hello'] },
        timeoutMs: 1_000,
        onEvent: (kind, data) => events.push({ kind, data })
    })

    await waitFor(() => published.length > 0)
    const request = decodeBrokerMessage(published.map((p) => p.payload)) as {
        type: 'request'
        requestId: string
        stream: boolean
    }
    assert.equal(request.stream, true)

    for (const payload of encodeBrokerMessage({
        type: 'event',
        requestId: request.requestId,
        kind: 'stdout',
        data: 'hello'
    }))
        await internal.handleBrokerEnvelope(payload)
    for (const payload of encodeBrokerMessage({
        type: 'response',
        requestId: request.requestId,
        ok: true,
        payload: { exitCode: 0 }
    }))
        await internal.handleBrokerEnvelope(payload)

    assert.deepEqual(events, [{ kind: 'stdout', data: 'hello' }])
    assert.deepEqual(await stream.result, { exitCode: 0 })

    published.length = 0
    const cancellable = registry.streamRpc({
        daemonId: 'dh-1',
        method: 'exec.start',
        payload: { cmd: ['sleep', '60'] },
        timeoutMs: 1_000,
        onEvent: () => undefined
    })
    const cancelled = cancellable.result.catch((err) => err as Error)
    await waitFor(() => published.length > 0)
    cancellable.cancel()

    const err = (await cancelled) as Error
    assert.match(err.message, /cancelled/)
    await waitFor(() => published.length > 1)
    const cancel = decodeBrokerMessage([published.at(-1)!.payload]) as {
        type: 'cancel'
    }
    assert.equal(cancel.type, 'cancel')
})

test('a local socket replacement gets a distinct ownership token', async () => {
    const registry = makeRegistry([])
    const first = { close: () => undefined } as unknown as WsClient
    const second = { close: () => undefined } as unknown as WsClient
    const register = (socket: WsClient) =>
        registry.register({
            daemonId: 'dh-1',
            userId: 'user-1',
            cliVersion: '0.0.1',
            hostname: 'laptop.local',
            socket
        })

    await register(first)
    const firstHello = registry.recordHelloForSocket('dh-1', first)
    assert.ok(firstHello)
    assert.equal(firstHello.helloOrder, 1)
    const nextFirstHello = registry.recordHelloForSocket('dh-1', first)
    assert.ok(nextFirstHello)
    assert.equal(nextFirstHello.helloOrder, 2)
    assert.equal(nextFirstHello.connectionToken, firstHello.connectionToken)
    assert.ok(registry.isCurrentHelloEvidence('dh-1', nextFirstHello))

    await register(second)
    const secondHello = registry.recordHelloForSocket('dh-1', second)
    assert.ok(secondHello)
    assert.equal(secondHello.helloOrder, 1)
    assert.notEqual(secondHello.connectionToken, firstHello.connectionToken)
    assert.equal(registry.recordHelloForSocket('dh-1', first), null)
    assert.equal(registry.isCurrentHelloEvidence('dh-1', firstHello), false)
    assert.ok(registry.isCurrentHelloEvidence('dh-1', secondHello))
})

const makeRegistry = (
    published: PublishedBrokerMessage[],
    row = host()
): DaemonRegistryService => {
    const config = {
        get: (key: string) =>
            key === 'MF_API_INSTANCE_ID' ? 'caller-instance' : undefined
    } as ConfigService
    const registry = new DaemonRegistryService(
        new RegistryDb(row) as unknown as Database,
        config
    )
    ;(registry as unknown as RegistryPrivate).brokerSql = {
        notify: async (channel, payload) => {
            published.push({ channel, payload })
        }
    }
    return registry
}

const encodeBrokerMessage = (message: unknown): string[] => {
    const id = randomUUID()
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const chunks: string[] = []
    const chunkBytes = 4500
    const total = Math.max(1, Math.ceil(body.length / chunkBytes))
    for (let seq = 0; seq < total; seq += 1) {
        chunks.push(
            JSON.stringify({
                version: 1,
                id,
                seq,
                total,
                data: body
                    .subarray(seq * chunkBytes, (seq + 1) * chunkBytes)
                    .toString('base64')
            })
        )
    }
    return chunks
}

const decodeBrokerMessage = (payloads: string[]): unknown => {
    const envelopes = payloads.map((payload) => JSON.parse(payload)) as Array<{
        seq: number
        data: string
    }>
    const chunks = envelopes
        .sort((a, b) => a.seq - b.seq)
        .map((e) => Buffer.from(e.data, 'base64'))
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 50; i += 1) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('condition was not met')
}
