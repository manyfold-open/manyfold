import { isPublicHostname } from '@manyfold/external-providers'
import { DEFAULT_API_BASE_URL } from '@/common/brand'

// PUBLIC_API_BASE_URL is the public origin WITHOUT the /api prefix —
// keepalive and channels append `/api/...` themselves. Agent runtimes get
// MF_API_URL WITH the prefix (the mf CLI uses it verbatim as its API base),
// so injection sites must go through this helper. Tolerates a value that
// already carries the prefix.
export const publicApiUrlWithApiPrefix = (base: string): string => {
    const trimmed = base.replace(/\/+$/, '')
    return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`
}

// The API address a sandbox's runner is given (MF_API_URL): the public origin
// with /api, or the hosted product's API when none is configured.
export const runnerApiUrl = (): string => {
    const base = process.env.PUBLIC_API_BASE_URL?.trim()
    return base ? publicApiUrlWithApiPrefix(base) : DEFAULT_API_BASE_URL
}

// Whether a machine outside this network (a sandbox provider's VM) could open
// this URL at all, judged from the URL alone.
export const reachableFromOutside = (url: string): boolean => {
    try {
        return isPublicHostname(new URL(url).hostname)
    } catch {
        return false
    }
}
