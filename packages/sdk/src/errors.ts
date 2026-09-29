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

// An agent-create stream reports its failure as an event after its 201. An
// API older than the envelope fields on that event names only the Nest
// exception class, which still says which status the failure would have had.
const STATUS_FOR_EXCEPTION: Record<string, number> = {
    BadRequestException: 400,
    UnauthorizedException: 401,
    ForbiddenException: 403,
    NotFoundException: 404,
    ConflictException: 409,
    UnprocessableEntityException: 422,
    InternalServerErrorException: 500,
    ServiceUnavailableException: 503
}

export const apiErrorFromStreamEvent = (event: {
    step: string | null
    errorClass: string
    message: string
    code?: string
    status?: number
    details?: unknown
}): ApiError & { step: string | null } => {
    const status = event.status ?? STATUS_FOR_EXCEPTION[event.errorClass] ?? 500
    const err = new ApiError({
        status,
        statusText: '',
        code: event.code ?? statusCode(status),
        message: event.message,
        serverMessage: event.message,
        body: JSON.stringify(event),
        details: event.details
    }) as ApiError & { step: string | null }
    err.step = event.step
    return err
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
        }
        if (
            json &&
            typeof json === 'object' &&
            json.error &&
            typeof json.error === 'object' &&
            !Array.isArray(json.error)
        )
            return json.error
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
