import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

test('the actual telemetry bootstrap scrubs console, OTLP and Sentry payloads', async (t) => {
    const secret = 'sentinel-export-private/+='
    const encoded = encodeURIComponent(secret)
    const received: Array<{ path: string; body: string }> = []
    const collector = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        request.on('end', () => {
            const raw = Buffer.concat(chunks)
            received.push({
                path: request.url ?? '',
                body: (request.headers['content-encoding'] === 'gzip'
                    ? gunzipSync(raw)
                    : raw
                ).toString('utf8')
            })
            response.setHeader('content-type', 'application/json')
            response.end('{}')
        })
    })
    await new Promise<void>((resolve) =>
        collector.listen(0, '127.0.0.1', resolve)
    )
    t.after(async () => {
        collector.closeAllConnections()
        await new Promise<void>((resolve) => collector.close(() => resolve()))
    })
    const address = collector.address()
    assert(address && typeof address === 'object')
    const endpoint = `http://127.0.0.1:${address.port}`
    const child = String.raw`
        const { otel, otelEventsLogger, flushOtelLogs, flushSentrySpans } = require('./src/otel.ts')
        const { captureApiException, flushSentry } = require('./src/sentry.ts')
        const { OtelNestLogger } = require('./src/common/telemetry/otel-nest-logger.ts')
        const { trace, diag } = require('@opentelemetry/api')
        const http = require('node:http')
        const secret = process.env.MF_TEST_CREDENTIAL
        const url = 'wss://api.test/api/daemon/ws?to%6ben=' + encodeURIComponent(secret)
        const logger = new OtelNestLogger()
        const error = new Error('runner failure ' + url)
        logger.error(error, { token: secret, detail: url }, 'RunnerManagerService')
        otelEventsLogger().emit({ body: 'direct event ' + url, attributes: { token: secret, detail: url } })
        diag.warn('credential diagnostic ' + url, { Authorization: 'Bearer ' + secret })
        captureApiException(error, { token: secret, url })
        const server = http.createServer((request, response) => {
            const span = trace.getActiveSpan()
            span?.setAttributes({ 'url.full': url, 'url.query': 'token=' + secret, detail: url })
            span?.recordException(error)
            response.end('ok')
        })
        ;(async () => {
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
            await new Promise((resolve, reject) => {
                http.get('http://127.0.0.1:' + server.address().port + '/probe?token=' + encodeURIComponent(secret),
                    response => { response.resume(); response.once('end', resolve) }).once('error', reject)
            })
            await new Promise(resolve => server.close(resolve))
            await flushOtelLogs()
            await flushSentrySpans()
            await flushSentry(3000)
            await otel.shutdown()
        })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '-e', child],
        {
            cwd: process.cwd(),
            timeout: 30_000,
            env: {
                ...process.env,
                FLY_APP_NAME: 'fixture-api',
                AXIOM_API_TOKEN: 'fixture-ingest-token',
                AXIOM_DATASET: 'fixture',
                OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
                OTEL_RESOURCE_ATTRIBUTES: '',
                OTEL_SDK_DISABLED: 'false',
                OTEL_LOG_LEVEL: 'warn',
                SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
                SENTRY_TRACES_SAMPLE_RATE: '1',
                MF_DEPLOY_ENV: 'test',
                MF_TEST_CREDENTIAL: secret
            }
        }
    )
    assert(
        received.some((r) => r.path === '/v1/logs'),
        'the real OTLP log exporter must deliver'
    )
    assert(
        received.some((r) => r.path === '/v1/traces'),
        'the real OTLP span exporter must deliver'
    )
    assert(
        received.some((r) => r.path.startsWith('/api/1/envelope')),
        'the real Sentry client must deliver'
    )
    const output = stdout + stderr + received.map((r) => r.body).join('\n')
    assert(output.includes('runner failure'), 'diagnostic content must survive')
    assert(!output.includes(secret), 'raw credential reached a real sink')
    assert(!output.includes(encoded), 'encoded credential reached a real sink')
    for (const record of received.filter((r) => r.path === '/v1/traces')) {
        const body = JSON.parse(record.body)
        const spans = body.resourceSpans.flatMap(
            (resource: {
                scopeSpans: Array<{
                    spans: Array<{ attributes?: Array<{ key: string }> }>
                }>
            }) => resource.scopeSpans.flatMap((scope) => scope.spans)
        )
        assert(spans.length > 0)
        assert(
            spans.every(
                (span: { attributes?: Array<{ key: string }> }) =>
                    !span.attributes?.some(
                        (attribute) => attribute.key === 'url.query'
                    )
            )
        )
    }
})
