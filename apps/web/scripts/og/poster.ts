import { readFileSync } from 'node:fs'
import { tForLanguage } from '@manyfold/i18n'
import { POSTER_CSS, POSTER_TEMPLATE } from './paths'

export const POSTER_LOCALES = ['en', 'zh'] as const
export type PosterLocale = (typeof POSTER_LOCALES)[number]

// The card is a still of the landing hero, so it reads the same four keys the
// hero reads. Duplicating the strings here is what let the first exporter fall
// out of step with the catalog while every test stayed green.
export const HERO_KEYS = [
    'web.landing.heroTitleBefore',
    'web.landing.heroTitleAfter',
    'web.landing.heroTitleAccent',
    'web.landing.heroTagline'
] as const

export type HeroKey = (typeof HERO_KEYS)[number]
export type PosterCopy = Record<HeroKey, string>

export const HTML_LANG: Record<PosterLocale, string> = {
    en: 'en',
    zh: 'zh-CN'
}

// The filename carries a version because X holds a card image for about a week
// and re-fetching the same URL is unreliable, so new art needs a new URL. A
// bump is this constant, the freeze below, and the references in
// apps/web/src/seo/head.ts and apps/docs BaseLayout.astro; the contract check
// fails until they agree. Changed bytes are always a bump: a retired version
// keeps its own filename and its own bytes, because clients cache by URL and
// rewriting one is a lie.
export const POSTER_VERSION = 'v4'

export const posterFile = (locale: PosterLocale): string =>
    locale === 'en'
        ? `manyfold-og-${POSTER_VERSION}.png`
        : `manyfold-og-${locale}-${POSTER_VERSION}.png`

export type RetiredCards = Readonly<Record<string, string>>

// Every version that has ever shipped under a name of its own, frozen by the
// bytes it shipped. Cross-app parity cannot express this on its own — rewriting
// both copies to the same new bytes satisfies it — and "a retired version keeps
// its own bytes" is a claim about history, so history has to be written down.
//
// This is the one place a bump freezes anything: in the same commit that moves
// POSTER_VERSION, paste the outgoing version's current sha256s in here, then
// update apps/web/src/seo/head.ts and apps/docs BaseLayout.astro and re-render.
// `pnpm social-card:check` fails with the exact line to paste if you forget.
export const RETIRED_CARDS: RetiredCards = {
    'manyfold-og-v2.png':
        'a4e8f781d4aec10b94c77777e1657156387f4e9092064c7f9b8811caadbe5093',
    'manyfold-og-zh-v2.png':
        '98a903df29f37ff93255fc9fad6d9caed6e50bad36520f7cf8201a29b963d620',
    'manyfold-og-v3.png':
        '9f63be3fc7f2365a48f086515b6f430e9c766d8858fdce6dcf9c34d0841f4e34',
    'manyfold-og-zh-v3.png':
        '558115ecdb6bb8085a26729fed26f6b2064e94843541f44ea9aa88c9e03649cd'
}

// The unversioned name predates the suffix. No page emits it, but pasted links
// and X's own re-fetches still resolve it, so it tracks the current English
// card instead of freezing on a retired one. Always English: it never had a
// locale to carry.
export const ALIAS_FILE = 'manyfold-og.png'
export const ALIAS_LOCALE: PosterLocale = 'en'

export const posterCopy = (locale: PosterLocale): PosterCopy =>
    Object.fromEntries(
        HERO_KEYS.map((key) => [key, tForLanguage(locale, key)])
    ) as PosterCopy

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')

// The hero sets two lines: the statement, then the claim it resolves into.
// Landing.tsx's floor hero composes the same three keys the same way.
const titleHtml = (copy: PosterCopy): string =>
    `${escapeHtml(copy['web.landing.heroTitleBefore'])}<br />` +
    `${escapeHtml(copy['web.landing.heroTitleAfter'])} ` +
    `<span class="p-accent">${escapeHtml(copy['web.landing.heroTitleAccent'])}</span>`

// The tagline is set as two lines, broken at its last clause boundary, which
// is where both catalogs already read as two thoughts. Derived rather than
// hand-placed so a copy edit cannot leave the break stranded mid-phrase; copy
// with no comma stays on one line and the layout assertions still apply.
export const taglineLines = (tagline: string): string[] => {
    const at = Math.max(tagline.lastIndexOf(','), tagline.lastIndexOf('，'))
    if (at < 0 || at === tagline.length - 1) return [tagline]
    return [tagline.slice(0, at + 1), tagline.slice(at + 1).trimStart()]
}

const taglineHtml = (copy: PosterCopy): string =>
    taglineLines(copy['web.landing.heroTagline']).map(escapeHtml).join('<br />')

export interface PosterInput {
    locale: PosterLocale
    copy: PosterCopy
    styles: string
}

export const posterHtml = ({ locale, copy, styles }: PosterInput): string => {
    const template = readFileSync(POSTER_TEMPLATE, 'utf8')
    const filled: Record<string, string> = {
        lang: HTML_LANG[locale],
        locale,
        styles,
        title: titleHtml(copy),
        tagline: taglineHtml(copy)
    }
    return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
        if (!(key in filled))
            throw new Error(`poster.template.html has no value for ${whole}`)
        return filled[key]
    })
}

export const posterCss = (): string => readFileSync(POSTER_CSS, 'utf8')
