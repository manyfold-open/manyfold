// PUBLIC_API_BASE_URL is the public origin WITHOUT the /api prefix —
// keepalive and channels append `/api/...` themselves. Agent runtimes get
// MF_API_URL WITH the prefix (the mf CLI uses it verbatim as its API base),
// so injection sites must go through this helper. Tolerates a value that
// already carries the prefix.
export const publicApiUrlWithApiPrefix = (base: string): string => {
    const trimmed = base.replace(/\/+$/, '')
    return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`
}
