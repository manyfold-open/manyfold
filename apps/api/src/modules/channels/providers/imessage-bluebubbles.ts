import { assertPublicHttpUrl } from '@manyfold/external-providers'
import {
    channelProviderJsonRequest,
    type ChannelProviderJsonResponse
} from './channel-http'
import {
    ChannelSendError,
    type ChannelSendErrorKind
} from '../channel-send-error'

// BlueBubbles wraps every response, success or failure, in this envelope.
export interface BlueBubblesEnvelope<T> {
    status?: number
    message?: string
    data?: T
    error?: { type?: string; message?: string }
}

export interface BlueBubblesServerInfo {
    server_version?: string
    os_version?: string
    private_api?: boolean
    helper_connected?: boolean
}

export interface BlueBubblesWebhookRow {
    id?: number
    url?: string
    events?: unknown
}

export interface BlueBubblesChatRow {
    guid?: string
    chatIdentifier?: string
    displayName?: string
    participants?: Array<{ address?: string }>
}

export interface BlueBubblesSentMessage {
    guid?: string
    tempGuid?: string
}

// A home Mac on a residential uplink is slow, and an attachment can be a video.
const BLUEBUBBLES_TIMEOUT_MS = 20_000
const BLUEBUBBLES_UPLOAD_TIMEOUT_MS = 120_000

export interface BlueBubblesRequest {
    serverUrl: string
    password: string
    operation: string
    method: 'GET' | 'POST' | 'DELETE'
    path: string
    body?: Record<string, unknown>
    form?: FormData
    timeoutMs?: number
}

// Trim, default the scheme, drop a trailing slash and reject anything that is
// not a plain http(s) origin. Synchronous, so it is safe to call from
// validateConfig; the DNS half of the SSRF check happens per request in
// bluebubblesFetch, because a write-time-only check loses to DNS rebinding.
export const normalizeServerUrl = (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.trim().length === 0)
        throw new Error('config.serverUrl is required')
    const trimmed = raw.trim()
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]
    // Checked before defaulting: prefixing 'http://' onto 'ftp://mac' would
    // otherwise produce a URL that parses and passes the protocol check.
    if (scheme && !/^https?$/i.test(scheme))
        throw new Error('config.serverUrl must use http or https')
    const withScheme = scheme ? trimmed : `http://${trimmed}`
    let url: URL
    try {
        url = new URL(withScheme)
    } catch {
        throw new Error(`config.serverUrl is not a valid URL: ${trimmed}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('config.serverUrl must use http or https')
    if (url.username || url.password)
        throw new Error('config.serverUrl must not include credentials')
    if (url.search || url.hash)
        throw new Error('config.serverUrl must not include a query or fragment')
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

// A phone number or email in a log line is PII that outlives the message, so
// every provider log goes through this first.
export const redactHandle = (text: string): string =>
    text
        .replace(/\+\d[\d\s().-]{5,}\d/g, '[redacted]')
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted]')

const buildUrl = (serverUrl: string, path: string, password: string): string =>
    `${serverUrl}${path}${path.includes('?') ? '&' : '?'}password=${encodeURIComponent(password)}`

export const bluebubblesJson = async <T>(
    req: BlueBubblesRequest
): Promise<T> => {
    const url = buildUrl(req.serverUrl, req.path, req.password)
    // Re-checked on every call: the operator can point serverUrl at a public
    // name that later resolves to a private address.
    await assertPublicHttpUrl(url, { allowEnvBypass: true })
    const res: ChannelProviderJsonResponse<BlueBubblesEnvelope<T>> =
        await channelProviderJsonRequest<BlueBubblesEnvelope<T>>({
            provider: 'imessage',
            operation: req.operation,
            url,
            timeoutMs:
                req.timeoutMs ??
                (req.form ? BLUEBUBBLES_UPLOAD_TIMEOUT_MS : BLUEBUBBLES_TIMEOUT_MS),
            init: {
                method: req.method,
                ...(req.form
                    ? { body: req.form }
                    : req.body
                      ? {
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(req.body)
                        }
                      : {})
            }
        })
    if (!res.ok) {
        const description =
            [res.json?.error?.message, res.json?.message]
                .find((part) => typeof part === 'string' && part.length > 0) ??
            res.text.slice(0, 300)
        const message = `imessage ${req.operation} failed: ${res.status} ${description}`
        const kind = classifyBlueBubblesFailure(res.status, description)
        if (kind === null) throw new Error(message)
        throw new ChannelSendError(kind, message, {
            retryAfterMs: kind === 'rate_limited' ? res.retryAfterMs : null
        })
    }
    return (res.json?.data ?? ({} as T)) as T
}

// Positive identification only: anything not listed stays a plain Error and
// keeps the ladder-retry path.
export const classifyBlueBubblesFailure = (
    status: number,
    description: string
): ChannelSendErrorKind | null => {
    if (status === 429) return 'rate_limited'
    if (status === 401 || status === 403) return 'forbidden'
    if (status === 400) return 'bad_format'
    if (status === 404) {
        // BlueBubbles answers 404 both for "that chat is gone" and for "this
        // server version has no such route". not_found is permanent, so a
        // route-not-found misread here would dead-letter the reply on an
        // old-but-working server. Express phrases the latter as
        // "Cannot POST /api/v1/message/text" — note it contains the word
        // 'message', which is why matching bare nouns is not enough.
        if (/\bcannot\s+(get|post|put|patch|delete)\b/i.test(description))
            return null
        if (
            /\b(chat|handle|address|conversation|recipient)\b[^.]{0,40}\b(not\s+found|does\s*n[o']?t\s+exist|unknown|invalid)\b/i.test(
                description
            ) ||
            /\bno\s+such\s+(chat|handle|conversation|recipient)\b/i.test(
                description
            )
        )
            return 'not_found'
        return null
    }
    return null
}

export const probeServerInfo = async (
    serverUrl: string,
    password: string
): Promise<{
    serverVersion: string | null
    osVersion: string | null
    privateApi: boolean
    helperConnected: boolean
}> => {
    const info = await bluebubblesJson<BlueBubblesServerInfo>({
        serverUrl,
        password,
        operation: 'server.info',
        method: 'GET',
        path: '/api/v1/server/info'
    })
    return {
        serverVersion: info.server_version ?? null,
        osVersion: info.os_version ?? null,
        privateApi: info.private_api === true,
        helperConnected: info.helper_connected === true
    }
}
