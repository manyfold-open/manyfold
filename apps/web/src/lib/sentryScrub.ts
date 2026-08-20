import type { Breadcrumb, Event } from '@sentry/react'
import { ATTRIBUTION_SCRUB_PARAMS } from '@/lib/attribution'

const REDACTED = 'REDACTED'
const SENSITIVE_QUERY_KEYS = new Set(['key', 'env', 'cmd'])
// The acquisition touch token is stripped from the URL at capture time; this
// removal is defence in depth for URLs that never went through capture
// (breadcrumbs recorded mid-redirect, Referer headers).
const REMOVED_QUERY_KEYS = new Set(ATTRIBUTION_SCRUB_PARAMS)
// The login hand-off puts a session token / NetMind loginToken in the fragment
// precisely so it never reaches a server log — it must not reach Sentry either.
const SENSITIVE_FRAGMENT_KEYS = ['session', 'nmtoken']
// Path segments that ARE credentials: the waitlist invite link grants
// sign-up for its email on any device.
const TOKEN_PATH_SEGMENTS = new Set(['invite'])
const URL_KEYS = ['url', 'from', 'to']

const scrubTokenPath = (pathname: string): string => {
    const segments = pathname.split('/')
    let changed = false
    for (let i = 0; i < segments.length - 1; i += 1) {
        if (!TOKEN_PATH_SEGMENTS.has(segments[i])) continue
        if (!segments[i + 1]) continue
        segments[i + 1] = REDACTED
        changed = true
    }
    return changed ? segments.join('/') : pathname
}

export const scrubSentryUrl = (raw: string): string => {
    try {
        const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
        const url = new URL(raw, absolute ? undefined : 'http://manyfold.local')
        let changed = false

        const scrubbedPath = scrubTokenPath(url.pathname)
        if (scrubbedPath !== url.pathname) {
            url.pathname = scrubbedPath
            changed = true
        }

        for (const key of Array.from(url.searchParams.keys())) {
            if (REMOVED_QUERY_KEYS.has(key.toLowerCase())) {
                url.searchParams.delete(key)
                changed = true
                continue
            }
            if (!SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) continue
            url.searchParams.set(key, REDACTED)
            changed = true
        }

        const hash = url.hash.replace(/^#/, '')
        if (hash) {
            const fragment = new URLSearchParams(hash)
            let fragmentChanged = false
            for (const key of SENSITIVE_FRAGMENT_KEYS) {
                if (!fragment.has(key)) continue
                fragment.set(key, REDACTED)
                fragmentChanged = true
            }
            if (fragmentChanged) {
                url.hash = fragment.toString()
                changed = true
            }
        }

        if (!changed) return raw
        return absolute
            ? url.toString()
            : `${url.pathname}${url.search}${url.hash}`
    } catch {
        return raw
    }
}

export const scrubSentryBreadcrumb = (crumb: Breadcrumb): Breadcrumb => {
    const data = crumb.data
    if (!data) return crumb
    const next = { ...data }
    let changed = false
    for (const key of URL_KEYS) {
        const value = next[key]
        if (typeof value !== 'string') continue
        const scrubbed = scrubSentryUrl(value)
        if (scrubbed === value) continue
        next[key] = scrubbed
        changed = true
    }
    return changed ? { ...crumb, data: next } : crumb
}

export const scrubSentryEvent = <T extends Event>(event: T): T => {
    const request = event.request
    if (request) {
        if (request.url) request.url = scrubSentryUrl(request.url)
        const referer = request.headers?.['Referer']
        if (request.headers && typeof referer === 'string')
            request.headers['Referer'] = scrubSentryUrl(referer)
    }
    const breadcrumbs = event.breadcrumbs
    if (breadcrumbs)
        event.breadcrumbs = breadcrumbs.map(scrubSentryBreadcrumb)
    return event
}