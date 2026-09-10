import type { Context } from '@opentelemetry/api'
import type { LogBody, LogAttributes } from '@opentelemetry/api-logs'
import type { LogRecordProcessor, SdkLogRecord } from '@opentelemetry/sdk-logs'
import { tracing } from '@opentelemetry/sdk-node'
import {
    redactCredentialText,
    redactCredentialValue
} from './redact-credentials'

const sanitizeAttributes = (attributes: Record<string, unknown>): void => {
    const safe = redactCredentialValue(attributes) as Record<string, unknown>
    for (const key of Object.keys(attributes)) {
        if (key in safe) attributes[key] = safe[key]
        else delete attributes[key]
    }
}

export class CredentialRedactionSpanProcessor
    extends tracing.NoopSpanProcessor
{
    onEnding(span: tracing.Span): void {
        // The SDK calls this while the span is mutable, before either exporter
        // observes it. Scrub event/link attributes as well as the span itself.
        sanitizeAttributes(span.attributes)
        span.updateName(redactCredentialText(span.name))
        if (span.status.message)
            span.setStatus({
                ...span.status,
                message: redactCredentialText(span.status.message)
            })
        for (const event of span.events) {
            event.name = redactCredentialText(event.name)
            if (event.attributes) sanitizeAttributes(event.attributes)
        }
        for (const link of span.links)
            if (link.attributes) sanitizeAttributes(link.attributes)
    }
}

export class CredentialRedactionLogProcessor implements LogRecordProcessor {
    constructor(private readonly delegate: LogRecordProcessor) {}

    onEmit(record: SdkLogRecord, context?: Context): void {
        if (record.body !== undefined)
            record.setBody(redactCredentialValue(record.body) as LogBody)
        sanitizeAttributes(record.attributes as LogAttributes)
        if (record.eventName)
            record.setEventName(redactCredentialText(record.eventName))
        this.delegate.onEmit(record, context)
    }

    forceFlush(): Promise<void> {
        return this.delegate.forceFlush()
    }
    shutdown(): Promise<void> {
        return this.delegate.shutdown()
    }
}
