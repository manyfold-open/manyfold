// Attribution first: it consumes the short-link touch token and strips it
// from the URL before anything can observe it — including Sentry's pageload
// transaction and GA's module-init page view.
import '@/lib/attribution'
// Sentry next so it is initialised before anything else can throw.
import { Sentry, SentryUserSync } from '@/lib/sentry'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from '@/App'
import { WEB_EDITION } from '@/edition'
import AnalyticsConsentBanner from '@/components/AnalyticsConsentBanner'
import AppCrashFallback from '@/components/AppCrashFallback'
import { AppAuthProvider } from '@/lib/auth'
import { FontSizeProvider } from '@/lib/fontSize'
import { I18nProvider, i18nReady } from '@/lib/i18n'
import { ThemeProvider } from '@/lib/theme'
import { WebVitals, logger, browserTelemetry } from '@/lib/axiom'
import { GoogleAnalytics } from '@/lib/googleAnalytics'
import { DocumentTitle } from '@/lib/pageTitle'
import { installPreloadErrorRecovery } from '@/lib/lazyChunk'
import { chatStreamStore } from '@/lib/chatStreamStore'
import '@/styles.css'

installPreloadErrorRecovery()

// Operational telemetry, not product analytics: a chat tab losing its SSE
// stream was invisible until a user complained (#640). It goes to the same
// Axiom logger as window.error rather than the consent-gated GA data layer,
// and a recovered stream is only informational — the drop and the fallback
// are what an operator needs to find.
chatStreamStore.setTelemetry((event) => {
    if (event.name === 'chat.sse.reconnected') logger.info(event.name, event)
    else logger.warn(event.name, event)
})

browserTelemetry.install(window, document)

const renderApp = (): void => {
    document.documentElement.dataset.mfEdition = WEB_EDITION
    createRoot(document.getElementById('root') as HTMLElement).render(
        <StrictMode>
            <I18nProvider>
                <AnalyticsConsentBanner />
                <AppAuthProvider>
                    <SentryUserSync />
                    <ThemeProvider>
                        <FontSizeProvider>
                            <BrowserRouter>
                                <WebVitals />
                                <DocumentTitle />
                                <GoogleAnalytics />
                                <Sentry.ErrorBoundary
                                    fallback={<AppCrashFallback />}
                                >
                                    <App />
                                </Sentry.ErrorBoundary>
                            </BrowserRouter>
                        </FontSizeProvider>
                    </ThemeProvider>
                </AppAuthProvider>
            </I18nProvider>
        </StrictMode>
    )
}

void i18nReady.then(renderApp, renderApp)
