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
                where: () => {
                    const result = Promise.resolve(undefined)
                    return Object.assign(result, {
                        returning: async () => this.row ? [this.row] : []
                    })
                }
            })
        }
    }

    transaction<T>(work: (tx: RegistryDb) => Promise<T>): Promise<T> {
        return work(this)
    }
}

test('connection diagnostics distinguish a reconnect from a different client instance', async (t) => {
    const registry = makeRegistry([])
    const logs: string[] = []
    t.mock.method(
        (registry as unknown as { log: { log(message: string): void } }).log,
        'log',
        (message: string) => logs.push(message)
    )
    let replaced = 0
    const args = {
        daemonId: 'dh-1',
        userId: 'user-1',
        cliVersion: '3.0.1',
        hostname: 'fixture'
    }
    const first = {
        instanceId: 'a20627b1-3faf-43a3-9609-7facd812e040',
        pid: 1234
    }
    const other = {
        instanceId: 'b20627b1-3faf-43a3-9609-7facd812e040',
        pid: 5678
    }
    let socket: WsClient
    for (const clientProcess of [first, first, other, undefined]) {
        socket = {
            close: () => {
                replaced++
            }
        } as unknown as WsClient
        await registry.register({ ...args, socket, clientProcess })
    }
    assert.equal(replaced, 3)
    const connected = logs.filter((message) =>
        message.startsWith('daemon connected ')
    )
    assert.equal(connected.length, 4)
    for (const [i, kind] of [
        'none',
        'same-client',
        'different-client',
        'unknown'
    ].entries())
        assert.ok(connected[i].includes(`replacementKind=${kind}`))
    assert.ok(connected[0].includes('clientPid=1234'))
    assert.ok(connected[2].includes(other.instanceId))
    await registry.unregister(args.daemonId, socket!)
})

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

test('connection identity writes recover from failures, isolate daemons and drain on shutdown', async (t) => {
    const registry = new DaemonRegistryService(
        new RegistryDb(host()) as unknown as Database,
        { get: () => undefined } as unknown as ConfigService
    )
    const internal = registry as unknown as {
        markConnected(): Promise<void>
        connectionMutations: Map<string, Promise<void>>
    }
    const writes: Array<{ resolve(): void; reject(error: Error): void }> = []
    t.mock.method(internal, 'markConnected', () => new Promise<void>((resolve, reject) => {
        writes.push({ resolve, reject })
    }))
    const args = {
        daemonId: 'dh-1',
        userId: 'user-1',
        cliVersion: null,
        hostname: null,
        socket: { close() {} } as unknown as WsClient
    }
    const first = registry.register(args).catch((error: unknown) => error)
    await waitFor(() => writes.length === 1)
    const second = registry.register(args)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(writes.length, 1)
    writes[0].reject(new Error('fixture database failure'))
    assert.match(String(await first), /fixture database failure/)
    await waitFor(() => writes.length === 2)
    const other = registry.register({ ...args, daemonId: 'dh-2' })
    await waitFor(() => writes.length === 3)
    writes[2].resolve()
    await other
    assert.equal(internal.connectionMutations.size, 1)
    let stopped = false
    const shutdown = registry.onModuleDestroy().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(stopped, false)
    await assert.rejects(registry.register(args), /shutting down/)
    writes[1].resolve()
    await second
    await shutdown
    assert.equal(internal.connectionMutations.size, 0)
})

test('connection retirement covers replacement, unregister, forced disconnect and shutdown despite a failed observer', async (t) => {
    const registry = new DaemonRegistryService(
        new RegistryDb(host()) as unknown as Database,
        { get: () => undefined } as unknown as ConfigService
    )
    const warnings: unknown[] = []
    t.mock.method(
        (registry as unknown as { log: { warn(message: unknown): void } }).log,
        'warn',
        (message: unknown) => warnings.push(message)
    )
    const retired: string[] = []
    registry.onConnectionRetired(() => {
        throw new Error('fixture observer failure')
    })
    registry.onConnectionRetired((daemonId, token) => {
        assert.equal(daemonId, 'dh-1')
        retired.push(token)
    })
    let unsubscribedCalls = 0
    registry.onConnectionRetired(() => {
        unsubscribedCalls++
    })()
    const args = {
        daemonId: 'dh-1',
        userId: 'user-1',
        cliVersion: null,
        hostname: null
    }
    const register = async () => {
        const socket = { close: () => {} } as unknown as WsClient
        await registry.register({ ...args, socket })
        const evidence = registry.recordHelloForSocket('dh-1', socket)
        assert.ok(evidence)
        return { socket, token: evidence.connectionToken }
    }
    const first = await register()
    const second = await register()
    assert.deepEqual(retired, [first.token])
    await registry.unregister('dh-1', first.socket)
    assert.deepEqual(
        retired,
        [first.token],
        'a late close cannot retire the replacement'
    )
    registry.disconnect('dh-1')
    assert.deepEqual(retired, [first.token, second.token])
    assert.equal(registry.isOnline('dh-1'), false)
    const third = await register()
    await registry.unregister('dh-1', third.socket)
    const fourth = await register()
    let unlistened = false
    let ended = false
    const internal = registry as unknown as {
        brokerUnlisten: () => Promise<void>
        brokerSql: { end(): Promise<void> }
    }
    internal.brokerUnlisten = async () => {
        unlistened = true
    }
    internal.brokerSql = {
        end: async () => {
            ended = true
        }
    }
    await registry.onModuleDestroy()
    assert.deepEqual(retired, [
        first.token,
        second.token,
        third.token,
        fourth.token
    ])
    assert.equal(warnings.length, 4)
    assert.equal(unsubscribedCalls, 0)
    assert.equal(unlistened, true)
    assert.equal(ended, true)
    await registry.unregister('dh-1', fourth.socket)
    assert.equal(
        retired.length,
        4,
        'retirement is idempotent for the same connection'
    )
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
