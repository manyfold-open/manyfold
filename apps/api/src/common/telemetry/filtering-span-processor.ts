import type { Context } from '@opentelemetry/api'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import type {
    ReadableSpan,
    Span,
    SpanProcessor
} from '@opentelemetry/sdk-trace-base'

type FilterableSpan = Pick<
    ReadableSpan,
    | 'attributes'
    | 'events'
    | 'instrumentationScope'
    | 'kind'
    | 'name'
    | 'status'
>

export const isFastifyMiddlewareSpan = (span: FilterableSpan): boolean =>
    span.kind === SpanKind.INTERNAL &&
    span.instrumentationScope.name ===
        '@opentelemetry/instrumentation-fastify' &&
    span.attributes['fastify.type'] === 'middleware' &&
    span.status.code !== SpanStatusCode.ERROR &&
    !span.events.some((event) => event.name === 'exception')

export class FilteringSpanProcessor implements SpanProcessor {
    constructor(
        private readonly delegate: SpanProcessor,
        private readonly shouldDrop: (span: FilterableSpan) => boolean
    ) {}

    forceFlush(): Promise<void> {
        return this.delegate.forceFlush()
    }

    onStart(span: Span, parentContext: Context): void {
        this.delegate.onStart(span, parentContext)
    }

    onEnding(span: Span): void {
        if (!this.shouldDrop(span)) this.delegate.onEnding?.(span)
    }

    onEnd(span: ReadableSpan): void {
        if (!this.shouldDrop(span)) this.delegate.onEnd(span)
    }

    shutdown(): Promise<void> {
        return this.delegate.shutdown()
    }
}
