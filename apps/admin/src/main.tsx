// First import so Sentry is initialised before anything else can throw.
import { Sentry, SentryUserSync } from '@/lib/sentry'
import '@/lib/i18n-extra'
import '@/lib/editionFrameworks'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from '@/App'
import { ADMIN_EDITION } from '@/edition'
import AppCrashFallback from '@/components/AppCrashFallback'
import { AppAuthProvider } from '@/lib/auth'
import { WebVitals, browserTelemetry } from '@/lib/axiom'
import '@/styles.css'

browserTelemetry.install(window, document)

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
