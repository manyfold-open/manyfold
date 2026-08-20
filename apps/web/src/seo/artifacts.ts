import {
    SITE_ORIGIN,
    seoCanonicalUrl,
    seoPageEntries,
    type SeoPageEntry
} from '@/seo/pages'
import { htmlLangFor, seoHeadTags } from '@/seo/head'
import { tForLanguage } from '@manyfold/i18n'

// Pure builders for everything the post-build renderer writes to dist/, so
// the unit tests can assert on robots, sitemap and page HTML without running
// a vite build.

export type WebEnv = 'production' | 'staging'

export const resolveWebEnv = (raw: string | undefined): WebEnv =>
    raw === 'production' ? 'production' : 'staging'

// Route families owned by the SPA. Order-independent: the Caddy config and
// robots.txt are both generated from this list so the serving boundary and
// the crawl policy cannot disagree.
export const SPA_ROUTE_PREFIXES = [
    '/login',
    '/cli-login',
    '/connect',
    '/grant-permission',
    '/invite',
    '/workspace',
    '/agents',
    '/automations',
    '/skills',
    '/mcp',
    '/connections',
    '/connectors',
    '/settings',
    '/agent-runtimes',
    '/usage',
    '/challenge',
    '/chat'
]

export const buildRobotsTxt = (env: WebEnv): string => {
    if (env !== 'production') {
        return ['User-agent: *', 'Disallow: /', ''].join('\n')
    }
    const disallows = [...SPA_ROUTE_PREFIXES, '/r'].map(
        (prefix) => `Disallow: ${prefix}`
    )
    const allows = seoPageEntries().map((entry) => `Allow: ${entry.path}`)
    return [
        'User-agent: *',
        ...allows,
        ...disallows,
        '',
        `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
        'Sitemap: https://docs.manyfold.ai/sitemap-index.xml',
        ''
    ].join('\n')
}

export const buildSitemapXml = (): string => {
    const urls = seoPageEntries()
        .map((entry) => {
            const en = `${SITE_ORIGIN}${entry.def.paths.en}`
            const zh = `${SITE_ORIGIN}${entry.def.paths.zh}`
            return [
                '    <url>',
                `        <loc>${seoCanonicalUrl(entry)}</loc>`,
                `        <xhtml:link rel="alternate" hreflang="en" href="${en}" />`,
                `        <xhtml:link rel="alternate" hreflang="zh" href="${zh}" />`,
                `        <xhtml:link rel="alternate" hreflang="x-default" href="${en}" />`,
                '    </url>'
            ].join('\n')
        })
        .join('\n')
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        urls,
        '</urlset>',
        ''
    ].join('\n')
}

const TITLE_TAG = '<title>Manyfold</title>'
const ROOT_DIV = '<div id="root"></div>'
const RENDER_MARKER = '<!-- mf-static-render -->'

const assertPristineShell = (shell: string, needsRoot: boolean): void => {
    if (shell.includes(RENDER_MARKER)) {
        throw new Error(
            'dist/index.html is already a rendered marketing page — run `vite build` again before re-running the static renderer'
        )
    }
    if (
        !shell.includes(TITLE_TAG) ||
        (needsRoot && !shell.includes(ROOT_DIV))
    ) {
        throw new Error(
            'index.html shell drifted: expected placeholder <title> and empty #root'
        )
    }
}

export interface PageHtmlOptions {
    entry: SeoPageEntry
    bodyHtml: string
    env: WebEnv
    preloadTags?: string
}

// The vite-emitted index.html is the shell: it already carries the hashed
// script/stylesheet tags, favicon and the theme bootstrap. Marketing pages
// replace its placeholder title with full head metadata and pre-fill #root
// with the crawler-visible body; React replaces that body when it boots.
export const buildPageHtml = (
    shell: string,
    { entry, bodyHtml, env, preloadTags }: PageHtmlOptions
): string => {
    assertPristineShell(shell, true)
    const head = [
        RENDER_MARKER,
        seoHeadTags(entry, { noindex: env !== 'production' })
    ].join('\n        ')
    return shell
        .replace('<html lang="en">', `<html lang="${htmlLangFor(entry)}">`)
        .replace(
            TITLE_TAG,
            head + (preloadTags ? `\n        ${preloadTags}` : '')
        )
        .replace(ROOT_DIV, `<div id="root">${bodyHtml}</div>`)
}

// Product and auth routes get a shell with no marketing body. The meta tag
// backs up the X-Robots-Tag header Caddy adds for the SPA route families —
// private surfaces are never indexable regardless of how they get served.
export const buildAppHtml = (shell: string, preloadTags?: string): string => {
    assertPristineShell(shell, false)
    const head = [
        TITLE_TAG,
        '<meta name="robots" content="noindex, nofollow" />'
    ].join('\n        ')
    return shell.replace(
        TITLE_TAG,
        head + (preloadTags ? `\n        ${preloadTags}` : '')
    )
}

export const build404Html = (): string =>
    [
        '<!doctype html>',
        '<html lang="en">',
        '    <head>',
        '        <meta charset="UTF-8" />',
        '        <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        '        <meta name="robots" content="noindex" />',
        `        <title>${tForLanguage('en', 'web.seo.notFoundTitle')}</title>`,
        '        <style>',
        '            body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }',
        '            main { text-align: center; padding: 2rem; }',
        '            a { color: #58a6ff; }',
        '        </style>',
        '    </head>',
        '    <body>',
        '        <main>',
        `            <h1>${tForLanguage('en', 'web.seo.notFoundHeading')}</h1>`,
        `            <p>${tForLanguage('en', 'web.seo.notFoundBody')}</p>`,
        `            <p><a href="/">${tForLanguage('en', 'web.seo.notFoundBack')}</a></p>`,
        '        </main>',
        '    </body>',
        '</html>',
        ''
    ].join('\n')