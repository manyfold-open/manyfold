const REDACTED_QUERY_VALUE = 'REDACTED'
// 'env'/'cmd' scrub the sprites exec WSS URL, whose query carries the command
// and every injected env secret as KEY=VALUE pairs (#264).
const SENSITIVE_QUERY_KEYS = new Set(['key', 'env', 'cmd'])

export const redactSensitiveUrlQuery = (raw: string): string => {
    const fallback = (): string =>
        raw.replace(/([?&]key=)[^&#\s]+/gi, `$1${REDACTED_QUERY_VALUE}`)
    try {
        const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
        const parsed = new URL(
            raw,
            absolute ? undefined : 'http://manyfold.local'
        )
        let changed = false
        for (const key of Array.from(parsed.searchParams.keys())) {
            if (!SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) continue
            parsed.searchParams.set(key, REDACTED_QUERY_VALUE)
            changed = true
        }
        if (!changed) return raw
        if (absolute) return parsed.toString()
        return `${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
        return fallback()
    }
}

export const redactedQueryString = (raw: string): string | null => {
    const redacted = redactSensitiveUrlQuery(raw)
    try {
        return new URL(redacted, 'http://manyfold.local').search.replace(
            /^\?/,
            ''
        )
    } catch {
        const match = redacted.match(/\?([^#\s]*)/)
        return match?.[1] ?? null
    }
}
