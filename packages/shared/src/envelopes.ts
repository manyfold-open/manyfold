export interface ApiError {
    ok: false
    error: {
        code: string
        message: string
        details?: unknown
    }
}

export const apiError = (
    code: string,
    message: string,
    details?: unknown
): ApiError => ({
    ok: false,
    error: { code, message, details }
})
