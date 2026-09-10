import type { Breadcrumb, Event } from '@sentry/node'
import {
    redactCredentialText,
    redactCredentialValue
} from './common/telemetry/redact-credentials'
import {
    redactedQueryString,
    redactSensitiveUrlQuery
} from './common/telemetry/redact-url'

export const scrubSentryEvent = <T extends Event>(event: T): T => {
    const request = event.request
    if (request) {
        if (request.url) request.url = redactSensitiveUrlQuery(request.url)
        if (typeof request.query_string === 'string')
            request.query_string =
                redactedQueryString(`?${request.query_string}`) ??
                request.query_string
        // Request bodies carry provider API keys and chat content. The http
        // integration is configured never to collect them; this is the backstop
        // in case that option ever stops being honoured.
        delete request.data
    }
    if (request?.headers)
        request.headers = redactCredentialValue(
            request.headers
        ) as typeof request.headers
    if (event.extra)
        event.extra = redactCredentialValue(event.extra) as typeof event.extra
    if (event.message) event.message = redactCredentialText(event.message)
    for (const value of event.exception?.values ?? []) {
        if (value.value) value.value = redactCredentialText(value.value)
    }
    return event
}

export const scrubSentryBreadcrumb = (crumb: Breadcrumb): Breadcrumb => {
    const message = crumb.message
        ? redactCredentialText(crumb.message)
        : crumb.message
    if (!crumb.data && message === crumb.message) return crumb
    return {
        ...crumb,
        ...(message ? { message } : {}),
        ...(crumb.data
            ? { data: redactCredentialValue(crumb.data) as typeof crumb.data }
            : {})
    }
}
