import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLanguage } from '@manyfold/i18n'
import {
    SEO_PAGES,
    SITE_ORIGIN,
    isMarketingPath,
    seoCanonicalUrl,
    seoPageEntries,
    seoPageForPath,
    seoTitleForPath
} from '../src/seo/pages'
import { OG_IMAGE_PATH, seoHeadTags, seoJsonLd } from '../src/seo/head'
import {
    SPA_ROUTE_PREFIXES,
    build404Html,
    buildAppHtml,
    buildPageHtml,
    buildRobotsTxt,
    buildSitemapXml,
    resolveWebEnv
} from '../src/seo/artifacts'
import { LandingSnapshot } from '../src/seo/LandingSnapshot'
import { renderMarketingBody } from '../src/seo/renderStatic'
import { pageTitleFor } from '../src/lib/pageTitle'

const entries = seoPageEntries()

const SHELL = [
    '<!doctype html>',
    '<html lang="en">',
    '    <head>',
    '        <title>Manyfold</title>',
    '    </head>',
    '    <body>',
    '        <div id="root"></div>',
    '    </body>',
    '</html>'
].join('\n')

test('the manifest defines the indexable pages as en/zh pairs', () => {
    assert.deepEqual(entries.map((entry) => entry.path).sort(), ['/', '/zh/'])
    assert.equal(entries.length, SEO_PAGES.length * 2)
})

test('titles, descriptions, H1s and paths are unique across all pages', () => {
    for (const field of ['title', 'description', 'h1'] as const) {
        const values = entries.map((entry) => entry.copy[field])
        assert.equal(
            new Set(values).size,
            values.length,
            `duplicate ${field}: ${values.join(' | ')}`
        )
    }
    const paths = entries.map((entry) => entry.path)
    assert.equal(new Set(paths).size, paths.length)
})

test('every zh path is the en path under the /zh/ prefix', () => {
    for (const def of SEO_PAGES) {
        assert.equal(
            def.paths.zh,
            def.paths.en === '/' ? '/zh/' : `/zh${def.paths.en}`
        )
    }
})

test('path lookup normalizes trailing slashes and rejects everything else', () => {
    assert.equal(seoPageForPath('/zh')?.language, 'zh')
    assert.equal(seoPageForPath('/zh/')?.language, 'zh')
    assert.equal(seoPageForPath('/')?.language, 'en')
    assert.equal(seoPageForPath('/workspace'), null)
    assert.equal(seoPageForPath('/login'), null)
    assert.equal(seoPageForPath('/zh/unknown'), null)
    assert.ok(isMarketingPath('/'))
    assert.ok(!isMarketingPath('/agents/abc'))
})

// Every manifest path needs a route, or a client-side navigation to it falls
// through to the catch-all redirect while the crawler still sees a real page.
test('every manifest path has a matching route in App.tsx', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const declared = new Set(
        [...app.matchAll(/path='(\/[^']*)'/g)].map((m) => m[1])
    )
    for (const entry of entries) {
        const route = entry.path === '/' ? '/' : entry.path.replace(/\/$/, '')
        assert.ok(
            declared.has(route),
            `App.tsx has no route for manifest path ${entry.path}`
        )
    }
})

test('marketing titles resolve from the manifest in the URL language', () => {
    assert.equal(
        pageTitleFor('/'),
        'Manyfold — AI Agent Workspace for Coding Agents'
    )
    assert.equal(pageTitleFor('/zh/'), seoTitleForPath('/zh/'))
    assert.ok(pageTitleFor('/zh/')?.includes('工作台'))
    // Non-marketing routes keep the table-driven titles.
    assert.equal(pageTitleFor('/workspace'), 'Workspace · Manyfold')
})

test('rendered bodies carry exactly one H1 matching the manifest', () => {
    for (const entry of entries) {
        setLanguage(entry.language)
        const html = renderToStaticMarkup(
            createElement(LandingSnapshot, { entry })
        )
        const h1s = html.match(/<h1[\s>]/g) ?? []
        assert.equal(h1s.length, 1, `${entry.path} has ${h1s.length} H1s`)
        assert.ok(
            html.includes(entry.copy.h1),
            `${entry.path} body is missing its H1 text`
        )
        assert.ok(
            html.includes(entry.copy.ctaPrimary.href),
            `${entry.path} body is missing its primary CTA`
        )
    }
    setLanguage('en')
})

test('rendered bodies open the landing style scope', () => {
    for (const entry of entries) {
        setLanguage(entry.language)
        assert.ok(
            renderMarketingBody(entry).startsWith('<div class="landing-root">'),
            `${entry.path} body would paint unstyled until React boots`
        )
    }
    setLanguage('en')
})

test('head tags carry canonical, reciprocal hreflang and x-default', () => {
    for (const entry of entries) {
        const head = seoHeadTags(entry, { noindex: false })
        assert.ok(
            head.includes(
                `<link rel="canonical" href="${seoCanonicalUrl(entry)}" />`
            )
        )
        assert.ok(
            head.includes(
                `<link rel="alternate" hreflang="en" href="${SITE_ORIGIN}${entry.def.paths.en}" />`
            )
        )
        assert.ok(
            head.includes(
                `<link rel="alternate" hreflang="zh" href="${SITE_ORIGIN}${entry.def.paths.zh}" />`
            )
        )
        assert.ok(
            head.includes(
                `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${entry.def.paths.en}" />`
            )
        )
        assert.ok(!head.includes('noindex'))
        assert.ok(head.includes('og:image'))
        assert.ok(head.includes('twitter:card'))
    }
})

test('social card art follows the page language', () => {
    // The headline is baked into the PNG, so a shared card would put English
    // art on the Chinese pages.
    assert.notEqual(OG_IMAGE_PATH.en, OG_IMAGE_PATH.zh)
    for (const entry of entries) {
        const head = seoHeadTags(entry, { noindex: false })
        const expected = `${SITE_ORIGIN}${OG_IMAGE_PATH[entry.language]}`
        assert.ok(
            head.includes(`<meta property="og:image" content="${expected}" />`),
            `${entry.path} should carry the ${entry.language} card`
        )
        assert.ok(
            head.includes(`<meta name="twitter:image" content="${expected}" />`)
        )
        const other = entry.language === 'en' ? 'zh' : 'en'
        assert.ok(
            !head.includes(OG_IMAGE_PATH[other]),
            `${entry.path} must not reference the ${other} card`
        )
    }
})

test('JSON-LD parses and makes no unverified claims', () => {
    for (const entry of entries) {
        const graph = seoJsonLd(entry)
        const parsed = JSON.parse(JSON.stringify(graph)) as {
            '@graph': Array<Record<string, unknown>>
        }
        const types = parsed['@graph'].map((node) => node['@type'])
        assert.ok(types.includes('Organization'))
        assert.ok(types.includes('WebSite'))
        assert.ok(types.includes('SoftwareApplication'))
        assert.ok(types.includes('WebPage'))
        const serialized = JSON.stringify(parsed)
        for (const banned of [
            'aggregateRating',
            'review',
            'offers',
            'price',
            'ratingValue'
        ]) {
            assert.ok(
                !serialized.includes(banned),
                `${entry.path} JSON-LD contains unverified claim key: ${banned}`
            )
        }
    }
})

test('the sitemap lists exactly the manifest URLs with alternates', () => {
    const xml = buildSitemapXml()
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    assert.equal(locs.length, entries.length)
    for (const entry of entries) {
        assert.ok(locs.includes(seoCanonicalUrl(entry)))
    }
    for (const priv of ['/workspace', '/login', '/challenge', '/chat']) {
        assert.ok(!xml.includes(`${SITE_ORIGIN}${priv}`))
    }
    assert.ok(xml.includes('hreflang="x-default"'))
})

test('production robots allows the public pages and disallows SPA families', () => {
    const robots = buildRobotsTxt('production')
    for (const entry of entries) {
        assert.ok(robots.includes(`Allow: ${entry.path}`))
    }
    for (const prefix of SPA_ROUTE_PREFIXES) {
        assert.ok(robots.includes(`Disallow: ${prefix}`))
    }
    assert.ok(robots.includes('Disallow: /r'))
    assert.ok(robots.includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`))
    assert.ok(
        robots.includes('Sitemap: https://docs.manyfold.ai/sitemap-index.xml')
    )
    assert.ok(!robots.includes('Disallow: /\n'))
})

test('staging robots disallows everything', () => {
    assert.equal(buildRobotsTxt('staging'), 'User-agent: *\nDisallow: /\n')
    assert.equal(resolveWebEnv('staging'), 'staging')
    assert.equal(resolveWebEnv(undefined), 'staging')
    assert.equal(resolveWebEnv('production'), 'production')
})

test('page HTML gets metadata and body; staging adds noindex', () => {
    const entry = entries.find((candidate) => candidate.path === '/zh/')
    assert.ok(entry)
    const production = buildPageHtml(SHELL, {
        entry,
        bodyHtml: '<main>body</main>',
        env: 'production'
    })
    assert.ok(production.includes('<html lang="zh-CN">'))
    assert.ok(production.includes('<div id="root"><main>body</main></div>'))
    assert.ok(!production.includes('noindex'))
    const staging = buildPageHtml(SHELL, {
        entry,
        bodyHtml: '<main>body</main>',
        env: 'staging'
    })
    assert.ok(
        staging.includes('<meta name="robots" content="noindex, nofollow" />')
    )
})

test('a rendered page cannot be used as the shell again', () => {
    const entry = entries[0]
    const rendered = buildPageHtml(SHELL, {
        entry,
        bodyHtml: '<main>x</main>',
        env: 'production'
    })
    assert.throws(
        () =>
            buildPageHtml(rendered, { entry, bodyHtml: '', env: 'production' }),
        /already a rendered marketing page/
    )
})

test('app.html is the shell plus an unconditional noindex', () => {
    const appHtml = buildAppHtml(SHELL)
    assert.ok(
        appHtml.includes('<meta name="robots" content="noindex, nofollow" />')
    )
    assert.ok(appHtml.includes('<div id="root"></div>'))
    assert.ok(build404Html().includes('404'))
})

// The Caddyfile lists the SPA route families a second time (as path
// matchers). If a family is added to one side only, either the crawl policy
// or the serving boundary silently drifts — this is the signal.
test('every SPA route prefix appears in the Caddyfile @spa matcher', () => {
    const caddyfile = readFileSync(
        new URL('../Caddyfile', import.meta.url),
        'utf8'
    )
    for (const prefix of SPA_ROUTE_PREFIXES) {
        assert.ok(
            caddyfile.includes(`${prefix} ${prefix}/*`),
            `Caddyfile @spa matcher is missing ${prefix}`
        )
    }
})

// Marketing URLs must never fall into the SPA/noindex bucket.
test('no marketing path is shadowed by an SPA route prefix', () => {
    for (const entry of entries) {
        for (const prefix of SPA_ROUTE_PREFIXES) {
            assert.ok(
                entry.path !== prefix && !entry.path.startsWith(`${prefix}/`),
                `${entry.path} is shadowed by SPA prefix ${prefix}`
            )
        }
    }
})
