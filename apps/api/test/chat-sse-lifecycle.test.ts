import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { trace } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import {
    LoggerProvider,
    SimpleLogRecordProcessor
} from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import * as Sentry from '@sentry/node'
import { ChatController } from '../src/modules/chat/chat.controller'
import {
    ChatSseBroadcaster,
    type BroadcastSubscriber
} from '../src/modules/chat/sse-broadcaster'
import { TelemetryService } from '../src/common/telemetry/telemetry.service'

test('a cancelled cursor lookup never registers a subscriber or starts tail replay', async () => {
    let release!: (value: bigint) => void
    let reads = 0
    const cursor = new Promise<bigint>((resolve) => {
        release = resolve
    })
    const broadcaster = new ChatSseBroadcaster(
        {
            streamReplayCursor: () => cursor,
            listSessionStreamEventsSince: async () => {
                reads++
                return []
            }
        } as never,
        { onMessage() {}, onListenEstablished() {} } as never
    )
    const controller = new AbortController()
    try {
        const subscribing = broadcaster.subscribe(
            'session',
            {
                send() {
                    assert.fail('retired subscriber received an event')
                },
                close() {}
            },
            null,
            'message',
            controller.signal
        )
        controller.abort()
        release(0n)
        const unsubscribe = await subscribing
        await Promise.resolve()
        assert.equal(reads, 0)
        unsubscribe()
    } finally {
        broadcaster.onModuleDestroy()
    }
})

for (const reason of ['setup_error', 'request_error', 'write_error'] as const) {
    test(`SSE ${reason} releases listeners and timers once, without inventing trace correlation`, async (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] })
        let writes = 0,
            ends = 0,
            releases = 0,
            failWrite = false
        let subscriber!: BroadcastSubscriber
        const records: Array<{ name: string; attrs: Record<string, unknown> }> =
            []
        const request = Object.assign(new EventEmitter(), { destroyed: false })
        const response = Object.assign(new EventEmitter(), {
            destroyed: false,
            writableLength: 0,
            socket: { setNoDelay() {} },
            writeHead() {},
            end() {
                ends++
            },
            write() {
                if (failWrite) throw new Error('PRIVATE_FIXTURE_WRITE')
                writes++
                return true
            }
        })
        const controller = new ChatController(
            { subscribeStream: async () => ({ id: 'session' }) } as never,
            {
                subscribe: async (_id: string, value: BroadcastSubscriber) => {
                    if (reason === 'setup_error')
                        throw new Error('PRIVATE_FIXTURE_SETUP')
                    subscriber = value
                    return () => {
                        releases++
                    }
                }
            } as never,
            {
                event: (name: string, attrs: Record<string, unknown>) =>
                    records.push({ name, attrs })
            } as never
        )
        t.after(() => request.emit('close'))
        const opening = controller.stream(
            { userId: 'private' } as never,
            'agent',
            'session',
            undefined,
            undefined,
            { raw: request, headers: {} } as never,
            { raw: response, hijack() {} } as never
        )
        if (reason === 'setup_error')
            await assert.rejects(opening, /PRIVATE_FIXTURE_SETUP/)
        else {
            await opening
            if (reason === 'request_error')
                request.emit('error', new Error('PRIVATE_FIXTURE_REQUEST'))
            else {
                failWrite = true
                assert.throws(
                    () =>
                        subscriber.send({
                            eventId: '1',
                            type: 'token'
                        } as never),
                    /PRIVATE_FIXTURE_WRITE/
                )
            }
            subscriber.close('server_shutdown')
        }
        const count = writes
        t.mock.timers.tick(30_000)
        assert.equal(writes, count)
        assert.equal(ends, 1)
        assert.equal(releases, reason === 'setup_error' ? 0 : 1)
        assert.equal(request.listenerCount('close'), 0)
        assert.equal(request.listenerCount('error'), 0)
        assert.equal(response.listenerCount('close'), 0)
        const closed = records.filter(
            (record) => record.name === 'chat.sse.closed'
        )
        assert.equal(closed.length, 1)
        assert.equal(closed[0].attrs.reason, reason)
        assert.equal('trace_id' in closed[0].attrs, false)
        assert.equal('span_id' in closed[0].attrs, false)
        assert.equal(JSON.stringify(records).includes('PRIVATE_FIXTURE'), false)
    })
}

test(
    'real HTTP streams correlate closes without retaining request scope or duplicate subscriptions',
    { timeout: 15_000 },
    async (t) => {
        const received: string[] = []
        const receiver = createServer((req, res) => {
            let body = ''
            req.setEncoding('utf8')
            req.on('data', (chunk) => {
                body += chunk
            })
            req.on('end', () => {
                received.push(body)
                res.end('{}')
            })
        })
        await new Promise<void>((resolve) =>
            receiver.listen(0, '127.0.0.1', resolve)
        )
        const receiverAddress = receiver.address()
        assert.ok(receiverAddress && typeof receiverAddress !== 'string')
        const logger = new LoggerProvider({
            processors: [
                new SimpleLogRecordProcessor(
                    new OTLPLogExporter({
                        url: `http://127.0.0.1:${receiverAddress.port}/v1/logs`
                    })
                )
            ]
        })
        const sdk = new NodeSDK({
            resourceDetectors: [],
            traceExporter: new InMemorySpanExporter(),
            contextManager: new Sentry.SentryContextManager()
        })
        sdk.start()
        const telemetry = new TelemetryService()
        Object.assign(telemetry, {
            otel: logger.getLogger('sse-lifecycle-fixture')
        })
        const observed: Array<{
            name: string
            attrs: Record<string, unknown>
            user: unknown
            breadcrumbs: unknown[]
        }> = []
        const emit = telemetry.event.bind(telemetry)
        telemetry.event = (name, attrs = {}) => {
            observed.push({
                name,
                attrs,
                user: Sentry.getIsolationScope().getUser(),
                breadcrumbs: Sentry.getCurrentScope().getScopeData().breadcrumbs
            })
            emit(name, attrs)
        }
        const subscribers: BroadcastSubscriber[] = []
        let active = 0,
            peak = 0,
            released = 0
        const transportClosed: Promise<void>[] = []
        let releaseAttach: (() => void) | undefined
        const controller = new ChatController(
            {
                subscribeStream: async () => ({ id: 'session-private-fixture' })
            } as never,
            {
                subscribe: async (
                    _id: string,
                    subscriber: BroadcastSubscriber
                ) => {
                    subscribers.push(subscriber)
                    active++
                    peak = Math.max(peak, active)
                    if (subscribers.length === 3)
                        await new Promise<void>((resolve) => {
                            releaseAttach = resolve
                        })
                    return () => {
                        active--
                        released++
                    }
                }
            } as never,
            telemetry
        )
        const server = createServer((req, res) => {
            transportClosed.push(
                new Promise<void>((resolve) => res.once('close', resolve))
            )
            trace
                .getTracer('fixture.http')
                .startActiveSpan('GET stream', (span) => {
                    res.once('close', () => span.end())
                    void Sentry.withIsolationScope(async (scope) => {
                        scope.setUser({ id: 'PRIVATE_FIXTURE_USER' })
                        Sentry.getCurrentScope().addBreadcrumb({
                            message: 'PRIVATE_FIXTURE_CONTENT'
                        })
                        try {
                            await controller.stream(
                                { userId: 'PRIVATE_FIXTURE_USER' } as never,
                                'agent-private-fixture',
                                'session-private-fixture',
                                '1',
                                undefined,
                                { raw: req, headers: req.headers } as never,
                                { raw: res, hijack: () => {} } as never
                            )
                        } catch {
                            res.destroy()
                        }
                    })
                })
        })
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve)
        )
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        const url = `http://127.0.0.1:${address.port}/stream?token=PRIVATE_FIXTURE_QUERY`
        const responses: Array<{
            reader: ReadableStreamDefaultReader<Uint8Array>
            abort: AbortController
        }> = []
        let cleaning: Promise<void> | undefined
        const cleanup = (): Promise<void> => cleaning ??= (async () => {
            releaseAttach?.()
            for (const item of responses) item.abort.abort()
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
            await logger.shutdown()
            await sdk.shutdown()
            receiver.closeAllConnections()
            await new Promise<void>(resolve => receiver.close(() => resolve()))
        })()
        t.after(cleanup)
        const open = async () => {
            const abort = new AbortController()
            const response = await fetch(url, { signal: abort.signal })
            assert.equal(response.status, 200)
            const reader = response.body!.getReader()
            responses.push({ reader, abort })
            const first = await reader.read()
            const comment = new TextDecoder().decode(first.value)
            assert.match(comment, /^: trace [0-9a-f]{32} [0-9a-f]{16}\n\n$/)
            return {
                reader,
                abort,
                correlation: comment.trim().split(' ').slice(2)
            }
        }
        try {
            const first = await open()
            subscribers[0].close('server_shutdown')
            assert.equal((await first.reader.read()).done, true)
            await transportClosed[0]
            const second = await open()
            assert.notEqual(first.correlation[1], second.correlation[1])
            subscribers[0].close('write_error')
            assert.equal(
                active,
                1,
                'an old close cannot release the new subscriber'
            )
            second.abort.abort()
            await assert.rejects(second.reader.read())
            await transportClosed[1]
            const third = await open()
            third.abort.abort()
            await assert.rejects(third.reader.read())
            await transportClosed[2]
            assert.ok(releaseAttach)
            releaseAttach()
            await Promise.resolve()
            await Promise.resolve()
            await logger.forceFlush()
            const closed = observed.filter(
                (item) => item.name === 'chat.sse.closed'
            )
            assert.equal(closed.length, 3)
            assert.deepEqual(
                closed.map((item) => item.attrs.reason),
                ['server_shutdown', 'peer_close', 'peer_close']
            )
            assert.equal(closed[0].attrs.trace_id, first.correlation[0])
            assert.equal(closed[0].attrs.span_id, first.correlation[1])
            assert.equal(closed[1].attrs.span_id, second.correlation[1])
            assert.equal(active, 0)
            assert.equal(released, 3)
            assert.ok(
                peak <= 1,
                'each old subscriber is released before reconnect'
            )
            for (const item of observed) {
                assert.deepEqual(item.user, {})
                assert.deepEqual(item.breadcrumbs, [])
                assert.ok(
                    Object.keys(item.attrs).every((key) =>
                        [
                            'trace_id',
                            'span_id',
                            'reason',
                            'durationMs'
                        ].includes(key)
                    )
                )
            }
            const payload = received.join('\n')
            assert.ok(payload.includes('chat.sse.closed'))
            assert.ok(payload.includes(second.correlation[1]))
            for (const forbidden of [
                'PRIVATE_FIXTURE',
                'agent-private-fixture',
                'session-private-fixture',
                '?token='
            ])
                assert.equal(payload.includes(forbidden), false)
        } finally {
            await cleanup()
        }
    }
)
