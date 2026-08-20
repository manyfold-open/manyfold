import { useEffect, type FC } from 'react'
import { useLocation } from 'react-router-dom'
import {
    analyticsConsent,
    subscribeAnalyticsConsent
} from '@/lib/analyticsConsent'
import { gaPageLocation } from '@/lib/googleAnalyticsUrl'
import { i18nReady } from '@/lib/i18n'
import { pageTitleFor } from '@/lib/pageTitle'

// Read defensively: this module is reachable from node-run unit tests (via
// challengeConfig → trackEvent) where import.meta.env does not exist.
const measurementId = (
    (
        import.meta as unknown as {
            env?: { VITE_GA_MEASUREMENT_ID?: string }
        }
    ).env?.VITE_GA_MEASUREMENT_ID as string | undefined
)?.trim()

// GA gets its own queue rather than the default `dataLayer`: gtag.js uses the
// queue for its own bookkeeping, and the default name is a magnet for
// GTM-style writers (challenge tracking used to be one) that a future
// container might want for itself.
declare global {
    interface Window {
        mfDataLayer?: unknown[]
    }
}

// gtag.js dispatches a queue entry as a command only when it is an Arguments
// object; an array lands in the legacy `_gaq` branch instead and is dropped
// without a trace. The rest parameter exists for call-site typing only.
function gtag(..._args: unknown[]): void {
    // eslint-disable-next-line prefer-rest-params
    window.mfDataLayer?.push(arguments)
}

let reported: string | null = null
let tagLoaded = false
let enabled = false

// Resolved from the route rather than read off document.title: DocumentTitle
// writes that from the same table, but the two are siblings and a page view
// must not depend on which effect React happens to run first.
const reportPageView = (pathname: string, pageLocation: string): void => {
    if (!enabled) return
    if (pageLocation === reported) return
    reported = pageLocation
    // Enhanced measurement events (scroll, outbound click, …) carry no
    // page_location of their own, so they inherit this default instead of
    // reading the raw href.
    gtag('set', { page_location: pageLocation })
    gtag('event', 'page_view', {
        page_location: pageLocation,
        page_title: pageTitleFor(pathname)
    })
}

const loadTag = (): void => {
    if (tagLoaded || !measurementId) return
    tagLoaded = true
    window.mfDataLayer = window.mfDataLayer || []
    gtag('js', new Date())
    // Page views are sent manually; the automatic one would fire before GA
    // can be handed a scrubbed page_location.
    gtag('config', measurementId, { send_page_view: false })
    const script = document.createElement('script')
    script.async = true
    // `l` names the queue gtag.js attaches to; it must match window.mfDataLayer.
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}&l=mfDataLayer`
    document.head.appendChild(script)
}

const gaDisableFlag = (value: boolean): void => {
    if (!measurementId) return
    ;(window as unknown as Record<string, unknown>)[
        `ga-disable-${measurementId}`
    ] = value
}

// Best-effort deletion of GA's first-party cookies on revoke: expire every
// _ga* cookie against each parent domain (GA sets them on the widest scope
// it can, e.g. .manyfold.ai) and without a domain attribute.
const clearGaCookies = (): void => {
    try {
        const names = document.cookie
            .split(';')
            .map((entry) => entry.split('=')[0]?.trim() ?? '')
            .filter((name) => name === '_ga' || name.startsWith('_ga_'))
        const expiry = 'expires=Thu, 01 Jan 1970 00:00:00 GMT'
        const parts = window.location.hostname.split('.')
        for (const name of names) {
            document.cookie = `${name}=; ${expiry}; path=/`
            for (let i = 0; i < parts.length - 1; i += 1) {
                const domain = parts.slice(i).join('.')
                document.cookie = `${name}=; ${expiry}; path=/; domain=.${domain}`
                document.cookie = `${name}=; ${expiry}; path=/; domain=${domain}`
            }
        }
    } catch {
        /* cookie access can throw in exotic embeds; revoke still disables sends */
    }
}

const enableAnalytics = (): void => {
    if (!measurementId || enabled) return
    enabled = true
    gaDisableFlag(false)
    loadTag()
    // Not left to the route effect: AppAuthProvider renders a boot screen —
    // or an error screen — instead of its children until /api/auth/config
    // answers, so on a cold load with stored consent the router (and the
    // effect) does not exist yet.
    reportPageView(
        window.location.pathname,
        gaPageLocation(
            window.location.origin,
            window.location.pathname,
            window.location.search
        )
    )
}

const disableAnalytics = (): void => {
    if (!measurementId) return
    enabled = false
    // Official kill switch: an already-loaded gtag.js stops sending. The
    // script tag cannot be unloaded, but no further network calls happen.
    gaDisableFlag(true)
    clearGaCookies()
}

const initializeAnalytics = (): void => {
    // A returning visitor who already accepted gets analytics from the first
    // paint; everyone else gets zero Google traffic until they accept. Waiting
    // for the initial catalog keeps the first page title in the selected
    // language without requiring top-level await in the production bundle.
    if (measurementId && analyticsConsent() === 'granted') enableAnalytics()

    subscribeAnalyticsConsent(() => {
        if (analyticsConsent() === 'granted') enableAnalytics()
        else disableAnalytics()
    })
}

void i18nReady.then(initializeAnalytics, initializeAnalytics)

// Whether a measurement ID is configured at all — the consent banner has no
// reason to exist on builds (staging, local) that ship without one.
export const analyticsConfigured = Boolean(measurementId)

// Consent-aware product event. Silently drops when GA is not configured or
// consent is absent — call sites never need to know.
export const trackEvent = (
    name: string,
    params?: Record<string, unknown>
): void => {
    if (!enabled) return
    gtag('event', name, params ?? {})
}

export const GoogleAnalytics: FC = () => {
    const { pathname, search } = useLocation()
    useEffect(() => {
        if (!measurementId) return
        reportPageView(
            pathname,
            gaPageLocation(window.location.origin, pathname, search)
        )
    }, [pathname, search])
    return null
}
