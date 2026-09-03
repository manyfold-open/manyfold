import { SITE_ORIGIN, seoCanonicalUrl, type SeoPageEntry } from '@/seo/pages'
import { tForLanguage } from '@manyfold/i18n'

// Head fragments for the build-time renderer. Kept separate from the script
// so the unit tests can assert on canonical/hreflang/JSON-LD without running
// a full build.

// The headline is baked into the card art, so the image is per-locale — an
// English card on a Chinese page contradicts the page it belongs to. The -v3
// suffix is a cache bust: X holds a card image for about a week and re-fetching
// the same URL is unreliable, so new art means a new filename. Design, copy and
// exporter live in apps/web/scripts/og; these paths must match POSTER_VERSION
// there, and `pnpm social-card:check` fails while they disagree.
export const OG_IMAGE_PATH: Record<SeoPageEntry['language'], string> = {
    en: '/social/manyfold-og-v4.png',
    zh: '/social/manyfold-og-zh-v4.png'
}
export const ORG_LOGO_PATH = '/social/manyfold-logo-512.png'

const LOCALE_TAG: Record<SeoPageEntry['language'], string> = {
    en: 'en-US',
    zh: 'zh-CN'
}

const OG_LOCALE: Record<SeoPageEntry['language'], string> = {
    en: 'en_US',
    zh: 'zh_CN'
}

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')

export const seoJsonLd = (entry: SeoPageEntry): Record<string, unknown> => {
    const canonical = seoCanonicalUrl(entry)
    const organization = {
        '@type': 'Organization',
        '@id': `${SITE_ORIGIN}/#organization`,
        name: 'Manyfold',
        url: `${SITE_ORIGIN}/`,
        logo: {
            '@type': 'ImageObject',
            url: `${SITE_ORIGIN}${ORG_LOGO_PATH}`,
            width: 512,
            height: 512
        }
    }
    const webSite = {
        '@type': 'WebSite',
        '@id': `${SITE_ORIGIN}/#website`,
        name: 'Manyfold',
        url: `${SITE_ORIGIN}/`,
        inLanguage: ['en-US', 'zh-CN'],
        publisher: { '@id': `${SITE_ORIGIN}/#organization` }
    }
    const softwareApplication = {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_ORIGIN}/#software`,
        name: 'Manyfold',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web',
        url: `${SITE_ORIGIN}/`,
        description: tForLanguage('en', entry.def.copy.en.description)
    }
    const webPage = {
        '@type': 'WebPage',
        '@id': `${canonical}#webpage`,
        name: entry.copy.title,
        url: canonical,
        description: entry.copy.description,
        inLanguage: LOCALE_TAG[entry.language],
        isPartOf: { '@id': `${SITE_ORIGIN}/#website` }
    }
    return {
        '@context': 'https://schema.org',
        '@graph': [organization, webSite, softwareApplication, webPage]
    }
}

export interface SeoHeadOptions {
    noindex: boolean
}

export const seoHeadTags = (
    entry: SeoPageEntry,
    options: SeoHeadOptions
): string => {
    const canonical = seoCanonicalUrl(entry)
    const title = escapeHtml(entry.copy.title)
    const description = escapeHtml(entry.copy.description)
    const ogImage = `${SITE_ORIGIN}${OG_IMAGE_PATH[entry.language]}`
    const lines = [
        `<title>${title}</title>`,
        `<meta name="description" content="${description}" />`
    ]
    if (options.noindex) {
        lines.push('<meta name="robots" content="noindex, nofollow" />')
    }
    lines.push(
        `<link rel="canonical" href="${canonical}" />`,
        `<link rel="alternate" hreflang="en" href="${SITE_ORIGIN}${entry.def.paths.en}" />`,
        `<link rel="alternate" hreflang="zh" href="${SITE_ORIGIN}${entry.def.paths.zh}" />`,
        `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${entry.def.paths.en}" />`,
        '<meta property="og:site_name" content="Manyfold" />',
        `<meta property="og:title" content="${title}" />`,
        `<meta property="og:description" content="${description}" />`,
        `<meta property="og:url" content="${canonical}" />`,
        '<meta property="og:type" content="website" />',
        `<meta property="og:locale" content="${OG_LOCALE[entry.language]}" />`,
        `<meta property="og:image" content="${ogImage}" />`,
        '<meta property="og:image:width" content="1200" />',
        '<meta property="og:image:height" content="630" />',
        `<meta property="og:image:alt" content="${tForLanguage(entry.language, 'web.seo.socialImageAlt')}" />`,
        '<meta name="twitter:card" content="summary_large_image" />',
        `<meta name="twitter:title" content="${title}" />`,
        `<meta name="twitter:description" content="${description}" />`,
        `<meta name="twitter:image" content="${ogImage}" />`,
        `<script type="application/ld+json">${JSON.stringify(seoJsonLd(entry))}</script>`
    )
    return lines.join('\n        ')
}

export const htmlLangFor = (entry: SeoPageEntry): string =>
    LOCALE_TAG[entry.language]