import { SpanStatusCode, type Span } from '@opentelemetry/api'
import {
    ATTR_HTTP_REQUEST_METHOD,
    ATTR_URL_PATH
} from '@opentelemetry/semantic-conventions'

export const HTTP_RESPONSE_STATUS_CODE = 'http.response.status_code'

type HttpRequestLike = {
    method?: string
    url?: string
}

const pathFromRequestTarget = (target: string): string => {
    if (!target.startsWith('http://') && !target.startsWith('https://'))
        return target.split('?', 1)[0]

    try {
        return new URL(target).pathname
    } catch {
        return target.split('?', 1)[0]
    }
}

export const setHttpServerRequestAttributes = (
    span: Span,
    request: HttpRequestLike
): void => {
    if (typeof request.url !== 'string') return

    const method = request.method?.trim()
    if (method) span.setAttribute(ATTR_HTTP_REQUEST_METHOD, method)

    const path = pathFromRequestTarget(request.url)
    if (path) span.setAttribute(ATTR_URL_PATH, path)
}

export const setHttpResponseStatus = (
    span: Span | undefined,
    statusCode: number | undefined
): void => {
    if (!span) return
    if (typeof statusCode !== 'number') return
    if (!Number.isInteger(statusCode) || statusCode <= 0) return

    span.setAttribute(HTTP_RESPONSE_STATUS_CODE, statusCode)
    if (statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
}
