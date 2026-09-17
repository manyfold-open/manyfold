import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useI18n } from '@/lib/i18n'
import { seoPageForPath } from '@/seo/pages'

// Indexable marketing URLs carry their language in the path (`/` is English,
// `/zh/...` is Chinese) so the crawler HTML and the hydrated page agree. The
// pin is transient: it must not overwrite the visitor's stored product
// language just because they read a marketing page.
export const useMarketingLanguagePin = (): void => {
    const { setLanguage } = useI18n()
    const { pathname } = useLocation()
    const target = seoPageForPath(pathname)?.language ?? null
    useEffect(() => {
        if (target !== null) {
            // A late catalog must not follow the visitor out of this URL.
            return setLanguage(target, { persist: false })
        }
    }, [pathname, target, setLanguage])
}
