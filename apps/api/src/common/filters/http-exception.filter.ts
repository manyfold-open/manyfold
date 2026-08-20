import { apiError } from '@manyfold/shared'
import {
    Catch,
    HttpException,
    HttpStatus,
    Logger,
    type ArgumentsHost,
    type ExceptionFilter
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { setHttpResponseStatus } from '@/common/telemetry/http-span'
import { redactSensitiveUrlQuery } from '@/common/telemetry/redact-url'

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger('HttpExceptionFilter')

    // main.ts passes Sentry's captureException; the default keeps this module
    // (and its unit tests) free of the telemetry graph.
    constructor(
        private readonly capture: (
            exception: unknown,
            extra?: Record<string, unknown>
        ) => void = () => {}
    ) {}

    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp()
        const res = ctx.getResponse<FastifyReply>()

        if (exception instanceof HttpException) {
            const status = exception.getStatus()
            const body = exception.getResponse()
            if (status >= 500)
                // HttpException serializes to just its message in Sentry; the
                // typed response body (code/reason/details) is where throw
                // sites put the actual failure — losing it made events like
                // 'daemon detach failed' undiagnosable (#551).
                this.capture(
                    exception,
                    typeof body === 'object' && body !== null
                        ? { response: body as Record<string, unknown> }
                        : undefined
                )
            setHttpResponseStatus(trace.getActiveSpan(), status)
            const message =
                typeof body === 'string'
                    ? body
                    : ((body as any)?.message ?? exception.message)
            const code =
                typeof body === 'object' &&
                body !== null &&
                typeof (body as any).code === 'string' &&
                (body as any).code.length > 0
                    ? (body as any).code
                    : this.codeFromStatus(status)
            const details =
                typeof body === 'object' && body !== null
                    ? (body as any).details
                    : undefined
            if (
                typeof body === 'object' &&
                body !== null &&
                typeof (body as any).retryAfterSec === 'number'
            ) {
                res.header(
                    'Retry-After',
                    String((body as any).retryAfterSec)
                )
            }
            res.status(status).send(apiError(code, String(message), details))
            return
        }

        const span = trace.getActiveSpan()
        if (span) {
            setHttpResponseStatus(span, HttpStatus.INTERNAL_SERVER_ERROR)
            span.recordException(exception as Error)
            span.setStatus({ code: SpanStatusCode.ERROR })
        }
        this.capture(exception)
        this.logger.error('unhandled', exception as Error)
        // Deliberate: the caller sees the real failure text (including
        // internals like SQL constraint names) — the endpoint is
        // authenticated and the data is the caller's own, while a literal
        // 'Internal server error' is undebuggable from the CLI side.
        // redactSensitiveUrlQuery scrubs key/env/cmd query values when the
        // message parses as a URL; its non-URL regex fallback only covers
        // `key=`.
        const raw =
            exception instanceof Error
                ? exception.message
                : String(exception)
        const message = redactSensitiveUrlQuery(
            raw || 'Internal server error'
        )
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).send(
            apiError('internal_error', message, {
                kind:
                    exception instanceof Error
                        ? exception.constructor.name
                        : typeof exception,
                traceId: span?.spanContext().traceId
            })
        )
    }

    private codeFromStatus(status: number): string {
        if (status === 401) return 'unauthorized'
        if (status === 403) return 'forbidden'
        if (status === 404) return 'not_found'
        if (status === 422) return 'unprocessable'
        if (status >= 500) return 'internal_error'
        return 'bad_request'
    }
}
