import type { IncomingHttpHeaders } from 'http'

const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const asString = (v: string | string[] | undefined): string | undefined =>
    typeof v === 'string' ? v : undefined

export const corsHeadersForOrigin = (
    headers: IncomingHttpHeaders
): Record<string, string> => {
    const origin = asString(headers.origin)
    if (!origin) return {}
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) return {}
    return {
        'access-control-allow-origin': origin,
        'access-control-allow-credentials': 'true',
        vary: 'Origin'
    }
}
