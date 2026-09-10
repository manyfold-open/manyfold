import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { ConsoleLogger } from '@nestjs/common'
import { logs } from '@opentelemetry/api-logs'
import { SpanStatusCode } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
    InMemorySpanExporter,
    SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import {
    InMemoryLogRecordExporter,
    LoggerProvider,
    SimpleLogRecordProcessor
} from '@opentelemetry/sdk-logs'
import {
    CredentialRedactionLogProcessor,
    CredentialRedactionSpanProcessor
} from '../src/common/telemetry/credential-redaction-processors'
import { OtelNestLogger } from '../src/common/telemetry/otel-nest-logger'

const secret = 'sentinel-private/+='
const encoded = encodeURIComponent(secret)
const url = `wss://api.test/api/daemon/ws?token=${encoded}&state=ready`
const assertScrubbed = (value: unknown): void => {
    const text = JSON.stringify(value)
    assert(!text.includes(secret), 'raw credential reaches an exporter')
    assert(!text.includes(encoded), 'encoded credential reaches an exporter')
}

test('all Nest levels scrub before console and OTLP, including detail and Error stack', async (t) => {
    const exporter = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider({
        processors: [
            new CredentialRedactionLogProcessor(
                new SimpleLogRecordProcessor(exporter)
            )
        ]
    })
    logs.setGlobalLoggerProvider(provider)
    t.after(async () => {
        await provider.shutdown()
        logs.disable()
    })
    const consoleOutput: unknown[] = []
    const levels = [
        'log',
        'warn',
        'error',
        'debug',
        'verbose',
        'fatal'
    ] as const
    for (const level of levels)
        t.mock.method(ConsoleLogger.prototype, level, (...args: unknown[]) => {
            consoleOutput.push(args)
        })
    const logger = new OtelNestLogger()
    for (const level of levels)
        logger[level](
            new Error(`runner ${url}`),
            { detail: url, token: secret },
            'RunnerManagerService'
        )
    provider.getLogger('direct-event').emit({
        body: { url, headers: { authorization: `Bearer ${secret}` } },
        attributes: { 'url.query': `token=${encoded}`, detail: url }
    })
    await provider.forceFlush()
    assert.equal(consoleOutput.length, 6)
    assertScrubbed(consoleOutput)
    const records = exporter.getFinishedLogRecords()
    assert.equal(records.length, 7)
    assertScrubbed(records)
    assert(
        records
            .slice(0, 6)
            .every((r) => r.attributes.context === 'RunnerManagerService')
    )
    assert(records.every((r) => !('url.query' in r.attributes)))
})

test('real HTTP instrumentation exports no credential query, header, exception or custom attribute', async (t) => {
    const exporter = new InMemorySpanExporter()
    const processor = new SimpleSpanProcessor(exporter)
    const sdk = new NodeSDK({
        autoDetectResources: false,
        logRecordProcessors: [],
        metricReaders: [],
        spanProcessors: [
            new CredentialRedactionSpanProcessor(),
            processor
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
    const require = createRequire(__filename)
    const http = require('node:http') as typeof import('node:http')
    const { trace } =
        require('@opentelemetry/api') as typeof import('@opentelemetry/api')
    const server = http.createServer((_req, res) => {
        const span = trace.getActiveSpan()
        span?.setAttributes({
            'url.query': `token=${encoded}`,
            'url.full': url,
            'http.request.header.authorization': `Bearer ${secret}`,
            detail: `runner tail ${url}`
        })
        span?.recordException(new Error(`upstream ${url}`))
        span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: `failed ${url}`
        })
        res.end('ok')
    })
    t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await sdk.shutdown()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    await new Promise<void>((resolve, reject) => {
        http.get(
            `http://127.0.0.1:${address.port}/api/daemon/ws?to%6ben=${encoded}&token=${encoded}`,
            {
                headers: { Authorization: `Bearer ${secret}` }
            },
            (response) => {
                response.resume()
                response.once('end', resolve)
            }
        ).once('error', reject)
    })
    await processor.forceFlush()
    const spans = exporter.getFinishedSpans()
    assert(
        spans.some((s) => s.kind === 1),
        'a real HTTP server span must be exported'
    )
    assert(
        spans.some((s) => s.kind === 2),
        'a real HTTP client span must be exported'
    )
    for (const span of spans) {
        assertScrubbed({
            attributes: span.attributes,
            events: span.events,
            status: span.status
        })
        assert(!('url.query' in span.attributes))
    }
})
