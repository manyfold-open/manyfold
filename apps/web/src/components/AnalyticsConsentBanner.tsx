import { useEffect, useState, type FC, type ReactNode } from 'react'
import {
    analyticsConsent,
    setAnalyticsConsent,
    subscribeConsentPrompt
} from '@/lib/analyticsConsent'
import { analyticsConfigured } from '@/lib/googleAnalytics'
import { docsHref } from '@/lib/docsLinks'
import { useI18n } from '@/lib/i18n'

// Basic analytics consent: Google gets zero traffic until Accept, and Accept
// and Decline carry equal visual weight (ICO guidance — no dark patterns).
// Rendered outside AppAuthProvider so it exists even while the boot screen
// holds the rest of the app hostage.
//
// It floats over whatever page is mounted, so it stacks above page chrome and
// clears any bar a page pins to the bottom edge — `--app-bottom-inset` is that
// page's live bar height, and with no bar the fallback keeps the card off the
// home indicator. Seen on iOS Chrome [2026-08-10]: the challenge page's mobile
// CTA bar (same z-index, later in the DOM) covered both buttons, leaving no
// visible or tappable way to answer.
const AnalyticsConsentBanner: FC = (): ReactNode => {
    const { t } = useI18n()
    const [visible, setVisible] = useState(
        () => analyticsConfigured && analyticsConsent() === 'unset'
    )
    useEffect(
        () =>
            subscribeConsentPrompt(() => {
                if (analyticsConfigured) setVisible(true)
            }),
        []
    )
    if (!visible) return null
    const choose = (value: 'granted' | 'denied'): void => {
        setAnalyticsConsent(value)
        setVisible(false)
    }
    return (
        <div
            role='region'
            aria-label={t('web.consent.settingsTitle')}
            className='popover-panel bg-surface-elevated shadow-elevated consent-banner fixed left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col gap-3 rounded-md p-4 sm:flex-row sm:items-center'
        >
            <p className='text-ui text-fg min-w-0 flex-1'>
                {t('web.consent.message')}{' '}
                <a
                    href={docsHref('/privacy')}
                    target='_blank'
                    rel='noreferrer'
                    className='underline underline-offset-2'
                >
                    {t('web.consent.privacyLink')}
                </a>
            </p>
            <div className='flex shrink-0 items-center gap-2'>
                <button
                    type='button'
                    className='workbench-button-secondary h-8 px-3'
                    onClick={() => choose('denied')}
                >
                    {t('web.consent.decline')}
                </button>
                <button
                    type='button'
                    className='workbench-button-secondary h-8 px-3'
                    onClick={() => choose('granted')}
                >
                    {t('web.consent.accept')}
                </button>
            </div>
        </div>
    )
}

export default AnalyticsConsentBanner