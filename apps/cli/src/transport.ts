import { createClient, type ClientOptions, type NcaClient } from '@manyfold/sdk'
import { MF_CLI_VERSION } from '@/version'

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000

const TIMEOUT_UNITS: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000
}

export const resolveHttpTimeoutMs = (
    raw = process.env.MF_HTTP_TIMEOUT
): number => {
    const value = raw?.trim().toLowerCase()
    if (!value) return DEFAULT_HTTP_TIMEOUT_MS
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value)
    if (!match) return DEFAULT_HTTP_TIMEOUT_MS
    const amount = Number(match[1])
    const timeoutMs = amount * TIMEOUT_UNITS[match[2] ?? 's']
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return DEFAULT_HTTP_TIMEOUT_MS
    return Math.max(1, Math.round(timeoutMs))
}

export const normalizeClientOs = (platform: string): string => {
    if (platform === 'darwin') return 'macos'
    if (platform === 'win32') return 'windows'
    return platform
}

interface CliFetchOptions {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    version?: string
    platform?: string
}

const mergeHeaders = (
    input: RequestInfo | URL,
    init?: RequestInit
): Headers => {
    const headers = new Headers(
        typeof Request !== 'undefined' && input instanceof Request
            ? input.headers
            : undefined
    )
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    return headers
}

const isStreamingRequest = (headers: Headers): boolean => {
    const accept = headers.get('accept')?.toLowerCase() ?? ''
    return accept
        .split(',')
        .map((value) => value.trim().split(';', 1)[0])
        .some(
            (value) =>
                value === 'text/event-stream' ||
                value === 'application/x-ndjson' ||
                // file downloads: the timeout below bounds the whole request, so
                // a 30s cap aborts any transfer that takes longer than 30s
                value === 'application/octet-stream'
        )
}

const isBinaryUpload = (
    body: BodyInit | null | undefined,
    headers: Headers
): boolean => {
    const contentType = headers.get('content-type')?.toLowerCase() ?? ''
    if (
        contentType.startsWith('application/octet-stream') ||
        contentType.startsWith('multipart/form-data')
    )
        return true
    if (body == null) return false
    if (typeof FormData !== 'undefined' && body instanceof FormData) return true
    if (typeof Blob !== 'undefined' && body instanceof Blob) return true
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true
    return (
        typeof ReadableStream !== 'undefined' && body instanceof ReadableStream
    )
}

export const createCliFetch = (options: CliFetchOptions = {}): typeof fetch => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    const timeoutMs = options.timeoutMs ?? resolveHttpTimeoutMs()
    const version = options.version ?? MF_CLI_VERSION
    const os = normalizeClientOs(options.platform ?? process.platform)

    return async (input, init) => {
        const headers = mergeHeaders(input, init)
        headers.set('X-Client-Platform', 'cli')
        headers.set('X-Client-Version', version)
        headers.set('X-Client-OS', os)

        const skipTimeout =
            isStreamingRequest(headers) || isBinaryUpload(init?.body, headers)
        const signal =
            init?.signal ??
            (skipTimeout ? undefined : AbortSignal.timeout(timeoutMs))

        return fetchImpl(input, { ...init, headers, signal })
    }
}

export const createCliClient = (options: ClientOptions): NcaClient => {
    const { fetch: fetchImpl, ...clientOptions } = options
    return createClient({
        ...clientOptions,
        fetch: createCliFetch({ fetchImpl })
    })
}
