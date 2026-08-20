// Deployment-owned allowlist for absolute post-sign-in redirect targets
// (editions design §5.4): comma-separated exact hosts or domain suffixes,
// baked at build time via VITE_DASHBOARD_ORIGIN_SUFFIXES and never taken from
// a server response — a compromised or misconfigured API must not be able to
// turn the sign-in bounce into an open redirect. The default is the official
// cloud domain; self-hosted builds pass their own domain, or empty to allow
// same-origin paths only.
export const safeRedirectWith = (
    allowedSuffixes: readonly string[],
    value: string | null | undefined
): string | null => {
    if (!value) return null
    // Internal path (most common case).
    if (value.startsWith('/') && !value.startsWith('//')) return value
    // Absolute URL — only hosts on the deployment's allowlist, so the
    // post-sign-in bounce can return the user to a sibling subdomain (e.g.
    // agent dashboards fronted by Cloudflare Tunnel at
    // `agent-<id>-dashboard.<domain>`) without opening an unrestricted
    // redirect.
    try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        const host = url.hostname
        const allowed = allowedSuffixes.some(
            (suffix) => host === suffix || host.endsWith(`.${suffix}`)
        )
        if (!allowed) return null
        // nginx-ingress sees the incoming Cloudflare-tunnel hop as plain http
        // and stamps `rd=http://...` even though the user-visible URL is
        // https. Normalize back to https so we don't drop the user into a
        // protocol mismatch.
        if (url.protocol === 'http:') url.protocol = 'https:'
        return url.toString()
    } catch {
        return null
    }
}

export const parseOriginSuffixes = (
    raw: string | undefined
): readonly string[] =>
    (raw ?? 'manyfold.ai')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)

export const safeRedirect = (
    value: string | null | undefined
): string | null =>
    safeRedirectWith(
        parseOriginSuffixes(import.meta.env?.VITE_DASHBOARD_ORIGIN_SUFFIXES),
        value
    )
