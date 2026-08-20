export const CHANNEL_PROVIDER_HTTP_TIMEOUT_MS = 15_000

const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [500, 2000]

export interface ChannelProviderJsonRequest {
    provider: string
    operation: string
    url: string
    init?: RequestInit
    timeoutMs?: number
    retryBackoffMs?: readonly number[]
}

export interface ChannelProviderJsonResponse<T> {
    ok: boolean
    status: number
    text: string
    json: T | null
    // Parsed Retry-After response header (delta-seconds or HTTP-date), for
    // callers that classify 429s. Null when absent or unparseable.
    retryAfterMs: number | null
}

export const channelProviderJsonRequest = async <T = unknown>({
    provider,
    operation,
    url,
    init = {},
    timeoutMs = CHANNEL_PROVIDER_HTTP_TIMEOUT_MS,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS
}: ChannelProviderJsonRequest): Promise<ChannelProviderJsonResponse<T>> => {
    let lastNetworkErr: Error | undefined
    for (let attempt = 0; ; attempt++) {
        if (init.signal?.aborted)
            throw new Error(`${provider} ${operation} request aborted`)
        const controller = new AbortController()
        let timedOut = false
        const forwardAbort = (): void => controller.abort()
        if (init.signal)
            init.signal.addEventListener('abort', forwardAbort, { once: true })
        const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
        }, timeoutMs)
        let res: Response | undefined
        let fetchErr: Error | undefined
        try {
            res = await fetch(url, { ...init, signal: controller.signal })
        } catch (err) {
            fetchErr = err as Error
        } finally {
            clearTimeout(timer)
            init.signal?.removeEventListener('abort', forwardAbort)
        }
        if (res) {
            const text = await res.text()
            return {
                ok: res.ok,
                status: res.status,
                text,
                json: parseJson<T>(text),
                // Optional-chained: some callers stub fetch with minimal
                // Response-like objects that omit headers.
                retryAfterMs: parseRetryAfterMs(
                    res.headers?.get?.('retry-after') ?? null
                )
            }
        }
        if (timedOut)
            throw new Error(
                `${provider} ${operation} timed out after ${timeoutMs}ms`
            )
        if (fetchErr?.name === 'AbortError')
            throw new Error(`${provider} ${operation} request aborted`)
        lastNetworkErr = new Error(
            `${provider} ${operation} network error: ${fetchErr?.message ?? 'unknown'}`
        )
        const backoff = retryBackoffMs[attempt]
        if (backoff === undefined) throw lastNetworkErr
        await new Promise<void>((resolve) => setTimeout(resolve, backoff))
    }
}

const parseJson = <T>(text: string): T | null => {
    if (text.length === 0) return null
    try {
        return JSON.parse(text) as T
    } catch {
        return null
    }
}

export const parseRetryAfterMs = (header: string | null): number | null => {
    if (!header) return null
    const trimmed = header.trim()
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
    const date = Date.parse(trimmed)
    if (Number.isNaN(date)) return null
    return Math.max(0, date - Date.now())
}
