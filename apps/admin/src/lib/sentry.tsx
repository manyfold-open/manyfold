import { useEffect, type FC } from 'react'
import {
    createRoutesFromChildren,
    matchRoutes,
    Routes,
    useLocation,
    useNavigationType
} from 'react-router-dom'
import * as Sentry from '@sentry/react'
import { useAppAuth } from '@/lib/auth'
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@/lib/sentryScrub'

const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined)?.trim()

const environment =
    (import.meta.env.VITE_MF_ENV as string | undefined) ||
    (import.meta.env.VITE_NCA_ENV as string | undefined) ||
    (import.meta.env.DEV ? 'local' : 'production')

if (dsn) {
    Sentry.init({
        dsn,
        release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
        environment,
        sendDefaultPii: false,
        integrations: [
            Sentry.reactRouterV6BrowserTracingIntegration({
                useEffect,
                useLocation,
                useNavigationType,
                createRoutesFromChildren,
                matchRoutes
            })
        ],
        tracesSampleRate: environment === 'production' ? 0.2 : 1,
        // No sentry-trace/baggage headers on API calls yet: continuing the trace
        // server-side would re-parent the API's root spans and reshape the
        // traces the Axiom dashboards are built on.
        tracePropagationTargets: [],
        beforeSend: scrubSentryEvent,
        beforeSendTransaction: scrubSentryEvent,
        beforeBreadcrumb: scrubSentryBreadcrumb
    })
}

// Falls back to a plain <Routes> when Sentry never initialised.
export const SentryRoutes = Sentry.withSentryReactRouterV6Routing(Routes)

export const SentryUserSync: FC = () => {
    const { isSignedIn, user } = useAppAuth()
    const userId = user?.id ?? null
    useEffect(() => {
        if (!dsn) return
        // id only: emails are PII we have no reason to ship to a third party
        Sentry.setUser(isSignedIn && userId ? { id: userId } : null)
    }, [isSignedIn, userId])
    return null
}

export { Sentry }