import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const PRIVATE_ENDPOINTS_ENVS = [
    'MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS',
    'NCA_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS'
] as const

// Core SSRF guard: validate that `raw` is an http(s) URL whose host is not
// private/loopback/link-local/reserved/metadata. Returns the parsed URL.
// `allowEnvBypass` honours the local-dev env escape hatch; callers that fetch
// attacker-supplied URLs (e.g. OpenAI file parts) MUST pass false so the env
// var can never open an SSRF hole.
export const assertPublicHttpUrl = async (
    raw: string,
    options: { allowEnvBypass?: boolean } = {}
): Promise<URL> => {
    let url: URL
    try {
        url = new URL(raw.trim())
    } catch {
        throw new Error('URL must be a valid absolute URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error('URL must use http or https')
    if (url.username || url.password)
        throw new Error('URL must not include credentials')

    if (
        options.allowEnvBypass &&
        PRIVATE_ENDPOINTS_ENVS.some((key) => process.env[key] === '1')
    )
        return url

    const host = normalizeHost(url.hostname)
    if (isBlockedHostname(host))
        throw new Error(`host ${host} is not allowed`)
    if (isIP(host)) {
        assertPublicAddress(host, host)
        return url
    }
    let resolved: Array<{ address: string }> = []
    try {
        resolved = await lookup(host, { all: true, verbatim: true })
    } catch {
        throw new Error(`host ${host} could not be resolved`)
    }
    if (resolved.length === 0)
        throw new Error(`host ${host} could not be resolved`)
    for (const item of resolved) assertPublicAddress(item.address, host)
    return url
}

export const normalizeProviderEndpoint = async (
    raw: string
): Promise<string> => {
    const url = await assertPublicHttpUrl(raw, { allowEnvBypass: true })
    if (url.search || url.hash)
        throw new Error('provider endpoint must not include query or fragment')
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\/$/, '')
}

const normalizeHost = (host: string): string =>
    host.toLowerCase().replace(/^\[|\]$/g, '')

const isBlockedHostname = (host: string): boolean =>
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'

const assertPublicAddress = (address: string, host: string): void => {
    if (isPrivateAddress(address))
        throw new Error(
            `provider endpoint host ${host} resolves to a private or reserved address`
        )
}

const isPrivateAddress = (address: string): boolean => {
    const normalized = normalizeHost(address)
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length)
        if (isIP(mapped) === 4) return isPrivateIpv4(mapped)
    }
    const family = isIP(normalized)
    if (family === 4) return isPrivateIpv4(normalized)
    if (family === 6) return isPrivateIpv6(normalized)
    return true
}

const isPrivateIpv4 = (address: string): boolean => {
    const parts = address.split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
        return true
    const [a, b, c, d] = parts
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224 ||
        (a === 255 && b === 255 && c === 255 && d === 255)
    )
}

const isPrivateIpv6 = (address: string): boolean => {
    if (address === '::' || address === '::1') return true
    const first = Number.parseInt(address.split(':')[0] || '0', 16)
    if (!Number.isFinite(first)) return true
    return (
        (first & 0xfe00) === 0xfc00 ||
        (first & 0xffc0) === 0xfe80 ||
        (first & 0xff00) === 0xff00
    )
}
