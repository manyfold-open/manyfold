// The attempted URL a signed-out visitor should return to after signing in.
// Pathname and search only: `#session=` is how the OAuth bounce delivers the
// token, so a fragment carried back through /login and re-applied would be
// re-read as an auth fragment on the next boot (see parseAuthFragment).
export const nextPath = (location: {
    pathname: string
    search: string
}): string => `${location.pathname}${location.search}`

export const loginUrl = (next: string): string =>
    next && next !== '/'
        ? `/login?redirect_url=${encodeURIComponent(next)}`
        : '/login'

// Internal paths only. The absolute-URL allowance (and the `rd` parameter it
// served) existed for the k8s hermes dashboard's nginx auth-signin bounce,
// which was removed; every in-app producer passes a path, and rejecting the
// rest closes an open-redirect-shaped door. Distinct from lib/safeRedirect.ts,
// which is the deployment-owned allowlist for absolute dashboard origins.
export const safeRedirectPath = (value: string | null): string | null => {
    if (!value) return null
    if (value.startsWith('/') && !value.startsWith('//')) return value
    return null
}
