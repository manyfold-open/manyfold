import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const site = 'https://docs.manyfold.ai'
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const failures = []

const fail = (route, message) => failures.push(`${route}: ${message}`)

const walk = (directory, predicate) => {
    const files = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) files.push(...walk(file, predicate))
        else if (predicate(file)) files.push(file)
    }
    return files
}

const routeFor = (file) => {
    const relative = path.relative(dist, file).split(path.sep).join('/')
    if (relative === 'index.html') return '/'
    if (relative.endsWith('/index.html')) {
        return `/${relative.slice(0, -'index.html'.length)}`
    }
    return `/${relative}`
}

const normalizeRoute = (pathname) => {
    if (pathname === '/') return '/'
    if (path.posix.extname(pathname)) return pathname
    return `${pathname.replace(/\/$/, '')}/`
}

const attribute = (tag, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return tag.match(new RegExp(`\\b${escaped}=(['"])(.*?)\\1`, 'i'))?.[2]
}

const tags = (html, name) =>
    [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map(
        (match) => match[0]
    )

const meta = (html, key, value) =>
    tags(html, 'meta').find((tag) => attribute(tag, key) === value)

const linksWithRel = (html, rel) =>
    tags(html, 'link').filter((tag) =>
        (attribute(tag, 'rel') ?? '').split(/\s+/).includes(rel)
    )

const decode = (value) =>
    value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')

const textContent = (value) =>
    decode(
        value
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
    )

const htmlFiles = walk(dist, (file) => file.endsWith('.html'))
const pages = htmlFiles.map((file) => {
    const html = fs.readFileSync(file, 'utf8')
    const route = routeFor(file)
    const redirect = Boolean(meta(html, 'http-equiv', 'refresh'))
    const canonicalTag = linksWithRel(html, 'canonical')[0]
    const canonical = canonicalTag
        ? decode(attribute(canonicalTag, 'href') ?? '')
        : null
    return { file, html, route, redirect, canonical }
})

const routes = new Map(pages.map((page) => [page.route, page]))
const redirectRoutes = new Set(
    pages.filter((page) => page.redirect).map((page) => page.route)
)
const indexablePages = pages.filter((page) => !page.redirect)
const canonicalPages = new Map(
    indexablePages
        .filter((page) => page.canonical)
        .map((page) => [page.canonical, page])
)
const titles = new Map()
const descriptions = new Map()
const alternateSets = new Map()

for (const page of indexablePages) {
    const { html, route, canonical } = page
    const expectedCanonical = `${site}${route}`
    const lang = attribute(tags(html, 'html')[0] ?? '', 'lang')
    const expectedLang = route.startsWith('/zh/') ? 'zh-CN' : 'en-US'
    if (lang !== expectedLang) {
        fail(
            route,
            `expected html lang ${expectedLang}, found ${lang ?? 'none'}`
        )
    }

    const titleMatches = [...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)]
    if (titleMatches.length !== 1) {
        fail(route, `expected one title, found ${titleMatches.length}`)
    }
    const title = textContent(titleMatches[0]?.[1] ?? '')
    if (!title) fail(route, 'title is empty')

    const descriptionTag = meta(html, 'name', 'description')
    const description = decode(attribute(descriptionTag ?? '', 'content') ?? '')
    if (!description.trim()) fail(route, 'meta description is empty')

    const titleKey = `${lang}\0${title}`
    const descriptionKey = `${lang}\0${description}`
    titles.set(titleKey, [...(titles.get(titleKey) ?? []), route])
    descriptions.set(descriptionKey, [
        ...(descriptions.get(descriptionKey) ?? []),
        route
    ])

    if (canonical !== expectedCanonical) {
        fail(
            route,
            `canonical must be ${expectedCanonical}, found ${canonical ?? 'none'}`
        )
    }

    const h1Count = (html.match(/<h1\b/gi) ?? []).length
    if (h1Count !== 1) fail(route, `expected one h1, found ${h1Count}`)

    const expectedMeta = [
        ['property', 'og:title', title],
        ['property', 'og:description', description],
        ['property', 'og:url', canonical],
        ['property', 'og:locale', expectedLang.replace('-', '_')],
        ['name', 'twitter:title', title],
        ['name', 'twitter:description', description]
    ]
    for (const [key, value, expected] of expectedMeta) {
        const tag = meta(html, key, value)
        const content = decode(attribute(tag ?? '', 'content') ?? '')
        if (content !== expected) {
            fail(route, `${value} must match page metadata`)
        }
    }

    if (!meta(html, 'name', 'twitter:image:alt')) {
        fail(route, 'missing twitter:image:alt')
    }

    const alternateLinks = linksWithRel(html, 'alternate')
        .filter((tag) => attribute(tag, 'hreflang'))
        .map((tag) => ({
            hreflang: attribute(tag, 'hreflang'),
            href: decode(attribute(tag, 'href') ?? '')
        }))
    const selfAlternate = alternateLinks.find(
        (link) => link.hreflang === lang && link.href === canonical
    )
    if (!selfAlternate) fail(route, 'hreflang set does not include itself')

    const xDefault = alternateLinks.find(
        (link) => link.hreflang === 'x-default'
    )
    if (!xDefault) fail(route, 'missing x-default hreflang')
    const expectedXDefault = `${site}${route.replace(/^\/zh(?=\/)/, '')}`
    if (xDefault?.href !== expectedXDefault) {
        fail(route, `x-default must be ${expectedXDefault}`)
    }

    for (const alternate of alternateLinks) {
        if (!canonicalPages.has(alternate.href)) {
            fail(
                route,
                `${alternate.hreflang} hreflang points to a non-canonical page: ${alternate.href}`
            )
        }
    }
    alternateSets.set(
        canonical,
        new Set(alternateLinks.map((link) => link.href))
    )

    const jsonLd = [
        ...html.matchAll(
            /<script\b[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi
        )
    ].flatMap((match) => {
        try {
            return [JSON.parse(match[1])]
        } catch (error) {
            fail(route, `invalid JSON-LD: ${error.message}`)
            return []
        }
    })
    const breadcrumb = jsonLd.find((item) => item['@type'] === 'BreadcrumbList')
    const isGuide = /^\/(?:zh\/)?docs\/.+\/$/.test(route)
    const isGettingStarted = route.endsWith('/docs/getting-started/')
    if (isGuide && !isGettingStarted && !breadcrumb) {
        fail(route, 'guide is missing BreadcrumbList JSON-LD')
    }
    if (breadcrumb) {
        const items = breadcrumb.itemListElement
        if (!Array.isArray(items) || items.length < 2) {
            fail(route, 'BreadcrumbList must contain at least two items')
        } else {
            const expectedHome = route.startsWith('/zh/')
                ? `${site}/zh/docs/getting-started/`
                : `${site}/docs/getting-started/`
            if (items[0]?.item !== expectedHome) {
                fail(route, `breadcrumb home must be ${expectedHome}`)
            }
            if (items.at(-1)?.item) {
                fail(
                    route,
                    'last breadcrumb item must describe the current page'
                )
            }
        }
    }

    if (/fonts\.(?:googleapis|gstatic)\.com/.test(html)) {
        fail(route, 'page loads render-blocking remote Google Fonts')
    }
}

for (const [key, pageRoutes] of [...titles, ...descriptions]) {
    if (pageRoutes.length > 1) {
        fail(
            pageRoutes.join(', '),
            `duplicate localized metadata: ${key.split('\0')[1]}`
        )
    }
}

for (const [canonical, alternates] of alternateSets) {
    for (const alternate of alternates) {
        const returnLinks = alternateSets.get(alternate)
        if (!returnLinks?.has(canonical)) {
            fail(
                canonicalPages.get(canonical)?.route ?? canonical,
                `hreflang target does not link back: ${alternate}`
            )
        }
    }
}

for (const page of indexablePages) {
    if (!page.canonical) continue
    const withoutScripts = page.html
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    for (const anchor of withoutScripts.matchAll(/<a\b[^>]*>/gi)) {
        const href = decode(attribute(anchor[0], 'href') ?? '')
        if (!href || href.startsWith('#') || /^(?:mailto|tel):/.test(href)) {
            continue
        }
        const url = new URL(href, page.canonical)
        if (url.origin !== site) continue
        const targetRoute = normalizeRoute(url.pathname)
        if (redirectRoutes.has(targetRoute)) {
            fail(page.route, `internal link points to redirect: ${href}`)
            continue
        }
        const staticFile = path.join(dist, url.pathname.replace(/^\//, ''))
        if (!routes.has(targetRoute) && !fs.existsSync(staticFile)) {
            fail(page.route, `broken internal link: ${href}`)
        }
    }
}

const sitemapFiles = walk(dist, (file) =>
    /sitemap-\d+\.xml$/.test(path.basename(file))
)
const sitemapUrls = new Set(
    sitemapFiles
        .flatMap((file) => [
            ...fs.readFileSync(file, 'utf8').matchAll(/<loc>(.*?)<\/loc>/g)
        ])
        .map((match) => decode(match[1]))
)
const canonicalUrls = new Set(canonicalPages.keys())
for (const canonical of canonicalUrls) {
    if (!sitemapUrls.has(canonical))
        fail(canonical, 'canonical is missing from sitemap')
}
for (const url of sitemapUrls) {
    if (!canonicalUrls.has(url)) fail(url, 'sitemap URL is not canonical')
}

const robots = fs.readFileSync(path.join(dist, 'robots.txt'), 'utf8')
if (!robots.includes(`Sitemap: ${site}/sitemap-index.xml`)) {
    fail('/robots.txt', 'missing absolute sitemap declaration')
}

const fontFiles = walk(dist, (file) => file.endsWith('.woff2'))
if (fontFiles.length === 0)
    fail('/_astro/', 'self-hosted font assets are missing')

if (failures.length > 0) {
    console.error(`SEO check failed with ${failures.length} issue(s):`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exit(1)
}

console.log(
    `SEO check passed: ${indexablePages.length} canonical pages, ${sitemapUrls.size} sitemap URLs, ${fontFiles.length} local font assets`
)
