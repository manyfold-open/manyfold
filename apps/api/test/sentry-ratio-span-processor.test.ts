import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Context } from '@opentelemetry/api'
import type {
    ReadableSpan,
    Span,
    SpanProcessor
} from '@opentelemetry/sdk-trace-base'
import {
    SentryRatioSpanProcessor,
    shouldKeepTraceForSentry
} from '../src/common/telemetry/sentry-ratio-span-processor'

const spanWithTrace = (traceId: string): Span =>
    ({ spanContext: () => ({ traceId, spanId: 'aa', traceFlags: 1 }) }) as Span

class RecordingProcessor implements SpanProcessor {
    started: string[] = []
    ended: string[] = []
    ending: string[] = []
    flushed = 0
    didShutdown = false

    async forceFlush(): Promise<void> {
        this.flushed++
    }
    onStart(span: Span, _ctx: Context): void {
        this.started.push(span.spanContext().traceId)
    }
    onEnding(span: Span): void {
        this.ending.push(span.spanContext().traceId)
    }
    onEnd(span: ReadableSpan): void {
        this.ended.push(span.spanContext().traceId)
    }
    async shutdown(): Promise<void> {
        this.didShutdown = true
    }
}

// Real trace ids are 128 random bits. Sequential counters would all collapse
// into the low end of the keyspace and make any ratio look like 100%.
const TRACE_IDS = Array.from({ length: 400 }, (_, i) =>
    createHash('sha256').update(`trace-${i}`).digest('hex').slice(0, 32)
)

test('ratio >= 1 keeps everything', () => {
    for (const id of TRACE_IDS.slice(0, 20))
        assert.equal(shouldKeepTraceForSentry(id, 1), true)
})

test('ratio <= 0 keeps nothing', () => {
    for (const id of TRACE_IDS.slice(0, 20))
        assert.equal(shouldKeepTraceForSentry(id, 0), false)
})

test('the decision is stable for a given trace id', () => {
    // Every span of one trace must reach the same verdict, otherwise Sentry
    // gets a partial tree and orphans the children it never sees a parent for.
    for (const id of TRACE_IDS.slice(0, 50)) {
        const first = shouldKeepTraceForSentry(id, 0.25)
        for (let i = 0; i < 5; i++)
            assert.equal(shouldKeepTraceForSentry(id, 0.25), first)
    }
})

test('a fractional ratio keeps roughly that share of traces', () => {
    const kept = TRACE_IDS.filter((id) =>
        shouldKeepTraceForSentry(id, 0.25)
    ).length
    const share = kept / TRACE_IDS.length
    assert.ok(
        share > 0.15 && share < 0.35,
        `expected ~25% of traces, kept ${(share * 100).toFixed(1)}%`
    )
})

test('a malformed trace id is dropped rather than throwing', () => {
    assert.equal(shouldKeepTraceForSentry('', 0.5), false)
    assert.equal(shouldKeepTraceForSentry('zzzz', 0.5), false)
    assert.equal(shouldKeepTraceForSentry('abc', 0.5), false)
    assert.equal(
        shouldKeepTraceForSentry('z'.repeat(32), 0.5),
        false
    )
})

test('a dropped trace reaches the delegate on neither start nor end', () => {
    // Skipping onEnd alone would leave the span parked in Sentry's pending
    // buckets; both hooks have to agree.
    const delegate = new RecordingProcessor()
    const processor = new SentryRatioSpanProcessor(delegate, 0)
    const span = spanWithTrace(TRACE_IDS[7])

    processor.onStart(span, {} as Context)
    processor.onEnding(span)
    processor.onEnd(span as unknown as ReadableSpan)

    assert.deepEqual(delegate.started, [])
    assert.deepEqual(delegate.ending, [])
    assert.deepEqual(delegate.ended, [])
})

test('a kept trace is forwarded on every hook', () => {
    const delegate = new RecordingProcessor()
    const processor = new SentryRatioSpanProcessor(delegate, 1)
    const span = spanWithTrace(TRACE_IDS[7])

    processor.onStart(span, {} as Context)
    processor.onEnding(span)
    processor.onEnd(span as unknown as ReadableSpan)

    assert.deepEqual(delegate.started, [TRACE_IDS[7]])
    assert.deepEqual(delegate.ending, [TRACE_IDS[7]])
    assert.deepEqual(delegate.ended, [TRACE_IDS[7]])
})

test('flush and shutdown always reach the delegate', () => {
    // finalizeExit relies on forceFlush getting through even at ratio 0.
    const delegate = new RecordingProcessor()
    const processor = new SentryRatioSpanProcessor(delegate, 0)

    return Promise.all([processor.forceFlush(), processor.shutdown()]).then(
        () => {
            assert.equal(delegate.flushed, 1)
            assert.equal(delegate.didShutdown, true)
        }
    )
})