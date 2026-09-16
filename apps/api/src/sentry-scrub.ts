import type { Breadcrumb, Event } from '@sentry/node'
import {
    redactCredentialText,
    redactCredentialValue
} from './common/telemetry/redact-credentials'

const URL_FIELDS = new Set([
    'url',
    'url.full',
    'http.url',
    'http.target',
    'from',
    'to',
    'referer',
    'referrer'
])
const QUERY_FRAGMENT_FIELD = /^(?:http|url)\.(?:query|fragment)$/i

const withoutQueryOrFragment = (raw: string): string => {
    try {
        const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
        const url = new URL(raw, absolute ? undefined : 'http://manyfold.local')
        if (!url.search && !url.hash && !url.username && !url.password)
            return raw
        url.search = ''
        url.hash = ''
        url.username = ''
        url.password = ''
        return absolute ? url.toString() : url.pathname
    } catch {
        return raw.split(/[?#]/, 1)[0]
    }
}

const scrubDescription = (text: string): string =>
    redactCredentialText(text).replace(
        /(?:\b[a-z][a-z0-9+.-]{0,31}:\/\/|\/)[^\s<>"']+/gi,
        withoutQueryOrFragment
    )

// SDKs split URL components into separate fields. Drop the components as
// well as stripping their URLs; a credential-key denylist misses cursors/IDs.
const scrubTelemetryData = (
    data: Record<string, unknown>
): Record<string, unknown> => {
    const visit = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(visit)
        if (!value || typeof value !== 'object') return value
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => !QUERY_FRAGMENT_FIELD.test(key))
                .map(([key, item]) => [
                    key,
                    typeof item === 'string' &&
                    URL_FIELDS.has(key.toLowerCase())
                        ? withoutQueryOrFragment(item)
                        : visit(item)
                ])
        )
    }
    return visit(redactCredentialValue(data)) as Record<string, unknown>
}

type SentrySpan = NonNullable<Event['spans']>[number]

export const scrubSentrySpan = <
    T extends Pick<SentrySpan, 'description' | 'data'>
>(
    span: T
): T => ({
    ...span,
    ...(span.description
        ? { description: scrubDescription(span.description) }
        : {}),
    ...(span.data ? { data: scrubTelemetryData(span.data) } : {})
})

export const scrubSentryEvent = <T extends Event>(event: T): T => {
    const request = event.request
    if (request) {
        if (request.url) request.url = withoutQueryOrFragment(request.url)
        delete request.query_string
        // Request bodies carry provider API keys and chat content. The http
        // integration is configured never to collect them; this is the backstop
        // in case that option ever stops being honoured.
        delete request.data
    }
    if (request?.headers)
        request.headers = scrubTelemetryData(
            request.headers
        ) as typeof request.headers
    if (event.extra)
        event.extra = redactCredentialValue(event.extra) as typeof event.extra
    if (event.message) event.message = redactCredentialText(event.message)
    for (const value of event.exception?.values ?? []) {
        if (value.value) value.value = redactCredentialText(value.value)
    }
    if (event.breadcrumbs)
        event.breadcrumbs = event.breadcrumbs.map(scrubSentryBreadcrumb)
    if (event.spans) event.spans = event.spans.map(scrubSentrySpan)
    const trace = event.contexts?.trace
    if (trace?.data) trace.data = scrubTelemetryData(trace.data)
    return event
}

export const scrubSentryBreadcrumb = (crumb: Breadcrumb): Breadcrumb => {
    const message = crumb.message
        ? scrubDescription(crumb.message)
        : crumb.message
    if (!crumb.data && message === crumb.message) return crumb
    return {
        ...crumb,
        ...(message ? { message } : {}),
        ...(crumb.data ? { data: scrubTelemetryData(crumb.data) } : {})
    }
}
