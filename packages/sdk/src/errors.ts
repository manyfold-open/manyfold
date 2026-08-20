export interface ApiErrorInit {
    status: number
    statusText: string
    code: string
    message: string
    serverMessage?: string
    body: string
    details?: unknown
}

export class ApiError extends Error {
    readonly status: number
    readonly statusText: string
    readonly code: string
    readonly serverMessage?: string
    readonly body: string
    readonly details?: unknown

    constructor(init: ApiErrorInit) {
        super(init.message)
        this.name = 'ApiError'
        this.status = init.status
        this.statusText = init.statusText
        this.code = init.code
        this.serverMessage = init.serverMessage
        this.body = init.body
        this.details = init.details
    }
}

const statusCode = (status: number): string => {
    if (status === 400) return 'bad_request'
    if (status === 401) return 'unauthorized'
    if (status === 403) return 'forbidden'
    if (status === 404) return 'not_found'
    if (status === 409) return 'conflict'
    if (status === 422) return 'unprocessable_entity'
    if (status === 429) return 'too_many_requests'
    if (status >= 500) return 'internal_error'
    return 'http_error'
}

interface ParsedEnvelope {
    code?: unknown
    message?: unknown
    details?: unknown
}

const parseEnvelope = (body: string): ParsedEnvelope | null => {
    if (!body) return null
    try {
        const json = JSON.parse(body) as {
            error?: ParsedEnvelope
            code?: unknown
            message?: unknown
            details?: unknown
        }
        if (json && typeof json === 'object') {
            if (json.error && typeof json.error === 'object') return json.error
            if ('code' in json || 'message' in json) return json
        }
    } catch {
        return null
    }
    return null
}

export const buildApiError = async (
    res: Response,
    fallback?: { prefix?: string }
): Promise<ApiError> => {
    const body = await res.text().catch(() => '')
    const parsed = parseEnvelope(body)
    const code =
        typeof parsed?.code === 'string' && parsed.code
            ? parsed.code
            : statusCode(res.status)
    const serverMessage =
        typeof parsed?.message === 'string' && parsed.message
            ? parsed.message
            : undefined
    const fallbackMessage = body || res.statusText || `HTTP ${res.status}`
    // The prefix names the failed call; the server names the cause. Keep
    // both — dropping the prefix leaves bare text like 'Internal server
    // error' with no hint of which request produced it.
    const text = serverMessage ?? fallbackMessage
    const message = fallback?.prefix ? `${fallback.prefix}: ${text}` : text
    return new ApiError({
        status: res.status,
        statusText: res.statusText,
        code,
        message,
        serverMessage,
        body,
        details: parsed?.details
    })
}
