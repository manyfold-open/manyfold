type Data = Record<string, unknown>

interface SpanFields {
    description?: string
    data?: Data
}

interface BreadcrumbFields {
    message?: string
    data?: Data
}

interface EventFields {
    transaction?: string
    request?: {
        url?: string
        headers?: Record<string, unknown>
        query_string?: unknown
    }
    breadcrumbs?: BreadcrumbFields[]
    spans?: SpanFields[]
    contexts?: { trace?: SpanFields }
}

const REDACTED = 'REDACTED'
const QUERY_KEYS = new Set(['key', 'env', 'cmd'])
const FRAGMENT_KEYS = new Set(['session', 'nmtoken'])
const URL_FIELDS = new Set([
    'url',
    'from',
    'to',
    'url.full',
    'url.original',
    'http.url',
    'http.target'
])
const QUERY_FIELDS = new Set([
    'query',
    'query_string',
    'url.query',
    'http.query'
])
const FRAGMENT_FIELDS = new Set(['fragment', 'url.fragment', 'http.fragment'])

export const createBrowserSentryScrubber = (
    options: { removedQueryParams?: readonly string[] } = {}
) => {
    const removed = new Set(
        (options.removedQueryParams ?? []).map((key) => key.toLowerCase())
    )

    const scrubParams = (
        params: URLSearchParams,
        sensitive: ReadonlySet<string>
    ): boolean => {
        let changed = false
        for (const key of new Set(params.keys())) {
            if (removed.has(key.toLowerCase())) {
                params.delete(key)
                changed = true
            } else if (
                sensitive.has(key.toLowerCase()) &&
                params.getAll(key).some((value) => value !== REDACTED)
            ) {
                params.set(key, REDACTED)
                changed = true
            }
        }
        return changed
    }

    const scrubUrl = (raw: string): string => {
        try {
            const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
            const url = new URL(
                raw,
                absolute ? undefined : 'http://manyfold.local'
            )
            let changed = false
            const segments = url.pathname.split('/')
            for (let index = 0; index < segments.length - 1; index++) {
                const token = segments[index + 1]
                if (
                    segments[index] !== 'invite' ||
                    !token ||
                    token.startsWith(':') ||
                    token === REDACTED
                )
                    continue
                segments[index + 1] = REDACTED
                changed = true
            }
            if (changed) url.pathname = segments.join('/')
            changed = scrubParams(url.searchParams, QUERY_KEYS) || changed
            if (url.hash) {
                const fragment = new URLSearchParams(url.hash.slice(1))
                if (scrubParams(fragment, FRAGMENT_KEYS)) {
                    url.hash = fragment.toString()
                    changed = true
                }
            }
            if (!changed) return raw
            if (absolute) return url.toString()
            const prefix = raw.startsWith('//') ? `//${url.host}` : ''
            return `${prefix}${url.pathname}${url.search}${url.hash}`
        } catch {
            return raw
        }
    }

    const scrubDescription = (description: string): string => {
        const method =
            /^(GET|HEAD|POST|PUT|DELETE|CONNECT|OPTIONS|TRACE|PATCH)(\s+)(.+)$/i.exec(
                description
            )
        return method
            ? `${method[1]}${method[2]}${scrubUrl(method[3])}`
            : scrubUrl(description)
    }

    const scrubQuery = (
        value: unknown,
        sensitive: ReadonlySet<string>,
        prefix: '?' | '#'
    ): unknown => {
        if (typeof value === 'string') {
            const hasPrefix = value.startsWith(prefix)
            const params = new URLSearchParams(
                hasPrefix ? value.slice(1) : value
            )
            return scrubParams(params, sensitive)
                ? `${hasPrefix ? prefix : ''}${params.toString()}`
                : value
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return undefined
        const result: Data = { ...value }
        for (const key of Object.keys(result)) {
            if (removed.has(key.toLowerCase())) delete result[key]
            else if (sensitive.has(key.toLowerCase())) result[key] = REDACTED
        }
        return result
    }

    const scrubData = (data: Data): Data => {
        const result = { ...data }
        for (const [key, value] of Object.entries(data)) {
            const normalized = key.toLowerCase()
            if (removed.has(normalized)) {
                delete result[key]
            } else if (QUERY_FIELDS.has(normalized)) {
                result[key] = scrubQuery(value, QUERY_KEYS, '?')
            } else if (FRAGMENT_FIELDS.has(normalized)) {
                result[key] = scrubQuery(value, FRAGMENT_KEYS, '#')
            } else if (
                URL_FIELDS.has(normalized) &&
                typeof value === 'string'
            ) {
                result[key] = scrubUrl(value)
            }
            if (result[key] === undefined) delete result[key]
        }
        return result
    }

    const scrubBreadcrumb = <T extends BreadcrumbFields>(crumb: T): T => {
        const message =
            typeof crumb.message === 'string'
                ? scrubDescription(crumb.message)
                : crumb.message
        if (!crumb.data && message === crumb.message) return crumb
        return {
            ...crumb,
            ...(crumb.data ? { data: scrubData(crumb.data) } : {}),
            ...(message !== crumb.message ? { message } : {})
        }
    }

    const scrubSpan = <T extends SpanFields>(span: T): T => ({
        ...span,
        ...(span.description
            ? { description: scrubDescription(span.description) }
            : {}),
        ...(span.data ? { data: scrubData(span.data) } : {})
    })

    const scrubEvent = <T extends EventFields>(event: T): T => {
        const request = event.request
        if (request) {
            if (request.url) request.url = scrubUrl(request.url)
            if (request.query_string !== undefined)
                request.query_string = scrubQuery(
                    request.query_string,
                    QUERY_KEYS,
                    '?'
                )
            for (const [key, value] of Object.entries(request.headers ?? {})) {
                if (
                    key.toLowerCase() === 'referer' &&
                    typeof value === 'string'
                )
                    request.headers![key] = scrubUrl(value)
            }
        }
        if (event.transaction)
            event.transaction = scrubDescription(event.transaction)
        if (event.breadcrumbs)
            event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb)
        if (event.spans) event.spans = event.spans.map(scrubSpan)
        if (event.contexts?.trace)
            event.contexts.trace = scrubSpan(event.contexts.trace)
        return event
    }

    return { scrubUrl, scrubBreadcrumb, scrubSpan, scrubEvent }
}
