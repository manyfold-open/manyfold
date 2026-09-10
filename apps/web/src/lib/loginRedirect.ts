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

// Resolve as a browser would: backslashes and stripped control characters
// can turn an apparently internal path into a protocol-relative URL.
export const safeRedirectPath = (value: string | null): string | null => {
    if (!value?.startsWith('/') || value.startsWith('//')) return null
    const origin = 'https://manyfold.invalid'
    try {
        return new URL(value, origin).origin === origin ? value : null
    } catch {
        return null
    }
}
