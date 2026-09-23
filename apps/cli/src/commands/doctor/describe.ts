import type { DoctorContext, HttpFact } from './types'

const NETWORK_WORDS: Record<string, string> = {
    network_timeout: 'the request timed out',
    network_dns: 'the host name does not resolve',
    network_refused: 'the connection was refused',
    network_tls:
        'the TLS handshake failed (check the system clock and trusted certificates)',
    network_offline: 'the network is unreachable'
}

export const networkWords = (code: string): string =>
    NETWORK_WORDS[code] ?? 'the request failed'

export const nonEmpty = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null

export const hostOf = (url: string | null): string => {
    if (!url) return 'an unknown location'
    try {
        return new URL(url).host
    } catch {
        return url
    }
}

// Why a probe did not come back as a usable Manyfold answer.
export const describeFailure = (fact: HttpFact): string => {
    switch (fact.kind) {
        case 'network':
            return networkWords(fact.code)
        case 'redirect':
            return `it redirects to ${hostOf(fact.location)}`
        case 'not-json':
            return 'it did not answer with JSON'
        case 'error':
            return `it answered HTTP ${fact.status}${
                fact.serverMessage ? ` (${fact.serverMessage})` : ''
            }`
        case 'ok':
            return 'it does not answer like a Manyfold API'
    }
}

export const httpData = (fact: HttpFact | null): Record<string, unknown> => {
    if (!fact) return {}
    if (fact.kind === 'network') return { code: fact.code }
    if (fact.kind === 'error')
        return { httpStatus: fact.status, code: fact.code }
    return { httpStatus: fact.status }
}

export const plural = (count: number, word: string): string =>
    `${count} ${word}${count === 1 ? '' : 's'}`

export const duration = (ms: number): string => {
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h ${minutes % 60}m`
    return `${Math.floor(hours / 24)}d`
}

export const ago = (
    iso: string | null | undefined,
    now: number
): string | null => {
    if (!iso) return null
    const at = Date.parse(iso)
    return Number.isNaN(at) ? null : `${duration(Math.max(0, now - at))} ago`
}

// How a fix addresses a profile: bare `mf` reaches the current one from this
// shell, unless it was picked with --profile.
export const mfFor = (profile: string, ctx: DoctorContext): string =>
    profile === ctx.currentProfile && ctx.profileSource !== 'flag'
        ? 'mf'
        : `mf --profile ${profile}`
