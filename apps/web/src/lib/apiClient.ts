import { useMemo } from 'react'
import { createClient, type NcaClient } from '@manyfold/sdk'
import { useAppAuth } from '@/lib/auth'

// The API base this bundle actually talks to, absolute. A same-origin build
// resolves it against the page it was served from — which is also the URL a
// machine on the same network would use, and the only one the browser can
// vouch for. A split-origin build carries it baked in.
export const apiBaseUrl = (): string => {
    const configured = import.meta.env.VITE_API_URL ?? '/api'
    const absolute =
        typeof window === 'undefined'
            ? configured
            : new URL(configured, window.location.origin).toString()
    return absolute.replace(/\/+$/, '')
}

export const useApiClient = (): NcaClient => {
    const { getToken } = useAppAuth()
    return useMemo(
        () =>
            createClient({
                baseUrl: apiBaseUrl(),
                token: getToken
            }),
        [getToken]
    )
}
