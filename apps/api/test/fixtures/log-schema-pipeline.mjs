import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('tsconfig-paths/register')
const { otel, flushOtelLogs, flushSentrySpans } = require('../../src/otel.ts')
const { trace } = require('@opentelemetry/api')
const {
    TelemetryService
} = require('../../src/common/telemetry/telemetry.service.ts')
const {
    OtelNestLogger
} = require('../../src/common/telemetry/otel-nest-logger.ts')
const { emitProcessExit } = require('../../src/process-lifecycle.ts')
const { captureApiException, flushSentry } = require('../../src/sentry.ts')

const telemetry = new TelemetryService()
const logger = new OtelNestLogger()
const metrics = {
    candidates: 2,
    checked: 2,
    pending: 0,
    failures: 0,
    providerCalls: 1,
    items: 2,
    duplicates: 1,
    confirmed: 1,
    noChanges: 0,
    completed: 1
}
const tracer = trace.getTracer('log-schema-fixture')
tracer.startActiveSpan('fixture.scan', (span) => {
    span.setAttributes(metrics)
    telemetry.event('fixture.scan', {
        ...metrics,
        durationMs: 7,
        recheckMs: 60_000
    })
    logger.log({ message: 'ordinary fixture', nested: { ok: true } }, 'Fixture')
    const child = tracer.startSpan('fixture.child')
    child.end()
    const error = new Error('fixture failure token=synthetic-private')
    captureApiException(error)
    emitProcessExit({
        reason: 'uncaught_exception',
        shutdownOutcome: 'fatal',
        exitCode: 1,
        durationMs: 7,
        errorClass: 'Error',
        errorMessage: error.message,
        stack: error.stack
    })
    span.end()
})
await flushOtelLogs()
require('@opentelemetry/api-logs')
    .logs.getLogger('structured-fixture')
    .emit({
        body: 'fixture.structured',
        attributes: {
            context: { nested: true },
            durationMs: [1, 2, 3],
            custom: {
                context: 'cannot overwrite',
                nested: { token: 'synthetic-private' }
            },
            arbitrary: [
                7,
                false,
                null,
                { authorization: 'Bearer synthetic-private' }
            ]
        }
    })
await flushOtelLogs()
await flushSentrySpans()
await flushSentry(2000)
await otel.shutdown()
