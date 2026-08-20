import { Injectable, Logger } from '@nestjs/common'
import {
    SeverityNumber,
    type Logger as OtelLogger,
    type LogAttributes
} from '@opentelemetry/api-logs'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { otelEventsLogger } from '@/otel'
import { captureTelemetryError } from '@/sentry'

type EventAttrs = Record<string, string | number | boolean | null | undefined>

const sanitize = (attrs: EventAttrs): LogAttributes => {
    const out: LogAttributes = {}
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null) continue
        out[key] = value as LogAttributes[string]
    }
    return out
}

@Injectable()
export class TelemetryService {
    private readonly fallback = new Logger('Telemetry')
    private readonly otel: OtelLogger | undefined = otelEventsLogger()

    event(name: string, attrs: EventAttrs = {}): void {
        const safe = sanitize(attrs)
        const ctx = trace.getActiveSpan()?.spanContext()
        if (ctx) {
            safe['trace_id'] = ctx.traceId
            safe['span_id'] = ctx.spanId
        }

        if (this.otel) {
            this.otel.emit({
                severityNumber: SeverityNumber.INFO,
                severityText: 'INFO',
                body: name,
                attributes: { 'nca.event': name, ...safe }
            })
        } else {
            this.fallback.log(`${name} ${JSON.stringify(safe)}`)
        }

        const span = trace.getActiveSpan()
        if (span && span.isRecording()) {
            const eventAttrs: Record<string, string> = {}
            for (const [k, v] of Object.entries(safe)) {
                eventAttrs[k] = String(v)
            }
            span.addEvent(name, eventAttrs)
        }
    }

    error(name: string, err: Error, attrs: EventAttrs = {}): void {
        this.event(name, {
            ...attrs,
            errorClass: err.name,
            errorMessage: err.message
        })
        const span = trace.getActiveSpan()
        if (span && span.isRecording()) {
            span.recordException(err)
            span.setStatus({ code: SpanStatusCode.ERROR })
        }
        captureTelemetryError(name, err, sanitize(attrs))
    }
}
