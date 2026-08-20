import { docsHref } from '@/lib/docsLinks'
import { tForLanguage } from '@manyfold/i18n'

// The single source of truth for every indexable marketing URL: React routes,
// the build-time static renderer, the title resolver, robots/sitemap and the
// tests all consume this manifest so crawler HTML, hydrated content, tab
// titles and GA page titles cannot drift apart.
//
// Today that is the landing page in English and Simplified Chinese. Dedicated
// acquisition pages are a separate design track (#534); adding one means
// adding a definition here and a route in App.tsx, and every consumer follows.

export const SITE_ORIGIN = 'https://manyfold.ai'

export type SeoLanguage = 'en' | 'zh'

export interface SeoCta {
    label: string
    href: string
}

export interface SeoPageCopy {
    title: string
    description: string
    h1: string
    lead: string
    ctaTitle: string
    ctaPrimary: SeoCta
    ctaSecondary: SeoCta
    docsLinksLabel: string
    docsLinks: SeoCta[]
}

interface SeoPageCopyKeys {
    title: string
    description: string
    h1: string
    lead: string
    ctaTitle: string
    ctaPrimary: SeoCta
    ctaSecondary: SeoCta
    docsLinksLabel: string
    docsLinks: SeoCta[]
}

export interface SeoPageDefinition {
    key: 'home'
    paths: Record<SeoLanguage, string>
    copy: Record<SeoLanguage, SeoPageCopyKeys>
}

const zhDocs = (path: string): string => docsHref(`/zh${path}`)

const home: SeoPageDefinition = {
    key: 'home',
    paths: { en: '/', zh: '/zh/' },
    copy: {
        en: {
            title: 'web.seoPage.home.title',
            description: 'web.seoPage.home.description',
            h1: 'web.seoPage.home.h1',
            lead: 'web.seoPage.home.lead',
            ctaTitle: 'web.seoPage.home.ctaTitle',
            ctaPrimary: {
                label: 'web.seoPage.home.ctaPrimary',
                href: '/login'
            },
            ctaSecondary: {
                label: 'web.seoPage.home.ctaSecondary',
                href: docsHref('/docs/getting-started/')
            },
            docsLinksLabel: 'web.seoPage.home.docsLinksLabel',
            docsLinks: [
                {
                    label: 'web.seoPage.home.docsGettingStarted',
                    href: docsHref('/docs/getting-started/')
                },
                {
                    label: 'web.seoPage.home.docsWorkspace',
                    href: docsHref('/docs/workspace/')
                },
                {
                    label: 'web.seoPage.home.docsCreateAgent',
                    href: docsHref('/docs/create-agent/')
                },
                {
                    label: 'web.seoPage.home.docsChannels',
                    href: docsHref('/docs/channels/')
                }
            ]
        },
        zh: {
            title: 'web.seoPage.home.title',
            description: 'web.seoPage.home.description',
            h1: 'web.seoPage.home.h1',
            lead: 'web.seoPage.home.lead',
            ctaTitle: 'web.seoPage.home.ctaTitle',
            ctaPrimary: {
                label: 'web.seoPage.home.ctaPrimary',
                href: '/login'
            },
            ctaSecondary: {
                label: 'web.seoPage.home.ctaSecondary',
                href: zhDocs('/docs/getting-started/')
            },
            docsLinksLabel: 'web.seoPage.home.docsLinksLabel',
            docsLinks: [
                {
                    label: 'web.seoPage.home.docsGettingStarted',
                    href: zhDocs('/docs/getting-started/')
                },
                {
                    label: 'web.seoPage.home.docsWorkspace',
                    href: zhDocs('/docs/workspace/')
                },
                {
                    label: 'web.seoPage.home.docsCreateAgent',
                    href: zhDocs('/docs/create-agent/')
                },
                {
                    label: 'web.seoPage.home.docsChannels',
                    href: zhDocs('/docs/channels/')
                }
            ]
        }
    }
}

export const SEO_PAGES: SeoPageDefinition[] = [home]

const resolveCopy = (
    keys: SeoPageCopyKeys,
    language: SeoLanguage
): SeoPageCopy => ({
    title: tForLanguage(language, keys.title),
    description: tForLanguage(language, keys.description),
    h1: tForLanguage(language, keys.h1),
    lead: tForLanguage(language, keys.lead),
    ctaTitle: tForLanguage(language, keys.ctaTitle),
    ctaPrimary: {
        label: tForLanguage(language, keys.ctaPrimary.label),
        href: keys.ctaPrimary.href
    },
    ctaSecondary: {
        label: tForLanguage(language, keys.ctaSecondary.label),
        href: keys.ctaSecondary.href
    },
    docsLinksLabel: tForLanguage(language, keys.docsLinksLabel),
    docsLinks: keys.docsLinks.map((link) => ({
        label: tForLanguage(language, link.label),
        href: link.href
    }))
})

export interface SeoPageEntry {
    def: SeoPageDefinition
    language: SeoLanguage
    path: string
    copy: SeoPageCopy
}

export const seoPageEntries = (): SeoPageEntry[] =>
    SEO_PAGES.flatMap((def) =>
        (['en', 'zh'] as const).map((language) => ({
            def,
            language,
            path: def.paths[language],
            copy: resolveCopy(def.copy[language], language)
        }))
    )

// '/zh' and '/zh/' are the same page.
const normalizePath = (pathname: string): string => {
    if (pathname === '') return '/'
    return pathname.endsWith('/') ? pathname : `${pathname}/`
}

export const seoPageForPath = (pathname: string): SeoPageEntry | null => {
    const normalized = normalizePath(pathname)
    for (const entry of seoPageEntries()) {
        if (normalizePath(entry.path) === normalized) return entry
    }
    return null
}

// The auth boot gate and the language pin both key off this: indexable
// marketing URLs must render without waiting for the auth config round trip.
export const isMarketingPath = (pathname: string): boolean =>
    seoPageForPath(pathname) !== null

export const seoTitleForPath = (pathname: string): string | null =>
    seoPageForPath(pathname)?.copy.title ?? null

export const seoCanonicalUrl = (entry: SeoPageEntry): string =>
    `${SITE_ORIGIN}${entry.path}`