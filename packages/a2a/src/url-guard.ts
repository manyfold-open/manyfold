// SSRF guard for outbound A2A requests. Mirrors the private-address rules in
// packages/external-providers/src/endpoint-safety.ts; kept here so packages/a2a
// stays dependency-free (external-providers will depend on a2a, not vice versa).

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { Agent, fetch } from 'undici'

const ALLOW_PRIVATE_ENVS = [
    'MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS',
    'NCA_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS'
] as const

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

export interface UrlGuardOptions {
    allowPrivate?: boolean
    allowHttp?: boolean
}

const allowsPrivate = (opts: UrlGuardOptions): boolean =>
    opts.allowPrivate === true ||
    ALLOW_PRIVATE_ENVS.some((key) => process.env[key] === '1')

const publicAddresses = async (host: string) => {
    let addresses: LookupAddress[]
    try {
        addresses = await lookup(host, { all: true, verbatim: true })
    } catch {
        throw new Error(`A2A endpoint host ${host} could not be resolved`)
    }
    if (addresses.length === 0)
        throw new Error(`A2A endpoint host ${host} could not be resolved`)
    for (const item of addresses) assertPublicAddress(item.address, host)
    return addresses
}

// URL checks cannot authorize a later DNS answer. Validate the addresses handed
// directly to the socket, keeping the original Host header and TLS server name.
const publicDispatcher = new Agent({
    connect: {
        lookup: (host, options, callback) => {
            void publicAddresses(host).then(
                (addresses) => {
                    const candidates = options.family
                        ? addresses.filter((item) => item.family === options.family)
                        : addresses
                    if (!candidates.length) {
                        callback(new Error(`no address for ${host}`), '', 0)
                        return
                    }
                    callback(
                        null,
                        options.all ? candidates : candidates[0].address,
                        candidates[0].family
                    )
                },
                (error: Error) => callback(error, '', 0)
            )
        }
    }
})

export const assertSafeUrl = async (
    raw: string,
    opts: UrlGuardOptions = {}
): Promise<string> => {
    let url: URL
    try {
        url = new URL(raw.trim())
    } catch {
        throw new Error('A2A endpoint must be a valid URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error('A2A endpoint must be http(s)')
    if (url.username || url.password)
        throw new Error('A2A endpoint must not include credentials')

    const allowPrivate = allowsPrivate(opts)

    if (url.protocol === 'http:' && !allowPrivate && opts.allowHttp !== true)
        throw new Error(
            'A2A endpoint must use https (pass allowHttp/allowPrivate for local dev)'
        )

    if (allowPrivate) return url.toString()

    const host = normalizeHost(url.hostname)
    if (isBlockedHostname(host))
        throw new Error(`A2A endpoint host ${host} is not allowed`)

    if (isIP(host)) {
        assertPublicAddress(host, host)
        return url.toString()
    }

    await publicAddresses(host)
    return url.toString()
}

export const guardedFetch = async (
    rawUrl: string,
    init: FetchInit,
    opts: UrlGuardOptions = {}
): ReturnType<typeof fetch> => {
    const signal = init.signal
    signal?.throwIfAborted()
    let abort: (() => void) | undefined
    let safeUrl: string
    try {
        const validated = assertSafeUrl(rawUrl, opts)
        safeUrl = signal
            ? await Promise.race([
                  validated,
                  new Promise<never>((_resolve, reject) => {
                      abort = () => reject(signal.reason)
                      signal.addEventListener('abort', abort, { once: true })
                  })
              ])
            : await validated
    } finally {
        if (abort) signal?.removeEventListener('abort', abort)
    }
    return fetch(safeUrl, {
        ...init,
        dispatcher: allowsPrivate(opts) ? init.dispatcher : publicDispatcher,
        redirect: 'error'
    })
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
            `A2A endpoint host ${host} resolves to a private or reserved address`
        )
}

const isPrivateAddress = (address: string): boolean => {
    // URL canonicalization also covers expanded and dotted IPv4-mapped IPv6.
    const normalized = isIP(address) === 6
        ? normalizeHost(new URL(`http://[${address}]`).hostname)
        : normalizeHost(address)
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length)
        const [high, low] = mapped.split(':').map((word) => Number.parseInt(word, 16))
        return isPrivateIpv4(
            [high >>> 8, high & 255, low >>> 8, low & 255].join('.')
        )
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
