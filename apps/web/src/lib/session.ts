// The native auth session token (`mfs_…`). Stored in localStorage and returned
// by the auth context's getToken() as the `Authorization: Bearer` credential —
// the same contract the SDK client consumes, so no apiClient changes are needed.
const SESSION_STORAGE_KEY = 'mf_session'

export const getSession = (): string | null => {
    try {
        return window.localStorage.getItem(SESSION_STORAGE_KEY)
    } catch {
        return null
    }
}

export const storeSession = (token: string): void => {
    try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, token)
    } catch {}
}

export const clearSession = (): void => {
    try {
        window.localStorage.removeItem(SESSION_STORAGE_KEY)
    } catch {}
}
