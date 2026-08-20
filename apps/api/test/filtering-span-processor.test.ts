import test from 'node:test'
import assert from 'node:assert/strict'
import { context, SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type {
    ReadableSpan,
    Span,
    SpanProcessor
} from '@opentelemetry/sdk-trace-base'
import {
    FilteringSpanProcessor,
    isFastifyMiddlewareSpan
} from '../src/common/telemetry/filtering-span-processor'

const span = (overrides: Partial<ReadableSpan> = {}): ReadableSpan =>
    ({
        name: 'middleware - fastify',
        kind: SpanKind.INTERNAL,
        attributes: { 'fastify.type': 'middleware' },
        status: { code: SpanStatusCode.UNSET },
        events: [],
        instrumentationScope: {
            name: '@opentelemetry/instrumentation-fastify'
        },
        ...overrides
    }) as ReadableSpan

test('identifies only Fastify middleware spans as noise', () => {
    assert.equal(isFastifyMiddlewareSpan(span()), true)
    assert.equal(
        isFastifyMiddlewareSpan(
            span({
                name: 'request handler - handler',
                attributes: { 'fastify.type': 'request_handler' }
            })
        ),
        false
    )
    assert.equal(
        isFastifyMiddlewareSpan(
            span({
                instrumentationScope: {
                    name: '@opentelemetry/instrumentation-nestjs-core'
                }
            })
        ),
        false
    )
    assert.equal(
        isFastifyMiddlewareSpan(span({ kind: SpanKind.SERVER })),
        false
    )
    assert.equal(
        isFastifyMiddlewareSpan(
            span({ status: { code: SpanStatusCode.ERROR } })
        ),
        false
    )
    assert.equal(
        isFastifyMiddlewareSpan(
            span({
                events: [
                    {
                        name: 'exception',
                        time: [0, 0],
                        attributes: {}
                    }
                ]
            })
        ),
        false
    )
})

test('filtering processor drops noise and delegates lifecycle methods', async () => {
    const ended: string[] = []
    let started = 0
    let flushed = 0
    let shutDown = 0
    const delegate: SpanProcessor = {
        onStart: () => {
            started += 1
        },
        onEnd: (endedSpan) => {
            ended.push(endedSpan.name)
        },
        forceFlush: async () => {
            flushed += 1
        },
        shutdown: async () => {
            shutDown += 1
        }
    }
    const processor = new FilteringSpanProcessor(
        delegate,
        isFastifyMiddlewareSpan
    )
    const middleware = span()
    const handler = span({
        name: 'request handler - handler',
        attributes: { 'fastify.type': 'request_handler' }
    })

    processor.onStart(handler as Span, context.active())
    processor.onEnd(middleware)
    processor.onEnd(handler)
    await processor.forceFlush()
    await processor.shutdown()

    assert.equal(started, 1)
    assert.deepEqual(ended, ['request handler - handler'])
    assert.equal(flushed, 1)
    assert.equal(shutDown, 1)
})
