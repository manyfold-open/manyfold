import 'tsconfig-paths/register'
import type { IncomingMessage, ServerResponse } from 'node:http'

try {
    ;(
        process as unknown as { loadEnvFile?: (path?: string) => void }
    ).loadEnvFile?.()
} catch {
    // .env not present (e.g. fly.io) — env vars come from the host
}

// Axiom does not accept OTLP metrics on the same endpoint; auto-instrumentations
// would otherwise spawn a PeriodicExportingMetricReader pointed at /v1/metrics
// and spam 401s. Disable unless the operator explicitly opts in.
process.env.OTEL_METRICS_EXPORTER = process.env.OTEL_METRICS_EXPORTER ?? 'none'

// Must be initialised before the NodeSDK is constructed so that Sentry's
// context manager is the one this SDK registers globally.
import { sentryEnabled, sentryTracesSampleRate } from './sentry'
import * as Sentry from '@sentry/node'
import { SentrySpanProcessor } from '@sentry/opentelemetry'
import {
    diag,
    DiagConsoleLogger,
    DiagLogLevel,
    type Span
} from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
    BatchSpanProcessor,
    type SpanProcessor
} from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import {
    BatchLogRecordProcessor,
    type LogRecordProcessor
} from '@opentelemetry/sdk-logs'
import { logs, type Logger as OtelLogger } from '@opentelemetry/api-logs'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION
} from '@opentelemetry/semantic-conventions'
import { resolveOtelConfig } from './otel-config'
import { runFlushStage } from './flush-stage'
import {
    setHttpResponseStatus,
    setHttpServerRequestAttributes
} from './common/telemetry/http-span'
import {
    FilteringSpanProcessor,
    isFastifyMiddlewareSpan
} from './common/telemetry/filtering-span-processor'
import { HandlerStatusSpanProcessor } from './common/telemetry/handler-status-span-processor'
import { SentryRatioSpanProcessor } from './common/telemetry/sentry-ratio-span-processor'
import {
    redactedQueryString,
    redactSensitiveUrlQuery
} from './common/telemetry/redact-url'

const otelConfig = resolveOtelConfig()
const {
    endpoint,
    token,
    dataset,
    serviceName,
    serviceVersion,
    deploymentEnvironment,
    enabled
} = otelConfig

const buildHeaders = (targetDataset: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    'X-Axiom-Dataset': targetDataset
})

const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'deployment.environment': deploymentEnvironment,
    'deployment.environment.name': deploymentEnvironment
})

const traceExporter = enabled
    ? new OTLPTraceExporter({
          url: `${endpoint}/v1/traces`,
          headers: buildHeaders(dataset)
      })
    : undefined

const spanProcessors: SpanProcessor[] = []
if (traceExporter || sentryEnabled)
    spanProcessors.push(new HandlerStatusSpanProcessor())
if (traceExporter)
    spanProcessors.push(
        new FilteringSpanProcessor(
            new BatchSpanProcessor(traceExporter),
            isFastifyMiddlewareSpan
        )
    )
// Deliberately unfiltered: Sentry rebuilds transactions from the span tree, so
// dropping a middle span would orphan its children in the exporter's pending
// buckets. Volume is controlled by whole-trace ratio sampling instead.
const sentrySpanProcessor = sentryEnabled
    ? new SentryRatioSpanProcessor(
          new SentrySpanProcessor(),
          sentryTracesSampleRate
      )
    : undefined
if (sentrySpanProcessor) spanProcessors.push(sentrySpanProcessor)

// SentrySpanProcessor.shutdown() discards whatever is still pending instead of
// flushing it, so finished spans have to be pushed to the client before the SDK
// is torn down or every restart silently loses its last transactions.
export const flushSentrySpans = async (): Promise<void> => {
    if (!sentrySpanProcessor) return
    await runFlushStage(() => sentrySpanProcessor.forceFlush())
}

// The process.exit record is one already-emitted log record; flushing the
// logger provider directly, ahead of any span work, gives it the best odds of
// leaving before process.exit (#528). NodeSDK.start() registers its
// LoggerProvider globally, but the api-logs type omits the SDK provider's
// forceFlush, hence the narrowing.
export const flushOtelLogs = async (): Promise<void> => {
    const provider = logs.getLoggerProvider() as {
        forceFlush?: () => Promise<void>
    }
    const forceFlush = provider.forceFlush?.bind(provider)
    if (!forceFlush) return
    await runFlushStage(forceFlush)
}

const defaultLogProcessor: LogRecordProcessor | undefined = enabled
    ? new BatchLogRecordProcessor(
          new OTLPLogExporter({
              url: `${endpoint}/v1/logs`,
              headers: buildHeaders(dataset)
          })
      )
    : undefined

export const otelEventsLogger = (): OtelLogger | undefined =>
    enabled ? logs.getLogger('nca-events') : undefined

const statusCodeFromResponse = (
    response: IncomingMessage | ServerResponse
): number | undefined =>
    typeof response.statusCode === 'number' ? response.statusCode : undefined

const redactSpanUrl = (span: Span, raw: string): void => {
    const redacted = redactSensitiveUrlQuery(raw)
    if (redacted === raw) return
    span.setAttribute('url.full', redacted)
    const query = redactedQueryString(redacted)
    if (query !== null) span.setAttribute('url.query', query)
}

export const otel = new NodeSDK({
    resource,
    spanProcessors,
    logRecordProcessors: defaultLogProcessor ? [defaultLogProcessor] : [],
    // Sentry's context manager forks Sentry scopes per OTel context, which is
    // what keeps setUser/setTags isolated between concurrent requests. Without
    // Sentry it stays the NodeSDK default.
    ...(sentryEnabled
        ? { contextManager: new Sentry.SentryContextManager() }
        : {}),
    instrumentations: [
        getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-http': {
                redactedQueryParams: [
                    'sig',
                    'Signature',
                    'AWSAccessKeyId',
                    'X-Goog-Signature',
                    'key',
                    // sprites exec WSS carries the command and every env
                    // (KEY=VALUE, incl. injected secrets) as query params (#264)
                    'env',
                    'cmd'
                ],
                applyCustomAttributesOnSpan: (span, request, response) => {
                    setHttpServerRequestAttributes(span, request)
                    setHttpResponseStatus(
                        span,
                        statusCodeFromResponse(response)
                    )
                }
            },
            '@opentelemetry/instrumentation-undici': {
                requestHook: (span, request) => {
                    redactSpanUrl(span, `${request.origin}${request.path}`)
                }
            },
            '@opentelemetry/instrumentation-fs': { enabled: false },
            '@opentelemetry/instrumentation-net': { enabled: false },
            '@opentelemetry/instrumentation-dns': { enabled: false }
        }),
        // auto-instrumentations-node bundles 40 instrumentations — express,
        // koa, hapi, restify — but not fastify, so getNodeAutoInstrumentations
        // silently never loads it and http.route never reaches the server span.
        // Register explicitly.
        new FastifyInstrumentation()
    ]
})

const diagLevel = process.env.OTEL_LOG_LEVEL?.toLowerCase()
if (diagLevel === 'debug')
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG)
else if (diagLevel === 'info')
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO)
else diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)

if (enabled) {
    console.log(
        `[otel] enabled service=${serviceName} endpoint=${endpoint} ` +
            `dataset=${dataset} version=${serviceVersion} ` +
            `deployment=${deploymentEnvironment}`
    )
} else {
    console.log(
        `[otel] disabled — ${otelConfig.disabledReason}; ` +
            'no traces or logs will be exported'
    )
}

if (enabled || sentryEnabled) otel.start()
