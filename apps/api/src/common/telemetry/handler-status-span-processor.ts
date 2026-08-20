import { SpanStatusCode } from '@opentelemetry/api'
import { AttributeNames } from '@opentelemetry/instrumentation-nestjs-core'
import { tracing } from '@opentelemetry/sdk-node'

const NEST_HANDLER_TYPE = 'handler'

export class HandlerStatusSpanProcessor extends tracing.NoopSpanProcessor {
    onEnding(span: tracing.Span): void {
        // Nest only marks thrown handlers as ERROR; onEnding is the last
        // mutable point where normal UNSET spans can become explicit successes.
        if (span.attributes[AttributeNames.TYPE] !== NEST_HANDLER_TYPE) return
        if (span.status.code !== SpanStatusCode.UNSET) return
        span.setStatus({ code: SpanStatusCode.OK })
    }
}
