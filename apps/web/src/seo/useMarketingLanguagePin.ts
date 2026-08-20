import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useI18n } from '@/lib/i18n'
import { seoPageForPath } from '@/seo/pages'
import { shouldPinMarketingLanguage } from '@/components/marketing/marketingLanguage'

// Indexable marketing URLs carry their language in the path (`/` is English,
// `/zh/...` is Chinese) so the crawler HTML and the hydrated page agree. The
// pin is transient: it must not overwrite the visitor's stored product
// language just because they read a marketing page.
export const useMarketingLanguagePin = (): void => {
    const { language, setLanguage } = useI18n()
    const { pathname } = useLocation()
    const lastPinnedPathname = useRef<string | null>(null)
    const target = seoPageForPath(pathname)?.language ?? null
    useEffect(() => {
        const shouldPin = shouldPinMarketingLanguage(
            pathname,
            lastPinnedPathname.current,
            target
        )
        lastPinnedPathname.current = pathname
        if (!shouldPin) {
            return
        }
        if (target !== null && target !== language) {
            setLanguage(target, { persist: false })
        }
    }, [pathname, target, language, setLanguage])
}