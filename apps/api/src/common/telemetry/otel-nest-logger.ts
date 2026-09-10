import {
    ConsoleLogger,
    type LogLevel,
    type LoggerService
} from '@nestjs/common'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { trace } from '@opentelemetry/api'
import {
    redactCredentialText,
    redactCredentialValue
} from './redact-credentials'

const severityFor = (
    level: LogLevel
): { number: SeverityNumber; text: string } => {
    switch (level) {
        case 'error':
        case 'fatal':
            return { number: SeverityNumber.ERROR, text: 'ERROR' }
        case 'warn':
            return { number: SeverityNumber.WARN, text: 'WARN' }
        case 'debug':
            return { number: SeverityNumber.DEBUG, text: 'DEBUG' }
        case 'verbose':
            return { number: SeverityNumber.TRACE, text: 'TRACE' }
        default:
            return { number: SeverityNumber.INFO, text: 'INFO' }
    }
}

const stringify = (value: unknown): string => {
    if (value === undefined || value === null) return ''
    if (value instanceof Error) return value.stack ?? value.message
    if (typeof value === 'string') return value
    try {
        const json = JSON.stringify(value)
        return json ?? String(value)
    } catch {
        return String(value)
    }
}

export class OtelNestLogger extends ConsoleLogger implements LoggerService {
    private readonly otel = logs.getLogger('manyfold-api')

    log(message: unknown, ...rest: unknown[]): void {
        this.write('log', message, rest)
    }

    warn(message: unknown, ...rest: unknown[]): void {
        this.write('warn', message, rest)
    }

    error(message: unknown, ...rest: unknown[]): void {
        this.write('error', message, rest)
    }

    debug(message: unknown, ...rest: unknown[]): void {
        this.write('debug', message, rest)
    }

    verbose(message: unknown, ...rest: unknown[]): void {
        this.write('verbose', message, rest)
    }

    fatal(message: unknown, ...rest: unknown[]): void {
        this.write('fatal', message, rest)
    }

    private write(level: LogLevel, message: unknown, rest: unknown[]): void {
        const safeMessage = redactCredentialValue(message)
        const safeRest = rest.map(redactCredentialValue)
        super[level](safeMessage as never, ...(safeRest as never[]))
        this.emit(level, safeMessage, safeRest)
    }

    private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
        const severity = severityFor(level)
        const span = trace.getActiveSpan()
        const ctx = span?.spanContext()

        const last = rest[rest.length - 1]
        const context =
            typeof last === 'string'
                ? last
                : ((message as { context?: string })?.context ?? undefined)

        const stackOrExtra = rest
            .slice(0, context === last ? -1 : undefined)
            .map(stringify)
            .filter((s) => s.length > 0)

        const attributes: Record<string, string> = {}
        if (context) attributes.context = context
        if (stackOrExtra.length > 0) attributes.detail = stackOrExtra.join('\n')
        if (ctx) {
            attributes['trace_id'] = ctx.traceId
            attributes['span_id'] = ctx.spanId
        }

        this.otel.emit({
            severityNumber: severity.number,
            severityText: severity.text,
            body: redactCredentialText(stringify(message)),
            attributes
        })
    }
}
