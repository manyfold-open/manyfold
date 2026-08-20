// Native auth session token (`mfs_…`) for the admin app, stored in localStorage
// and returned by the auth context's getToken() as the `Authorization: Bearer`
// credential.
const SESSION_STORAGE_KEY = 'mf_admin_session'

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
