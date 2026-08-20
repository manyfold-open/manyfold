import type { Language } from '@manyfold/i18n'
import { docsHref } from '@/lib/docsLinks'
import { seoPageForPath, type SeoLanguage } from '@/seo/pages'

export interface MarketingLinks {
    home: string
    docs: string
    changelog: string
    status: string
    privacy: string
    terms: string
}

export const marketingLinkLanguage = (
    pathname: string,
    uiLanguage: Language
): SeoLanguage =>
    seoPageForPath(pathname)?.language ??
    (uiLanguage === 'zh' ? 'zh' : 'en')

export const marketingLinksFor = (
    language: SeoLanguage
): MarketingLinks => {
    const prefix = language === 'zh' ? '/zh' : ''
    return {
        home: language === 'zh' ? '/zh/' : '/',
        docs: docsHref(`${prefix}/docs/getting-started/`),
        changelog: docsHref(`${prefix}/changelog/`),
        status: docsHref(`${prefix}/status/`),
        privacy: docsHref('/privacy/'),
        terms: docsHref('/terms/')
    }
}
