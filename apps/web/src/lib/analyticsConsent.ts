export type AnalyticsConsent = 'granted' | 'denied' | 'unset'

// Basic consent for Google Analytics: nothing Google-bound loads or runs
// until the stored value is 'granted'. The value is a plain localStorage
// string so the GA module can read it at module scope on a cold load, before
// React exists.
const CONSENT_KEY = 'mf.web.analyticsConsent'

const listeners = new Set<() => void>()

export const analyticsConsent = (): AnalyticsConsent => {
    try {
        const value = localStorage.getItem(CONSENT_KEY)
        return value === 'granted' || value === 'denied' ? value : 'unset'
    } catch {
        return 'unset'
    }
}

export const setAnalyticsConsent = (value: 'granted' | 'denied'): void => {
    try {
        localStorage.setItem(CONSENT_KEY, value)
    } catch {
        /* private mode: consent stays session-local via listeners */
    }
    for (const listener of listeners) listener()
}

export const subscribeAnalyticsConsent = (
    listener: () => void
): (() => void) => {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

// "Cookie settings" entries (footer, account settings) re-open the banner so
// a decided user can change their mind without hunting for cleared storage.
const promptListeners = new Set<() => void>()

export const requestConsentPrompt = (): void => {
    for (const listener of promptListeners) listener()
}

export const subscribeConsentPrompt = (
    listener: () => void
): (() => void) => {
    promptListeners.add(listener)
    return () => {
        promptListeners.delete(listener)
    }
}