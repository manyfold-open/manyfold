export type AnalyticsConsent = 'granted' | 'denied' | 'unset'

// Basic consent for Google Analytics: nothing Google-bound loads or runs
// until the stored value is 'granted'. The value is a plain localStorage
// string so the GA module can read it at module scope on a cold load, before
// React exists.
const CONSENT_KEY = 'mf.web.analyticsConsent'

// Two consent postures, chosen at build time. 'opt-in' is the default and the
// only behaviour there used to be: analytics is off until the visitor accepts.
// 'regional' keeps that in the jurisdictions whose law requires it and treats
// an undecided visitor elsewhere as consenting until they decline — the banner
// still shows, with a Decline that works, so the choice stays one click away.
// Read defensively: node-run unit tests reach this module without a Vite env.
const consentMode =
    (
        import.meta as unknown as {
            env?: { VITE_ANALYTICS_CONSENT_MODE?: string }
        }
    ).env?.VITE_ANALYTICS_CONSENT_MODE?.trim() === 'regional'
        ? 'regional'
        : 'opt-in'

// The browser's time zone stands in for jurisdiction: no geolocation request,
// no IP lookup, nothing that itself needs consent. It is a coarse test on
// purpose and errs toward opt-in — every Europe/* zone counts, EU member or
// not, and so does an unreadable zone.
const OPT_IN_ZONES = new Set([
    'Atlantic/Azores',
    'Atlantic/Canary',
    'Atlantic/Faroe',
    'Atlantic/Madeira',
    'Atlantic/Reykjavik'
])

const inOptInRegion = (): boolean => {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (!zone) return true
        return zone.startsWith('Europe/') || OPT_IN_ZONES.has(zone)
    } catch {
        return true
    }
}

// Whether an undecided visitor is treated as consenting on this build, here.
export const analyticsConsentImplied = (): boolean =>
    consentMode === 'regional' && !inOptInRegion()

const listeners = new Set<() => void>()

export const analyticsConsent = (): AnalyticsConsent => {
    try {
        const value = localStorage.getItem(CONSENT_KEY)
        return value === 'granted' || value === 'denied' ? value : 'unset'
    } catch {
        return 'unset'
    }
}

// What the tag acts on: the visitor's decision when they made one, the
// build's posture for this region when they did not.
export const effectiveAnalyticsConsent = (): 'granted' | 'denied' => {
    const stored = analyticsConsent()
    if (stored !== 'unset') return stored
    return analyticsConsentImplied() ? 'granted' : 'denied'
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