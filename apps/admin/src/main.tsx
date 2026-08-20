// First import so Sentry is initialised before anything else can throw.
import { Sentry, SentryUserSync } from '@/lib/sentry'
import '@/lib/i18n-extra'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from '@/App'
import { ADMIN_EDITION } from '@/edition'
import AppCrashFallback from '@/components/AppCrashFallback'
import { AppAuthProvider } from '@/lib/auth'
import { WebVitals, logger } from '@/lib/axiom'
import '@/styles.css'

window.addEventListener('error', (event) => {
    logger.error('window.error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error?.stack ?? String(event.error ?? '')
    })
})
window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    logger.error('unhandledrejection', {
        reason:
            reason instanceof Error
                ? (reason.stack ?? reason.message)
                : String(reason)
    })
})

document.documentElement.dataset.mfEdition = ADMIN_EDITION

createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <AppAuthProvider>
            <SentryUserSync />
            <BrowserRouter>
                <WebVitals />
                <Sentry.ErrorBoundary fallback={<AppCrashFallback />}>
                    <App />
                </Sentry.ErrorBoundary>
            </BrowserRouter>
        </AppAuthProvider>
    </StrictMode>
)
