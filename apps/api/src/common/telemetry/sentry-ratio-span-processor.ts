import type { Context } from '@opentelemetry/api'
import type {
    ReadableSpan,
    Span,
    SpanProcessor
} from '@opentelemetry/sdk-trace-base'

const TRACE_ID_SPACE = 2 ** 32

// Same accumulation as OTel's TraceIdRatioBasedSampler, applied per span
// instead of at sampling time: the shared provider must keep sampling
// everything so Axiom still receives 100% of spans.
const accumulate = (traceId: string): number => {
    let accumulation = 0
    for (let i = 0; i < traceId.length / 8; i++) {
        const pos = i * 8
        const part = Number.parseInt(traceId.slice(pos, pos + 8), 16)
        if (!Number.isFinite(part)) return TRACE_ID_SPACE
        accumulation = (accumulation ^ part) >>> 0
    }
    return accumulation
}

const TRACE_ID_LENGTH = 32

export const shouldKeepTraceForSentry = (
    traceId: string,
    ratio: number
): boolean => {
    if (ratio >= 1) return true
    if (ratio <= 0) return false
    // No well-formed id means no stable decision, and a trace that answers
    // differently per span would reach Sentry as an orphaned fragment.
    if (traceId.length !== TRACE_ID_LENGTH) return false
    return accumulate(traceId) < ratio * TRACE_ID_SPACE
}

export class SentryRatioSpanProcessor implements SpanProcessor {
    constructor(
        private readonly delegate: SpanProcessor,
        private readonly ratio: number
    ) {}

    private keeps(span: ReadableSpan | Span): boolean {
        return shouldKeepTraceForSentry(
            span.spanContext().traceId,
            this.ratio
        )
    }

    forceFlush(): Promise<void> {
        return this.delegate.forceFlush()
    }

    onStart(span: Span, parentContext: Context): void {
        if (this.keeps(span)) this.delegate.onStart(span, parentContext)
    }

    onEnding(span: Span): void {
        if (this.keeps(span)) this.delegate.onEnding?.(span)
    }

    onEnd(span: ReadableSpan): void {
        if (this.keeps(span)) this.delegate.onEnd(span)
    }

    shutdown(): Promise<void> {
        return this.delegate.shutdown()
    }
}