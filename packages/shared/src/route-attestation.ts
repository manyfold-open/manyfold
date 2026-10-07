import type { InferenceProtocol } from './dtos'

// The served-route attestation (DAEMON_FEATURE_TURN_ROUTE_ATTESTATION). A
// resident OpenClaw gateway or a Hermes ACP child picks its provider from its
// own config, so the API cannot know which route served a turn. The daemon,
// which can read that config, answers the turn's nonce with
// HMAC-SHA256(key = the provider API key, message below) over the route that
// actually served it; the API computes the same over the provider row it
// expected and compares. The key never leaves the host, and a nonce minted per
// turn makes an answer useless for any other turn.
//
// Both sides build the message here so they agree byte for byte; each side
// computes the HMAC with its own crypto, since this package also ships to the
// browser.

const MESSAGE_TAG = 'manyfold.route-attestation.v1'

// base64url of at least 16 random bytes.
export const isRouteNonce = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value)

// One spelling per endpoint: runtimes append `/v1` to a base URL the
// provider row stores without it (OpenClaw and Hermes both do), so a trailing
// `/v1` is the same route. Credentials in the URL, a query or a fragment
// never take part, and anything but http(s) is not a route.
export const normalizeRouteBaseUrl = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || !raw.trim()) return null
    let url: URL
    try {
        url = new URL(raw.trim())
    } catch {
        return null
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    let path = url.pathname.replace(/\/+$/, '')
    if (path.endsWith('/v1')) path = path.slice(0, -3).replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${path}`
}

export const routeAttestationMessage = (input: {
    nonce: string
    protocol: InferenceProtocol
    baseUrl: string
}): string | null => {
    const baseUrl = normalizeRouteBaseUrl(input.baseUrl)
    if (!baseUrl || !isRouteNonce(input.nonce)) return null
    return [MESSAGE_TAG, input.nonce, input.protocol, baseUrl].join('\n')
}
