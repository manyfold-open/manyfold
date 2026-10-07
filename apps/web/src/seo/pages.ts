import { EDITION_SEO_PAGES } from '@/seo/editionPages'
import { tForLanguage } from '@manyfold/i18n'

// The single source of truth for every indexable marketing URL: React routes,
// the build-time prerender, the title resolver, robots/sitemap and the tests
// all consume this manifest so head metadata, tab titles and GA page titles
// cannot drift apart.
//
// Adding a page means a definition here (or in the editions slot below, for
// a page only one composition has) and a route in App.tsx: the build
// prerenders that route itself (ADR-0042), and every other consumer follows.

export const SITE_ORIGIN = 'https://manyfold.ai'

export type SeoLanguage = 'en' | 'zh'

/* `h1` is not rendered from here: it is the page's own headline as one line,
   which the prerender test holds the page to. */
export interface SeoPageCopy {
    title: string
    description: string
    h1: string
}

export interface SeoPageDefinition {
    /* 'home' and 'channels' here; an editions slot page brings its own. The
       nav compares against it to mark the current page. */
    key: string
    paths: Record<SeoLanguage, string>
    copy: Record<SeoLanguage, SeoPageCopy>
    /* Set by an editions slot page whose copy is composition-owned rather
       than a core i18n namespace: `copy` then holds finished text instead of
       catalogue keys, and nothing looks it up. A commercial argument has no
       place in the open-source catalogue, and machine-translating it into
       nine locales for a page that does not exist there buys nothing. */
    ownCopy?: boolean
}

const home: SeoPageDefinition = {
    key: 'home',
    paths: { en: '/', zh: '/zh/' },
    copy: {
        en: {
            title: 'web.seoPage.home.title',
            description: 'web.seoPage.home.description',
            h1: 'web.seoPage.home.h1'
        },
        zh: {
            title: 'web.seoPage.home.title',
            description: 'web.seoPage.home.description',
            h1: 'web.seoPage.home.h1'
        }
    }
}

/* The acquisition page for the channel integrations. Its copy keys are the
   page's own, with the meta description and a one-line h1 (the page splits
   its headline across two spans) written the way the home page's are.

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
    copy: {
        en: {
            title: 'web.channelsPage.docTitle',
            description: 'web.seoPage.channels.description',
            h1: 'web.seoPage.channels.h1'
        },
        zh: {
            title: 'web.channelsPage.docTitle',
            description: 'web.seoPage.channels.description',
            h1: 'web.seoPage.channels.h1'
        }
    }
}

export const SEO_PAGES: SeoPageDefinition[] = [
    home,
    channels,
    ...EDITION_SEO_PAGES
]

const passThroughCopy = (keys: SeoPageCopy): SeoPageCopy => ({ ...keys })

const resolveCopy = (
    keys: SeoPageCopy,
    language: SeoLanguage
): SeoPageCopy => ({
    title: tForLanguage(language, keys.title),
    description: tForLanguage(language, keys.description),
    h1: tForLanguage(language, keys.h1)
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

export const seoPageEntries = (): SeoPageEntry[] =>
    SEO_PAGES.flatMap((def) =>
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
