import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createServer as createSocketServer } from 'node:net'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync, inflateSync } from 'node:zlib'
import type { Server } from 'node:http'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import {
    InMemorySpanExporter,
    SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base'
import * as Sentry from '@sentry/node'
import { SentrySpanProcessor } from '@sentry/opentelemetry'
import {
    inBackgroundContext,
    inRequestContinuation
} from '../src/common/telemetry/background-context'

const listen = async (server: Server, port = 0): Promise<number> => {
    await new Promise<void>((resolve) =>
        server.listen(port, '127.0.0.1', resolve)
    )
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    return address.port
}

test(
    'real SDK envelopes isolate background work, concurrent requests and post-response errors',
    { timeout: 30000 },
    async (t) => {
        t.diagnostic(`Sentry SDK ${Sentry.SDK_VERSION}`)
        const require = createRequire(__filename)
        const reservation = createSocketServer()
        await new Promise<void>((resolve) =>
            reservation.listen(0, '127.0.0.1', resolve)
        )
        const address = reservation.address()
        assert.ok(address && typeof address === 'object')
        const sinkPort = address.port
        t.after(() => reservation.close())
        const received: Array<{ type: string; event: Sentry.Event }> = []
        const errors: unknown[] = []
        const servers: Server[] = []
        t.after(async () => {
            for (const server of servers) {
                server.closeAllConnections()
                await new Promise<void>((resolve) =>
                    server.close(() => resolve())
                )
            }
        })
        const env = {
            SENTRY_DSN: `http://public@127.0.0.1:${sinkPort}/1`,
            SENTRY_TRACES_SAMPLE_RATE: '1',
            MF_DEPLOY_ENV: 'local'
        }
        for (const [key, value] of Object.entries(env)) {
            const previous = process.env[key]
            process.env[key] = value
            t.after(() => {
                if (previous === undefined) delete process.env[key]
                else process.env[key] = previous
            })
        }
        // Load the production integration options and final-send hooks, not a
        // duplicated test configuration. Every envelope goes to the loopback sink.
        const production = await import('../src/sentry')
        const exporter = new InMemorySpanExporter()
        const sentryProcessor = new SentrySpanProcessor()
        const sdk = new NodeSDK({
            autoDetectResources: false,
            contextManager: new Sentry.SentryContextManager(),
            logRecordProcessors: [],
            metricReaders: [],
            spanProcessors: [
                new SimpleSpanProcessor(exporter),
                sentryProcessor
            ],
            instrumentations: [
                getNodeAutoInstrumentations({
                    '@opentelemetry/instrumentation-fs': { enabled: false },
                    '@opentelemetry/instrumentation-net': { enabled: false },
                    '@opentelemetry/instrumentation-dns': { enabled: false }
                })
            ]
        })
        sdk.start()
        t.after(async () => {
            await sentryProcessor.forceFlush()
            await Sentry.close(3000)
            await sdk.shutdown()
            context.disable()
            trace.disable()
        })
        const http = require('node:http') as typeof import('node:http')
        const sink = http.createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
                try {
                    let data = Buffer.concat(chunks)
                    if (req.headers['content-encoding'] === 'gzip')
                        data = gunzipSync(data)
                    if (req.headers['content-encoding'] === 'deflate')
                        data = inflateSync(data)
                    const lines = data.toString('utf8').trim().split('\n')
                    for (let i = 1; i < lines.length; i += 2)
                        received.push({
                            type: JSON.parse(lines[i]).type,
                            event: JSON.parse(lines[i + 1])
                        })
                } catch (error) {
                    errors.push(error)
                }
                res.end('{}')
            })
        })
        servers.push(sink)
        await new Promise<void>((resolve) => reservation.close(() => resolve()))
        await listen(sink, sinkPort)
        const upstream = http.createServer((_req, res) => res.end('ok'))
        servers.push(upstream)
        const upstreamPort = await listen(upstream)
        const sensitiveMarker = randomUUID()
        const target = `http://127.0.0.1:${upstreamPort}/sync?customer=${sensitiveMarker}&since=${sensitiveMarker}&key=${sensitiveMarker}#${sensitiveMarker}`
        const httpGet = (url: string): Promise<void> =>
            new Promise((resolve, reject) => {
                http.get(url, (response) => {
                    response.resume()
                    response.on('end', resolve)
                }).on('error', reject)
            })
        for (let i = 0; i < 2; i++) {
            await httpGet(target)
            await (await fetch(target)).text()
        }
        assert.equal(
            Sentry.getIsolationScope()
                .getScopeData()
                .breadcrumbs.filter((crumb) => crumb.type === 'http').length,
            0
        )

        const tracer = trace.getTracer('privacy-integration')
        const rejected = new Error('continuation fixture rejection')
        const rejectedTask = Promise.reject(rejected)
        assert.equal(
            inRequestContinuation(() => rejectedTask, { 'qa.case': 'rejected' }),
            rejectedTask
        )
        await assert.rejects(rejectedTask, (error) => error === rejected)
        const rejectedRoot = exporter
            .getFinishedSpans()
            .find((span) => span.attributes['qa.case'] === 'rejected')
        assert.ok(rejectedRoot)
        assert.equal(rejectedRoot.status.code, SpanStatusCode.ERROR)
        assert.equal(rejectedRoot.parentSpanContext, undefined)
        await Sentry.withIsolationScope(async (parent) => {
            parent.setUser({ id: 'parent-request' })
            parent.setTag('owner', 'parent-request')
            parent.addBreadcrumb({
                category: 'owner',
                message: 'parent-request'
            })
            await Sentry.withScope(async (current) => {
                current.setTag('current-owner', 'parent-request')
                await tracer.startActiveSpan('parent-request', async (span) => {
                    const run = inBackgroundContext(async (id: string) => {
                        assert.deepEqual(
                            Sentry.getIsolationScope().getUser(),
                            {}
                        )
                        assert.equal(
                            Sentry.getIsolationScope().getScopeData().tags
                                .owner,
                            undefined
                        )
                        assert.equal(
                            Sentry.getCurrentScope().getScopeData().tags[
                                'current-owner'
                            ],
                            undefined
                        )
                        assert.equal(
                            Sentry.getIsolationScope().getScopeData()
                                .breadcrumbs.length,
                            0
                        )
                        assert.equal(trace.getActiveSpan(), undefined)
                        Sentry.setUser({ id })
                        Sentry.setTag('owner', id)
                        Sentry.addBreadcrumb({ category: 'owner', message: id })
                        await tracer.startActiveSpan(
                            'background-iteration',
                            async (child) => {
                                try {
                                    await httpGet(target)
                                    await delay(id === 'background-a' ? 15 : 5)
                                    assert.equal(
                                        Sentry.getIsolationScope().getUser()
                                            ?.id,
                                        id
                                    )
                                    Sentry.captureException(
                                        new Error(`privacy-${id}`)
                                    )
                                } finally {
                                    child.end()
                                }
                            }
                        )
                    })
                    try {
                        await Promise.all([
                            run('background-a'),
                            run('background-b')
                        ])
                        await run('background-next')
                        assert.equal(parent.getUser()?.id, 'parent-request')
                        assert.equal(
                            current.getScopeData().tags['current-owner'],
                            'parent-request'
                        )
                    } finally {
                        span.end()
                    }
                })
            })
        })

        let arrivals = 0
        let releaseRequests: () => void = () => {}
        const bothRequests = new Promise<void>((resolve) => {
            releaseRequests = resolve
        })
        let detachedDone: () => void = () => {}
        let continuationTraceId: string | undefined
        let continuationTask: Promise<void> | undefined
        const detached = new Promise<void>((resolve) => {
            detachedDone = resolve
        })
        const app = http.createServer((req, res) => {
            void (async () => {
                const id = req.url === '/user-a' ? 'user-a' : 'user-b'
                production.setSentryRequestContext(id, { owner: id })
                Sentry.getCurrentScope().setTransactionName(`request-${id}`)
                Sentry.addBreadcrumb({ category: 'owner', message: id })
                if (++arrivals === 2) releaseRequests()
                await bothRequests
                await httpGet(target)
                Sentry.captureException(new Error(`privacy-${id}`))
                if (id === 'user-a') {
                    const requestTrace = trace
                        .getActiveSpan()
                        ?.spanContext().traceId
                    continuationTask = inRequestContinuation(
                        async () => {
                            const continuationTrace = trace
                                .getActiveSpan()
                                ?.spanContext().traceId
                            continuationTraceId = continuationTrace
                            assert.ok(requestTrace && continuationTrace)
                            assert.notEqual(continuationTrace, requestTrace)
                            await delay(30)
                            await tracer.startActiveSpan(
                                'continuation-work',
                                async (span) => {
                                    try {
                                        assert.equal(
                                            span.isRecording(),
                                            true,
                                            'continuation work must not inherit an unsampled synthetic parent'
                                        )
                                        await httpGet(target)
                                        Sentry.captureException(
                                            new Error('privacy-detached-user-a')
                                        )
                                    } finally {
                                        span.end()
                                    }
                                }
                            )
                            detachedDone()
                        },
                        {
                            'nca.user_id': id,
                            'nca.message_id': 'continuation-fixture'
                        }
                    )
                    void continuationTask.catch((error) => {
                        errors.push(error)
                        detachedDone()
                    })
                }
                res.end('ok')
            })().catch((error) => {
                errors.push(error)
                res.statusCode = 500
                res.end('failed')
            })
        })
        servers.push(app)
        const appPort = await listen(app)
        await Promise.all([
            httpGet(`http://127.0.0.1:${appPort}/user-a`),
            httpGet(`http://127.0.0.1:${appPort}/user-b`)
        ])
        await detached
        assert.ok(continuationTask)
        await continuationTask
        await sentryProcessor.forceFlush()
        assert.equal(await Sentry.flush(5000), true)
        assert.deepEqual(errors, [])
        const events = received
            .filter((item) => item.type === 'event')
            .map((item) => item.event)
        for (const id of [
            'background-a',
            'background-b',
            'background-next',
            'user-a',
            'user-b',
            'detached-user-a'
        ]) {
            const event = events.find((item) =>
                item.exception?.values?.some(
                    (error) => error.value === `privacy-${id}`
                )
            )
            assert.ok(event, `missing actual envelope for ${id}`)
            const expected = id === 'detached-user-a' ? 'user-a' : id
            assert.equal(event.user?.id, expected)
            assert.equal(event.tags?.owner, expected)
            assert.equal(event.tags?.['current-owner'], undefined)
            assert.deepEqual(
                event.breadcrumbs
                    ?.filter((crumb) => crumb.category === 'owner')
                    .map((crumb) => crumb.message),
                [expected]
            )
            assert.ok(
                event.breadcrumbs?.every((crumb) => crumb.type !== 'http')
            )
            assert.ok(!JSON.stringify(event).includes(sensitiveMarker))
            assert.doesNotMatch(
                JSON.stringify({
                    user: event.user,
                    tags: event.tags,
                    breadcrumbs: event.breadcrumbs,
                    extra: event.extra
                }),
                /parent-request/
            )
            if (id === 'detached-user-a') {
                assert.equal(event.transaction, 'request-user-a')
                assert.equal(
                    event.contexts?.trace?.trace_id,
                    continuationTraceId
                )
            }
        }
        const background = exporter
            .getFinishedSpans()
            .filter((span) => span.name === 'background-iteration')
        assert.equal(background.length, 3)
        assert.ok(background.every((span) => !span.parentSpanContext))
        assert.ok(
            exporter
                .getFinishedSpans()
                .some(
                    (span) =>
                        span.name === 'continuation-work' &&
                        span.spanContext().traceId === continuationTraceId
                ),
            'continuation work must reach the independent exporter'
        )
        const continuationRoot = exporter
            .getFinishedSpans()
            .find(
                (span) =>
                    span.spanContext().traceId === continuationTraceId &&
                    !span.parentSpanContext
            )
        assert.ok(continuationRoot, 'continuation must export a real root span')
        assert.equal(continuationRoot.attributes['nca.user_id'], 'user-a')
        assert.equal(
            continuationRoot.attributes['nca.message_id'],
            'continuation-fixture'
        )
        const continuationTransaction = received.find(
            (item) =>
                item.type === 'transaction' &&
                item.event.contexts?.trace?.trace_id === continuationTraceId
        )
        assert.ok(
            continuationTransaction,
            'continuation must reach Sentry performance export'
        )
        assert.equal(continuationTransaction.event.user?.id, 'user-a')
        const httpSpans = exporter
            .getFinishedSpans()
            .filter((span) => span.kind === 2)
        assert.ok(
            httpSpans.length >= 9,
            'outbound HTTP spans must remain available to the independent exporter'
        )
        assert.ok(
            httpSpans.some((span) =>
                String(
                    span.attributes['url.full'] ?? span.attributes['http.url']
                ).includes(sensitiveMarker)
            ),
            'Sentry hooks must not mutate the independent exporter data'
        )
        assert.ok(
            received.some((item) => item.type === 'transaction'),
            'Sentry performance envelopes must still be delivered'
        )
        for (const item of received.filter(
            (item) => item.type === 'transaction'
        )) {
            assert.ok(
                !JSON.stringify(item.event).includes(sensitiveMarker),
                'query value survives in the transaction envelope'
            )
            assert.ok(
                !JSON.stringify(item.event.spans ?? []).includes(
                    sensitiveMarker
                )
            )
            assert.ok(
                !JSON.stringify(
                    item.event.contexts?.trace?.data ?? {}
                ).includes(sensitiveMarker)
            )
        }
    }
)
