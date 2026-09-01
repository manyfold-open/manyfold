import { adminRoutes } from '@/routes'

// The attempted URL a signed-out admin should return to after signing in.
// Pathname and search only: `#session=` is how the OAuth bounce delivers the
// token, so a fragment carried back through the login page and re-applied
// would be re-read as an auth fragment on the next boot.
export const nextPath = (location: {
    pathname: string
    search: string
}): string => `${location.pathname}${location.search}`

export const loginUrl = (next: string): string =>
    next && next !== '/'
        ? `${adminRoutes.login}?redirect_url=${encodeURIComponent(next)}`
        : adminRoutes.login

// Internal paths only: an absolute target here would turn the sign-in bounce,
// which carries the session token in its fragment, into an open redirect.
export const safeRedirectPath = (
    value: string | null | undefined
): string | null => {
    if (!value) return null
    if (!value.startsWith('/') || value.startsWith('//')) return null
    return value
}
