import type { Breadcrumb, Event } from '@sentry/node'
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
    if (event.message) event.message = redactSensitiveUrlQuery(event.message)
    for (const value of event.exception?.values ?? []) {
        if (value.value) value.value = redactSensitiveUrlQuery(value.value)
    }
    return event
}

export const scrubSentryBreadcrumb = (crumb: Breadcrumb): Breadcrumb => {
    const url = crumb.data?.url
    if (typeof url !== 'string') return crumb
    return {
        ...crumb,
        data: { ...crumb.data, url: redactSensitiveUrlQuery(url) }
    }
}