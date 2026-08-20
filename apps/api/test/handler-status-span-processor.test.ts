import test from 'node:test'
import assert from 'node:assert/strict'
import { SpanStatusCode } from '@opentelemetry/api'
import { AttributeNames } from '@opentelemetry/instrumentation-nestjs-core'
import { tracing } from '@opentelemetry/sdk-node'
import { HandlerStatusSpanProcessor } from '../src/common/telemetry/handler-status-span-processor'

const exportedStatus = async (
    nestType: string,
    initialStatus: SpanStatusCode
): Promise<SpanStatusCode> => {
    const exporter = new tracing.InMemorySpanExporter()
    const provider = new tracing.BasicTracerProvider({
        spanProcessors: [
            new HandlerStatusSpanProcessor(),
            new tracing.SimpleSpanProcessor(exporter)
        ]
    })
    const span = provider.getTracer('test').startSpan('test', {
        attributes: { [AttributeNames.TYPE]: nestType }
    })
    if (initialStatus !== SpanStatusCode.UNSET)
        span.setStatus({ code: initialStatus })
    span.end()
    await provider.forceFlush()
    return exporter.getFinishedSpans()[0].status.code
}

test('marks successful Nest handlers as OK before export', async () => {
    assert.equal(
        await exportedStatus('handler', SpanStatusCode.UNSET),
        SpanStatusCode.OK
    )
})

test('preserves handler errors', async () => {
    assert.equal(
        await exportedStatus('handler', SpanStatusCode.ERROR),
        SpanStatusCode.ERROR
    )
})

test('leaves non-handler Nest spans unchanged', async () => {
    assert.equal(
        await exportedStatus('request_context', SpanStatusCode.UNSET),
        SpanStatusCode.UNSET
    )
})
