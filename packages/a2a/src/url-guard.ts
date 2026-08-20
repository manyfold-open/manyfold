// SSRF guard for outbound A2A requests. Mirrors the private-address rules in
// packages/external-providers/src/endpoint-safety.ts; kept here so packages/a2a
// stays dependency-free (external-providers will depend on a2a, not vice versa).

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { fetch } from 'undici'

const ALLOW_PRIVATE_ENVS = [
    'MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS',
    'NCA_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS'
] as const

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

export interface UrlGuardOptions {
    allowPrivate?: boolean
    allowHttp?: boolean
}

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

    const allowPrivate =
        opts.allowPrivate === true ||
        ALLOW_PRIVATE_ENVS.some((key) => process.env[key] === '1')

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

    let resolved: Array<{ address: string }> = []
    try {
        resolved = await lookup(host, { all: true, verbatim: true })
    } catch {
        throw new Error(`A2A endpoint host ${host} could not be resolved`)
    }
    if (resolved.length === 0)
        throw new Error(`A2A endpoint host ${host} could not be resolved`)
    for (const item of resolved) assertPublicAddress(item.address, host)
    return url.toString()
}

export const guardedFetch = async (
    rawUrl: string,
    init: FetchInit,
    opts: UrlGuardOptions = {}
): ReturnType<typeof fetch> => {
    const safeUrl = await assertSafeUrl(rawUrl, opts)
    return fetch(safeUrl, { ...init, redirect: 'error' })
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
