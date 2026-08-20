import type { DaemonWsFrame } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { ConfigService } from '@nestjs/config'
import type { WebSocket as WsClient } from 'ws'
import type { Database, RuntimeHostRow } from '@manyfold/db'
import { DaemonRegistryService } from '../src/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from '../src/modules/chat/adapters/daemon-fenced-dispatch.service'
import type { TelemetryService } from '../src/common/telemetry/telemetry.service'

// #619 regression: a fresh turn dispatched onto a websocket generation that a
// reconnect then replaces used to surface `connection replaced`, suspend, and
// only converge ~95s later as a retryable server_restart. The fence recovers
// it in-line: it probes the CURRENT generation with exec.resume and either
// adopts the found stream or — on the authoritative `no buffer for refId`
// proof that the dispatch never arrived — re-dispatches the identical
// payload. These tests run the REAL registry (register/failPending/handleAck
// are the machinery under test) against scripted daemon sockets.

interface SentPush {
    refId: string
    method: string
    payload: Record<string, unknown>
}

class FakeSocket {
    readonly pushes: SentPush[] = []
    onPush: ((push: SentPush) => void) | null = null

    send(raw: string): void {
        const frame = JSON.parse(raw) as DaemonWsFrame
        if (frame.type !== 'push') return
        const push = {
            refId: frame.refId,
            method: frame.method,
            payload: frame.payload
        }
        this.pushes.push(push)
        // Async like a real socket round trip: the registry must finish
        // registering the pending entry before the daemon's answer lands.
        if (this.onPush) queueMicrotask(() => this.onPush?.(push))
    }

    close(): void {}
}

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'dh-1',
        userId: 'user-1',
        daemonUuid: 'daemon-uuid',
        name: 'sprite-runner:sprite-1',
        hostname: 'sprite-1',
        os: 'linux',
        arch: 'x64',
        cliVersion: '0.22.3',
        homeDir: '/home/sprite',
        workspaceBaseDir: '/home/sprite/.manyfold/workspaces',
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
                where: async () => undefined,
                returning: async () => []
            })
        }
    }
}

interface TelemetryEvent {
    name: string
    attrs: Record<string, unknown>
}

class TestFencedDispatch extends DaemonFencedDispatchService {
    budgetMs = 15_000
    onDelay: (() => void | Promise<void>) | null = null

    protected override async delay(): Promise<void> {
        if (this.onDelay) await this.onDelay()
        else await new Promise((resolve) => setTimeout(resolve, 1))
    }

    protected override recoveryBudgetMs(): number {
        return this.budgetMs
    }
}

const makeHarness = (row: RuntimeHostRow | null = host()) => {
    const config = {
        get: (key: string) =>
            key === 'MF_API_INSTANCE_ID' ? 'this-instance' : undefined
    } as ConfigService
    const registry = new DaemonRegistryService(
        new RegistryDb(row) as unknown as Database,
        config
    )
    const events: TelemetryEvent[] = []
    const telemetry = {
        event: (name: string, attrs: Record<string, unknown>) => {
            events.push({ name, attrs })
        },
        error: () => undefined
    } as unknown as TelemetryService
    const fenced = new TestFencedDispatch(registry, telemetry)
    const connect = async (): Promise<FakeSocket> => {
        const socket = new FakeSocket()
        await registry.register({
            daemonId: 'dh-1',
            userId: 'user-1',
            cliVersion: '0.22.3',
            hostname: 'sprite-1',
            socket: socket as unknown as WsClient
        })
        return socket
    }
    const ackOk = (refId: string, payload: Record<string, unknown>): void =>
        registry.handleAck('dh-1', { type: 'ack', refId, ok: true, payload })
    const ackError = (refId: string, error: string): void =>
        registry.handleAck('dh-1', { type: 'ack', refId, ok: false, error })
    const emit = (refId: string, data: string, seq: number): void =>
        registry.handleEvent('dh-1', {
            type: 'event',
            refId,
            kind: 'stdout',
            data,
            seq
        })
    return { registry, fenced, events, connect, ackOk, ackError, emit }
}

const dispatchArgs = (onEvent: (data: string, seq?: number) => void) => ({
    daemonId: 'dh-1',
    method: 'exec.start' as const,
    payload: { cmd: ['echo', 'hi'] },
    timeoutMs: 5_000,
    refId: 'msg-1',
    onEvent: (kind: string, data: string, seq?: number) => {
        if (kind === 'stdout') onEvent(data, seq)
    }
})

test('fresh dispatch killed by connection replaced re-dispatches on the new generation within the same turn', async () => {
    const h = makeHarness()
    const socketA = await h.connect()

    const received: string[] = []
    const startedAt = Date.now()
    const stream = h.fenced.streamTurnRpc(dispatchArgs((d) => received.push(d)))

    // The dispatch went out on generation A and is pending there.
    await waitFor(() => socketA.pushes.length === 1)
    assert.equal(socketA.pushes[0].method, 'exec.start')
    assert.equal(socketA.pushes[0].refId, 'msg-1')
    assert.ok(h.registry.hasPendingRef('dh-1', 'msg-1'))

    // The daemon (thawed by this very turn's awake-hold) re-dials: register()
    // fails generation A's pending rpcs with `connection replaced`.
    const socketB = new FakeSocket()
    socketB.onPush = (push) => {
        if (push.method === 'exec.resume') {
            assert.deepEqual(push.payload, {
                originalRefId: 'msg-1',
                fromSeq: 0
            })
            // Authoritative: generation B holds no stream for this ref, so
            // the frame sent to generation A never arrived and never can.
            h.ackError(push.refId, 'no buffer for refId msg-1')
            return
        }
        assert.equal(push.method, 'exec.start')
        assert.equal(push.refId, 'msg-1')
        h.emit(push.refId, 'hello ', 1)
        h.emit(push.refId, 'world', 2)
        h.ackOk(push.refId, { exitCode: 0 })
    }
    await h.registry.register({
        daemonId: 'dh-1',
        userId: 'user-1',
        cliVersion: '0.22.3',
        hostname: 'sprite-1',
        socket: socketB as unknown as WsClient
    })

    const payload = await stream.result
    assert.deepEqual(payload, { exitCode: 0 })
    assert.deepEqual(received, ['hello ', 'world'])
    // One probe, exactly one re-dispatch — and the whole recovery is
    // seconds-level, not the ~95s recheck + lease convergence of #619.
    assert.equal(
        socketB.pushes.filter((p) => p.method === 'exec.resume').length,
        1
    )
    assert.equal(
        socketB.pushes.filter((p) => p.method === 'exec.start').length,
        1
    )
    assert.ok(Date.now() - startedAt < 2_000)
    const recovery = h.events.find(
        (e) => e.name === 'chat.daemon.dispatch.recovery'
    )
    assert.equal(recovery?.attrs.action, 'redispatch')
    assert.match(String(recovery?.attrs.trigger), /connection replaced/)
})

test('a dispatch that did reach the daemon is adopted through the probe instead of re-dispatched', async () => {
    const h = makeHarness()
    await h.connect()

    const received: string[] = []
    const stream = h.fenced.streamTurnRpc(dispatchArgs((d) => received.push(d)))
    await waitFor(() => h.registry.hasPendingRef('dh-1', 'msg-1'))

    const socketB = new FakeSocket()
    socketB.onPush = (push) => {
        // The exec.start DID arrive on the old generation before it died: the
        // buffer exists, so the probe replays it from seq 0 and follows the
        // live tail to completion. Nothing may be dispatched twice.
        assert.equal(push.method, 'exec.resume')
        h.emit(push.refId, 'answer', 1)
        h.ackOk(push.refId, { exitCode: 0 })
    }
    await h.registry.register({
        daemonId: 'dh-1',
        userId: 'user-1',
        cliVersion: '0.22.3',
        hostname: 'sprite-1',
        socket: socketB as unknown as WsClient
    })

    const payload = await stream.result
    assert.deepEqual(payload, { exitCode: 0 })
    assert.deepEqual(received, ['answer'])
    assert.equal(
        socketB.pushes.filter((p) => p.method === 'exec.start').length,
        0
    )
    const recovery = h.events.find(
        (e) => e.name === 'chat.daemon.dispatch.recovery'
    )
    assert.equal(recovery?.attrs.action, 'resumed')
})

test('a terminal error recovered by the local probe reaches the original turn', async () => {
    const h = makeHarness()
    await h.connect()

    const stream = h.fenced.streamTurnRpc(dispatchArgs(() => undefined))
    await waitFor(() => h.registry.hasPendingRef('dh-1', 'msg-1'))

    const socketB = new FakeSocket()
    socketB.onPush = (push) => {
        assert.equal(push.method, 'exec.resume')
        h.ackError(push.refId, 'model gateway unavailable')
    }
    await h.registry.register({
        daemonId: 'dh-1',
        userId: 'user-1',
        cliVersion: '0.22.3',
        hostname: 'sprite-1',
        socket: socketB as unknown as WsClient
    })

    await assert.rejects(stream.result, /model gateway unavailable/)
    assert.equal(
        socketB.pushes.filter((push) => push.method === 'exec.start').length,
        0
    )
    const recovery = h.events.find(
        (event) => event.name === 'chat.daemon.dispatch.recovery'
    )
    assert.equal(recovery?.attrs.action, 'resumed')
})

test('mid-stream replacement keeps its suspend semantics: no probe, no re-dispatch', async () => {
    const h = makeHarness()
    const socketA = await h.connect()

    const received: string[] = []
    const stream = h.fenced.streamTurnRpc(dispatchArgs((d) => received.push(d)))
    const rejection = stream.result.catch((err) => err as Error)
    await waitFor(() => socketA.pushes.length === 1)

    // The daemon streamed a frame before the replacement: output exists that
    // only the suspend → hello-resume machinery may recover exactly-once.
    h.emit('msg-1', 'partial ', 1)
    const socketB = new FakeSocket()
    socketB.onPush = () => {
        assert.fail('a mid-stream turn must not be probed or re-dispatched')
    }
    await h.registry.register({
        daemonId: 'dh-1',
        userId: 'user-1',
        cliVersion: '0.22.3',
        hostname: 'sprite-1',
        socket: socketB as unknown as WsClient
    })

    const err = (await rejection) as Error
    assert.match(err.message, /connection replaced/)
    assert.deepEqual(received, ['partial '])
    assert.equal(socketB.pushes.length, 0)
})

test('a daemon terminal error that resembles a transport failure is not probed', async () => {
    const h = makeHarness()
    h.fenced.budgetMs = 25
    const socket = await h.connect()
    socket.onPush = (push) => h.ackError(push.refId, 'connection closed')

    const stream = h.fenced.streamTurnRpc(dispatchArgs(() => undefined))
    await assert.rejects(stream.result, /connection closed/)

    assert.deepEqual(
        socket.pushes.map((push) => push.method),
        ['exec.start']
    )
    assert.equal(
        h.events.some(
            (event) => event.name === 'chat.daemon.dispatch.recovery'
        ),
        false
    )
})

test('recovery that cannot re-establish a carrier gives up with the original transport error', async () => {
    const h = makeHarness()
    await h.connect()
    h.fenced.budgetMs = 25

    const stream = h.fenced.streamTurnRpc(dispatchArgs(() => undefined))
    const rejection = stream.result.catch((err) => err as Error)
    await waitFor(() => h.registry.hasPendingRef('dh-1', 'msg-1'))

    const replaceOnPush = (socket: FakeSocket): void => {
        socket.onPush = () => {
            const replacement = new FakeSocket()
            replaceOnPush(replacement)
            void h.registry.register({
                daemonId: 'dh-1',
                userId: 'user-1',
                cliVersion: '0.22.3',
                hostname: 'sprite-1',
                socket: replacement as unknown as WsClient
            })
        }
    }
    const socketB = new FakeSocket()
    replaceOnPush(socketB)
    await h.registry.register({
        daemonId: 'dh-1',
        userId: 'user-1',
        cliVersion: '0.22.3',
        hostname: 'sprite-1',
        socket: socketB as unknown as WsClient
    })

    const err = (await rejection) as Error
    // The FIRST error is the one surfaced, so the adapter's suspend
    // classification sees the same shape it does today and the bounded
    // recheck (#512/#517) stays the backstop.
    assert.match(err.message, /connection replaced/)
    const recovery = h.events.find(
        (e) => e.name === 'chat.daemon.dispatch.recovery'
    )
    assert.equal(recovery?.attrs.action, 'gave_up')
})

test('a dispatch that never left the api retries once the daemon reconnects', async () => {
    // No socket and no fresh rpc lease: the dispatch fails at lookup with
    // `is offline; no active websocket` — nothing ran, so a bounded retry is
    // safe by definition (#481's classification).
    const h = makeHarness(host({ rpcInstanceId: null, rpcInbox: null }))

    const received: string[] = []
    let reconnected = false
    h.fenced.onDelay = async () => {
        if (reconnected) return
        reconnected = true
        const socketB = new FakeSocket()
        socketB.onPush = (push) => {
            if (push.method === 'exec.resume') {
                h.ackError(push.refId, 'no buffer for refId msg-1')
                return
            }
            h.emit(push.refId, 'late but fine', 1)
            h.ackOk(push.refId, { exitCode: 0 })
        }
        await h.registry.register({
            daemonId: 'dh-1',
            userId: 'user-1',
            cliVersion: '0.22.3',
            hostname: 'sprite-1',
            socket: socketB as unknown as WsClient
        })
    }

    const stream = h.fenced.streamTurnRpc(dispatchArgs((d) => received.push(d)))
    const payload = await stream.result
    assert.deepEqual(payload, { exitCode: 0 })
    assert.deepEqual(received, ['late but fine'])
})

test('cancelling during reconnect backoff surfaces cancelled and never probes', async () => {
    const h = makeHarness(host({ rpcInstanceId: null, rpcInbox: null }))
    let releaseDelay: (() => void) | null = null
    const delayStarted = new Promise<void>((resolveStarted) => {
        h.fenced.onDelay = () =>
            new Promise<void>((resolveDelay) => {
                releaseDelay = resolveDelay
                resolveStarted()
            })
    })

    const stream = h.fenced.streamTurnRpc(dispatchArgs(() => undefined))
    const rejection = stream.result.catch((err) => err as Error)
    await delayStarted
    stream.cancel()
    const releaseBackoff = releaseDelay as (() => void) | null
    releaseBackoff?.()

    const err = (await rejection) as Error
    assert.match(err.message, /cancelled/)
    assert.equal(
        h.events.some(
            (event) => event.name === 'chat.daemon.dispatch.recovery'
        ),
        false
    )
})

test('remote recovery acts only on the no-buffer proof and otherwise yields to the socket owner', async () => {
    // The daemon's socket lives on a peer instance: every rpc relays through
    // the broker. A probe there may not become a carrier — the peer's
    // hello-resume cannot see this adapter running and would double-consume.
    const published: Array<{ channel: string; payload: string }> = []
    const h = makeHarness()
    const internal = h.registry as unknown as {
        brokerSql: {
            notify(channel: string, payload: string): Promise<void>
        }
        handleBrokerEnvelope(raw: string): Promise<void>
    }
    internal.brokerSql = {
        notify: async (channel, payload) => {
            published.push({ channel, payload })
        }
    }
    const respond = async (requestId: string, error: string): Promise<void> => {
        for (const chunk of encodeBrokerMessage({
            type: 'response',
            requestId,
            ok: false,
            error
        }))
            await internal.handleBrokerEnvelope(chunk)
    }

    const stream = h.fenced.streamTurnRpc(dispatchArgs(() => undefined))
    const rejection = stream.result.catch((err) => err as Error)

    await waitFor(() => published.length === 1)
    const first = decodeBrokerRequest(published[0].payload)
    assert.equal(first.method, 'exec.start')
    await respond(first.requestId, 'connection replaced')

    await waitFor(() => published.length === 2)
    const probe = decodeBrokerRequest(published[1].payload)
    assert.equal(probe.method, 'exec.resume')
    // Not the no-buffer proof: the stream may exist over there. Yield.
    await respond(probe.requestId, 'daemon process crashed')

    const err = (await rejection) as Error
    assert.match(err.message, /connection replaced/)
    assert.equal(published.length, 2)
})

test('a remote daemon terminal error is preserved without starting a probe', async () => {
    const published: Array<{ channel: string; payload: string }> = []
    const h = makeHarness()
    const internal = h.registry as unknown as {
        brokerSql: {
            notify(channel: string, payload: string): Promise<void>
        }
        handleBrokerEnvelope(raw: string): Promise<void>
    }
    internal.brokerSql = {
        notify: async (channel, payload) => {
            published.push({ channel, payload })
        }
    }

    const stream = h.fenced.streamTurnRpc(dispatchArgs(() => undefined))
    const rejection = stream.result.catch((err) => err as Error)
    await waitFor(() => published.length === 1)
    const request = decodeBrokerRequest(published[0].payload)
    for (const chunk of encodeBrokerMessage({
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: 'connection closed',
        errorSource: 'daemon'
    }))
        await internal.handleBrokerEnvelope(chunk)

    const outcome = await Promise.race([
        rejection,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))
    ])
    if (outcome === null) stream.cancel()
    assert.ok(outcome instanceof Error)
    assert.match(outcome.message, /connection closed/)
    assert.equal(published.length, 1)
})

test('remote no-buffer proof re-dispatches through the broker', async () => {
    const published: Array<{ channel: string; payload: string }> = []
    const h = makeHarness()
    const internal = h.registry as unknown as {
        brokerSql: {
            notify(channel: string, payload: string): Promise<void>
        }
        handleBrokerEnvelope(raw: string): Promise<void>
    }
    internal.brokerSql = {
        notify: async (channel, payload) => {
            published.push({ channel, payload })
        }
    }
    const send = async (message: unknown): Promise<void> => {
        for (const chunk of encodeBrokerMessage(message))
            await internal.handleBrokerEnvelope(chunk)
    }

    const received: string[] = []
    const stream = h.fenced.streamTurnRpc(dispatchArgs((d) => received.push(d)))

    await waitFor(() => published.length === 1)
    const first = decodeBrokerRequest(published[0].payload)
    await send({
        type: 'response',
        requestId: first.requestId,
        ok: false,
        error: 'connection replaced'
    })

    await waitFor(() => published.length === 2)
    const probe = decodeBrokerRequest(published[1].payload)
    assert.equal(probe.method, 'exec.resume')
    await send({
        type: 'response',
        requestId: probe.requestId,
        ok: false,
        error: 'no buffer for refId msg-1'
    })

    await waitFor(() => published.length === 3)
    const second = decodeBrokerRequest(published[2].payload)
    assert.equal(second.method, 'exec.start')
    assert.equal(second.refIdOverride, 'msg-1')
    await send({
        type: 'event',
        requestId: second.requestId,
        kind: 'stdout',
        data: 'relayed',
        seq: 1
    })
    await send({
        type: 'response',
        requestId: second.requestId,
        ok: true,
        payload: { exitCode: 0 }
    })

    assert.deepEqual(await stream.result, { exitCode: 0 })
    assert.deepEqual(received, ['relayed'])
})

interface DecodedRequest {
    requestId: string
    method: string
    refIdOverride?: string
}

const decodeBrokerRequest = (payload: string): DecodedRequest => {
    const envelope = JSON.parse(payload) as { data: string }
    return JSON.parse(
        Buffer.from(envelope.data, 'base64').toString('utf8')
    ) as DecodedRequest
}

const encodeBrokerMessage = (message: unknown): string[] => {
    const id = randomUUID()
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const chunkBytes = 4500
    const total = Math.max(1, Math.ceil(body.length / chunkBytes))
    const chunks: string[] = []
    for (let seq = 0; seq < total; seq += 1)
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
    return chunks
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail('condition was not met')
}
