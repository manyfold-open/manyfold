import * as Sentry from '@sentry/node'
import { resolveSentryConfig } from './sentry-config'
import { buildTelemetryCaptureOptions } from './sentry-grouping'
import { GitHubRequestError } from './common/github-request-error'
import { inBackgroundContext } from './common/telemetry/background-context'
import { StorageMeasurementError } from './common/telemetry/storage-measurement-error'
import {
    scrubSentryBreadcrumb,
    scrubSentryEvent,
    scrubSentrySpan
} from './sentry-scrub'

const config = resolveSentryConfig()

export const sentryEnabled = config.enabled
export const sentryTracesSampleRate = config.tracesSampleRate

if (config.enabled) {
    Sentry.init({
        dsn: config.dsn,
        release: config.release,
        environment: config.environment,
        // ./otel owns the tracer provider, sampler and instrumentations; Sentry
        // only attaches its span processor and context manager to that SDK.
        skipOpenTelemetrySetup: true,
        // Real trace volume is decided by SentryRatioSpanProcessor so that
        // Axiom keeps receiving 100% of spans; this only enables tracing.
        tracesSampleRate: 1,
        sendDefaultPii: false,
        // skipOpenTelemetrySetup does not disable SDK auto-instrumentation.
        // Only the existing OTel instrumentations may create shared spans.
        defaultIntegrations: Sentry.getDefaultIntegrationsWithoutPerformance(),
        integrations: [
            // spans/tracePropagation stay with the existing OTel
            // instrumentations; Sentry keeps only request isolation.
            Sentry.httpIntegration({
                breadcrumbs: false,
                spans: false,
                tracePropagation: false,
                maxIncomingRequestBodySize: 'none'
            }),
            Sentry.nativeNodeFetchIntegration({
                breadcrumbs: false,
                spans: false,
                tracePropagation: false
            }),
            // main.ts owns the fatal path (handleFatal → finalizeExit); Sentry
            // must capture without ever exiting the process itself.
            Sentry.onUncaughtExceptionIntegration({
                exitEvenIfOtherHandlersAreRegistered: false
            })
        ],
        beforeSend: scrubSentryEvent,
        beforeSendTransaction: scrubSentryEvent,
        beforeSendSpan: scrubSentrySpan,
        beforeBreadcrumb: scrubSentryBreadcrumb
    })
    console.log(
        `[sentry] enabled release=${config.release} ` +
            `environment=${config.environment} ` +
            `tracesSampleRate=${config.tracesSampleRate}`
    )
} else {
    console.log(
        `[sentry] disabled — ${config.disabledReason}; no events will be sent`
    )
}

export const captureApiException = (
    exception: unknown,
    extra?: Record<string, unknown>
): void => {
    if (sentryEnabled && exception instanceof GitHubRequestError) {
        // Arbitrary-source errors expose only their low-cardinality diagnosis.
        // SDK stack context/local-variable enrichment can otherwise recover
        // source inputs even after the error message has been sanitized.
        inBackgroundContext(() =>
            Sentry.captureEvent({
                level: 'error',
                exception: {
                    values: [{
                        type: 'GitHubRequestError',
                        value: exception.message,
                        mechanism: { type: 'generic', handled: true }
                    }]
                },
                tags: {
                    classification: exception.classification,
                    reason: exception.reason
                },
                fingerprint: [
                    'github_source_unavailable',
                    exception.reason,
                    exception.classification
                ]
            })
        )()
        return
    }
    if (sentryEnabled)
        Sentry.captureException(exception, extra ? { extra } : undefined)
}

export const captureTelemetryError = (
    name: string,
    err: Error,
    attrs: Record<string, unknown>
): void => {
    if (!sentryEnabled) return
    if (err instanceof StorageMeasurementError) {
        // Async stack enrichment can recover the foreground caller even after
        // its scope is cleared. Measurement failures carry only safe diagnosis.
        Sentry.captureEvent({
            ...buildTelemetryCaptureOptions(name, attrs),
            level: 'error',
            exception: { values: [{ type: err.name, value: err.message, mechanism: { type: 'generic', handled: true } }] },
            fingerprint: ['sprite_storage_measurement', err.failureClass]
        })
        return
    }
    Sentry.captureException(err, buildTelemetryCaptureOptions(name, attrs))
}

export const setSentryRequestContext = (
    userId: string | undefined,
    tags: Record<string, string>
): void => {
    if (!sentryEnabled) return
    if (userId) Sentry.setUser({ id: userId })
    if (Object.keys(tags).length > 0) Sentry.setTags(tags)
}

export const flushSentry = async (timeoutMs: number): Promise<void> => {
    if (!sentryEnabled) return
    try {
        await Sentry.flush(timeoutMs)
    } catch {}
}
