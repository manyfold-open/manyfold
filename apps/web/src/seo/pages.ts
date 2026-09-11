import { docsHref } from '@/lib/docsLinks'
import { EDITION_SEO_PAGES } from '@/seo/editionPages'
import { tForLanguage } from '@manyfold/i18n'

// The single source of truth for every indexable marketing URL: React routes,
// the build-time static renderer, the title resolver, robots/sitemap and the
// tests all consume this manifest so crawler HTML, hydrated content, tab
// titles and GA page titles cannot drift apart.
//
// Adding a page means a definition here (or in the editions slot below, for
// a page only one composition has), a route in App.tsx and a crawler
// snapshot in seo/snapshots.tsx; every other consumer follows.

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
    /* 'home' and 'channels' here; an editions slot page brings its own. The
       key names the crawler snapshot to render (seo/snapshots.tsx) and is
       what the nav compares against to mark the current page. */
    key: string
    paths: Record<SeoLanguage, string>
    copy: Record<SeoLanguage, SeoPageCopyKeys>
    /* Set by an editions slot page whose copy is composition-owned rather
       than a core i18n namespace: `copy` then holds finished text instead of
       catalogue keys, and nothing looks it up. A commercial argument has no
       place in the open-source catalogue, and machine-translating it into
       nine locales for a page that does not exist there buys nothing. */
    ownCopy?: boolean
    /* Short name for this page's link in the crawler footer, per language.
       The home page has none — the brand mark already leads there. Resolved
       the way `copy` is: a catalogue key unless `ownCopy`. */
    footerLabel?: Record<SeoLanguage, string>
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

/* The acquisition page for the channel integrations. Its copy keys are the
   page's own — the snapshot and the live page must say the same thing — with
   the meta description, a one-line h1 (the page splits its headline across
   two spans) and the CTA heading written for the crawler, the way the home
   page's are: the live page ends on its app grid and has only the hero's
   pair of buttons, so the snapshot's closing call has no on-page twin to
   quote.

   The route is `/agent-channels`, not `/channels`. A URL travels without the
   site around it — a search result, a pasted link — and a bare `/channels` on
   this domain reads as somebody's chat rooms rather than as the apps an agent
   is reachable from. The qualifier answers whose. It stays `channels` rather
   than becoming `integrations`, which would promise skills, MCP and A2A as
   well, or `chat`, which would disown the two issue trackers. The nav label
   is still the bare word: a label is always read inside the site that owns
   it, so it does not need the qualifier the URL does. */
const channels: SeoPageDefinition = {
    key: 'channels',
    paths: { en: '/agent-channels', zh: '/zh/agent-channels' },
    footerLabel: {
        en: 'web.landing.navChannels',
        zh: 'web.landing.navChannels'
    },
    copy: {
        en: {
            title: 'web.channelsPage.docTitle',
            description: 'web.seoPage.channels.description',
            h1: 'web.seoPage.channels.h1',
            lead: 'web.channelsPage.heroLead',
            ctaTitle: 'web.seoPage.channels.ctaTitle',
            ctaPrimary: {
                label: 'web.channelsPage.heroPrimary',
                href: '/login'
            },
            ctaSecondary: {
                label: 'web.channelsPage.heroSecondary',
                href: docsHref('/docs/channels/')
            },
            docsLinksLabel: 'web.seoPage.home.docsLinksLabel',
            docsLinks: [
                {
                    label: 'web.seoPage.home.docsChannels',
                    href: docsHref('/docs/channels/')
                },
                {
                    label: 'web.seoPage.home.docsCreateAgent',
                    href: docsHref('/docs/create-agent/')
                },
                {
                    label: 'web.seoPage.home.docsGettingStarted',
                    href: docsHref('/docs/getting-started/')
                }
            ]
        },
        zh: {
            title: 'web.channelsPage.docTitle',
            description: 'web.seoPage.channels.description',
            h1: 'web.seoPage.channels.h1',
            lead: 'web.channelsPage.heroLead',
            ctaTitle: 'web.seoPage.channels.ctaTitle',
            ctaPrimary: {
                label: 'web.channelsPage.heroPrimary',
                href: '/login'
            },
            ctaSecondary: {
                label: 'web.channelsPage.heroSecondary',
                href: zhDocs('/docs/channels/')
            },
            docsLinksLabel: 'web.seoPage.home.docsLinksLabel',
            docsLinks: [
                {
                    label: 'web.seoPage.home.docsChannels',
                    href: zhDocs('/docs/channels/')
                },
                {
                    label: 'web.seoPage.home.docsCreateAgent',
                    href: zhDocs('/docs/create-agent/')
                },
                {
                    label: 'web.seoPage.home.docsGettingStarted',
                    href: zhDocs('/docs/getting-started/')
                }
            ]
        }
    }
}

export const SEO_PAGES: SeoPageDefinition[] = [
    home,
    channels,
    ...EDITION_SEO_PAGES
]

const passThroughCopy = (keys: SeoPageCopyKeys): SeoPageCopy => ({ ...keys })

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

export const seoPageCopy = (
    def: SeoPageDefinition,
    language: SeoLanguage
): SeoPageCopy =>
    def.ownCopy
        ? passThroughCopy(def.copy[language])
        : resolveCopy(def.copy[language], language)

/* `extra` is for the post-build renderer only: it runs under tsx, where the
   vite overlay resolver does not apply, so a composition's pages arrive as
   an argument instead of through SEO_PAGES. In the browser they are already
   in SEO_PAGES and this stays empty — the two never both carry them. */
export const seoPageEntries = (
    extra: SeoPageDefinition[] = []
): SeoPageEntry[] =>
    [...SEO_PAGES, ...extra].flatMap((def) =>
        (['en', 'zh'] as const).map((language) => ({
            def,
            language,
            path: def.paths[language],
            copy: seoPageCopy(def, language)
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

export interface SeoFooterLink {
    path: string
    label: string
}

/* The manifest pages the crawler footer links. It stays the short list — that
   footer exists to give a crawler something, not to mirror the real one — but
   an indexable page needs an inbound link from every indexed document, and
   the sitemap is not the only way a page gets found. `extra` is the
   post-build renderer's channel for a composition's pages, as on
   seoPageEntries. */
export const seoFooterLinks = (
    language: SeoLanguage,
    extra: SeoPageDefinition[] = []
): SeoFooterLink[] =>
    [...SEO_PAGES, ...extra].flatMap((def) => {
        const label = def.footerLabel?.[language]
        if (label === undefined) return []
        return [
            {
                path: def.paths[language],
                label: def.ownCopy ? label : tForLanguage(language, label)
            }
        ]
    })