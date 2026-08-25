import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const site = 'https://docs.manyfold.ai'
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
// What a search result will actually show. Shared by the gate below and by
// changelogLead, which clamps to 155 to stay under it.
const DESCRIPTION_LIMIT = 165

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
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        // Numeric entities too, and &amp; last: a `&` is escaped as &amp; in a
        // text node but as &#38; inside an attribute value, so a title
        // containing one compares unequal unless both spellings decode.
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&amp;/g, '&')

const textContent = (value) =>
    decode(
        value
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
    )

// A section heading in the navigation tree: the disclosure button, its
// chevron, and the label. Shared by the duplicate-tree gate and the ungrouped
// bucket gate below, which are two questions about the same row.
const GROUP_HEADING =
    /<button[^>]*class="docs-tree-head docs-tree-head-group"[^>]*>(?:\s*<svg\b[\s\S]*?<\/svg>)?\s*<span>([\s\S]*?)<\/span>/g

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
// A 404 page has no canonical and belongs in no sitemap, by design, and
// @astrojs/sitemap deliberately omits it. Without this exclusion, adding
// src/pages/404.astro fails the canonical, hreflang and sitemap gates at once.
const NON_INDEXABLE_ROUTES = new Set(['/404.html'])

const indexablePages = pages.filter(
    (page) => !page.redirect && !NON_INDEXABLE_ROUTES.has(page.route)
)

// Excluded from the indexable gates, but still asserted to exist and to be
// marked noindex, so it cannot silently disappear and bring back the soft-404
// that returns HTTP 200 for every unknown URL.
const notFound = routes.get('/404.html')
if (!notFound) {
    fail('/404.html', 'missing 404 page, unknown URLs will soft-404 with HTTP 200')
} else if (!meta(notFound.html, 'name', 'robots')) {
    fail('/404.html', 'missing meta robots noindex')
}
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
    // A search result cuts the description near 160 characters, so anything
    // past that is written for nobody: the tail is never shown and the visible
    // half was not composed to stand on its own. Twelve changelog entries were
    // over it, one at 288, because the description is the entry's first
    // paragraph and nothing clamped it (see changelogLead).
    if (description.length > DESCRIPTION_LIMIT) {
        fail(
            route,
            `meta description is ${description.length} characters, over the ${DESCRIPTION_LIMIT} a result will show`
        )
    }

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

    // Comments stripped first. They are not markup a crawler reads, and a
    // source comment that spells out a tag name is otherwise indistinguishable
    // from the tag to everything below -- which is how a comment explaining
    // this very gate reported itself as two extra headings on 167 pages.
    const markup = html.replace(/<!--[\s\S]*?-->/g, '')

    const h1Count = (markup.match(/<h1\b/gi) ?? []).length
    if (h1Count !== 1) fail(route, `expected one h1, found ${h1Count}`)

    // The document outline. Two failures this catches, both of which shipped:
    // a sr-only agent-index block opened every page with an <h2> above the
    // <h1>, and the changelog dropped its `##` headline to make the h1 and
    // left the `###` sections hanging one level below nothing.
    const headings = [...markup.matchAll(/<h([1-4])\b/gi)].map((match) =>
        Number(match[1])
    )
    const firstH1 = headings.indexOf(1)
    if (firstH1 > 0) {
        fail(
            route,
            `h${headings[0]} precedes the h1, so the outline opens below the page title`
        )
    }
    const outline = firstH1 >= 0 ? headings.slice(firstH1) : headings
    for (let index = 1; index < outline.length; index += 1) {
        if (outline[index] - outline[index - 1] > 1) {
            fail(
                route,
                `heading level jumps h${outline[index - 1]} to h${outline[index]}`
            )
            break
        }
    }

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

    // A page that declares itself an article to a social card should say the
    // same thing to a crawler. BreadcrumbList was the only node the site
    // emitted for a long time, which told a crawler where a page sits and
    // nothing about what it holds.
    const ogType = decode(
        attribute(meta(html, 'property', 'og:type') ?? '', 'content') ?? ''
    )
    if (ogType === 'article') {
        const article = jsonLd.find((item) =>
            ['TechArticle', 'Article'].includes(item['@type'])
        )
        if (!article) {
            fail(route, 'og:type is article but no TechArticle/Article JSON-LD')
        } else if (article.url !== expectedCanonical) {
            fail(
                route,
                `article JSON-LD url is ${article.url}, expected ${expectedCanonical}`
            )
        }
    }
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
            // The docs home is the dashboard at /docs/, not the first article.
            // This gate held the old assumption, so it is what caught the
            // change: 66 pages failed the moment the breadcrumb was repointed.
            const expectedHome = route.startsWith('/zh/')
                ? `${site}/zh/docs/`
                : `${site}/docs/`
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

// Markup invariants no other gate can see. Every one of these shipped once:
// a <pre> with no data-language renders with no language label and, outside a
// markdown body, no padding and no horizontal scroll; a .docs-code wrapper in
// the source makes the copy script skip that block, so it has no copy button
// at all; a duplicate id makes its anchor ambiguous; and an in-page link to an
// id this document does not carry is a click that does nothing.
// One family of duplicate id is left, and it comes from generated content
// rather than from a component: the changelog renders 37 entries that each
// carry their own 'Highlights' heading. Nothing links to a changelog entry's
// sections, so it sends no reader to the wrong place, and the fix belongs where
// that markdown is generated. That route stays exempt and the count is printed
// on success rather than dropped quietly. Every hand-authored page is covered.
//
// The CLI reference used to be the second family. It emitted an explicit
// <a id> immediately above every command heading that rehype-slug already
// slugged to the same id, 140 per locale. Splitting the page per command
// dropped those anchors, and every #fragment still resolves because the id was
// always coming from the heading text. The exemption went with them.
const DUPLICATE_ID_EXEMPT = /^\/(zh\/)?(changelog)\/$/
const exemptRoutes = new Set()
const idsByRoute = new Map()

for (const page of pages) {
    const { html, route } = page

    for (const tag of tags(html, 'pre')) {
        if (!attribute(tag, 'data-language')) {
            fail(route, 'a <pre> carries no data-language, so it renders bare')
        }
    }

    if (/class=(['"])[^'"]*\bdocs-code\b/.test(html)) {
        fail(
            route,
            'a .docs-code wrapper in the source suppresses the copy bar'
        )
    }

    // The sidebar tree renders once per page. A half-finished refactor left
    // both branches of a ternary in DocsSidebar.astro standing, so every page
    // shipped the whole 36-link tree twice with a stray ') : (' between them,
    // and nothing caught it: the markup is valid, the types check, the build
    // passes. Repeated group headings are the cheapest signature of that.
    //
    // Anchored to the button's own open tag and one optional glyph, so the
    // match cannot run from one section heading to a <span> belonging to
    // another. The rows were <summary> elements before the tree became a set
    // of disclosure buttons; a shape gate has to be re-pointed when the shape
    // changes, which is the cost of it noticing anything at all.
    const groups = [
        ...html.matchAll(GROUP_HEADING)
    ].map((match) => textContent(match[1]))
    const seenGroups = new Set()
    for (const group of groups) {
        if (seenGroups.has(group)) {
            fail(route, `sidebar group "${group}" renders twice`)
        }
        seenGroups.add(group)
    }

    const exempt = DUPLICATE_ID_EXEMPT.test(route)
    if (exempt) exemptRoutes.add(route)
    const ids = new Set()
    for (const match of html.matchAll(/\sid=(['"])(.*?)\1/g)) {
        const id = decode(match[2])
        if (ids.has(id) && !exempt) fail(route, `duplicate id "${id}"`)
        ids.add(id)
    }

    idsByRoute.set(route, ids)

    const fragments = new Set(
        tags(html, 'a')
            .map((tag) => attribute(tag, 'href'))
            .filter((href) => href && href.startsWith('#') && href.length > 1)
            // The markdown renderer percent-encodes a non-ASCII fragment while
            // the id attribute stays raw UTF-8, so '#%E5%8F%91...' and
            // id="发送文件" are the same target. Comparing them undecoded
            // reports every Chinese in-page link as dead.
            .map((href) => {
                const raw = decode(href.slice(1))
                try {
                    return decodeURIComponent(raw)
                } catch {
                    return raw
                }
            })
    )
    for (const fragment of fragments) {
        if (!ids.has(fragment)) {
            fail(
                route,
                `in-page link to #${fragment}, which this page has no id for`
            )
        }
    }
}

// Same check across pages. Every doc page's breadcrumb now points at its group's
// heading on the dashboard, so a renamed group would leave 33 trails pointing at
// an anchor that no longer exists, in the markup a crawler reads for the site's
// shape. Nothing else would notice.
for (const page of pages) {
    const { html, route } = page
    const links = tags(html, 'a')
        .map((tag) => attribute(tag, 'href'))
        .filter((href) => href && href.startsWith('/') && href.includes('#'))

    // The breadcrumb's two middle crumbs render as plain text, because a
    // sidebar grouping is not a page. Their `item` URLs stay in the JSON-LD,
    // where Google needs them, which means the dashboard anchors they point at
    // are now referenced by nothing in the markup. Read them out of the
    // structured data so a renamed group still fails here instead of quietly
    // breaking the trail a crawler parses.
    const breadcrumbItems = [
        ...html.matchAll(
            /<script\b[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi
        )
    ]
        .flatMap((match) => {
            try {
                return [JSON.parse(match[1])]
            } catch {
                // The per-page pass above already failed this route for it.
                return []
            }
        })
        .filter((item) => item['@type'] === 'BreadcrumbList')
        .flatMap((list) =>
            Array.isArray(list.itemListElement) ? list.itemListElement : []
        )
        .map((item) => item?.item)
        .filter((url) => typeof url === 'string' && url.startsWith(`${site}/`))
        .map((url) => url.slice(site.length))
        .filter((href) => href.includes('#'))

    for (const href of new Set([...links, ...breadcrumbItems])) {
        const [path, fragment] = decode(href).split('#')
        if (!fragment) continue
        const target = normalizeRoute(path)
        const ids = idsByRoute.get(target)
        // A path this build does not emit is a separate problem, and the
        // canonical gates above already speak for it.
        if (!ids) continue
        let decoded = fragment
        try {
            decoded = decodeURIComponent(fragment)
        } catch {
            decoded = fragment
        }
        if (!ids.has(decoded)) {
            fail(
                route,
                `links to ${target}#${decoded}, which that page has no id for`
            )
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

// === No page falls into the ungrouped bucket ===
//
// docs-nav.ts groups pages by hand, and anything it does not list drops into a
// "More" / "更多" group at the bottom of the tree. That is the visible symptom
// of an orphaned page: reachable, but filed nowhere, and away from its
// siblings.
//
// This is not hypothetical. The CLI reference is generated one page per
// command, so a new command creates a page that nothing in the nav knows
// about: `mf version` arrived in CLI 0.24.0 and landed here exactly that way.
// The generator can add a page; only this notices that the nav did not.
const ungroupedLabels = ['More', '更多']
const ungrouped = []
for (const { route, html } of pages) {
    const nav = html.match(/<aside id="docs-nav"[\s\S]*?<\/aside>/)
    if (!nav) continue
    const headings = [...nav[0].matchAll(GROUP_HEADING)].map((match) =>
        textContent(match[1])
    )
    for (const label of ungroupedLabels) {
        if (headings.includes(label)) {
            ungrouped.push(route)
            break
        }
    }
}
if (ungrouped.length > 0) {
    fail(
        ungrouped[0],
        `the navigation tree renders an ungrouped "More" bucket on ${ungrouped.length} page(s), so a page exists that docs-nav.ts does not list`
    )
}

// === Navigational trailers carry no anchor and no TOC entry ===
//
// Detected by SHAPE here, on purpose. src/lib/trailers.ts drives the behaviour
// from a list of ten heading names, and a list silently stops matching the
// moment someone renames a heading or a new page invents an eleventh name.
// This gate re-finds them structurally, so a rename becomes a build failure
// instead of a section quietly getting its anchor back.
//
// The shape is unambiguous and was calibrated against the corpus before this
// gate shipped: the last h2 of the prose body, whose content begins with a list
// of two or more items that hold nothing but links. Structural detection and
// the name list agreed on exactly 54 sections with zero disagreement either
// way. If the two ever disagree, one of them is wrong and this fails.
const trailerFor = (html) => {
    const start = html.indexOf('class="prose-doc')
    if (start < 0) return null
    const region = html.slice(start)
    const headings = [
        ...region.matchAll(/<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)
    ]
    if (headings.length === 0) return null
    const last = headings[headings.length - 1]
    const after = region.slice(last.index + last[0].length)
    const list = after.match(/^\s*<ul[^>]*>([\s\S]*?)<\/ul>/)
    if (!list) return null
    const items = [...list[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(
        (match) => match[1]
    )
    if (items.length < 2) return null
    const linkOnly = items.every((item) => {
        if (!/<a\b/.test(item)) return false
        // Everything that is not a link, ignoring whitespace and the trailing
        // punctuation a translated list sometimes carries.
        return (
            item
                .replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, '')
                .replace(/[\s.,、。]/g, '') === ''
        )
    })
    if (!linkOnly) return null
    return { id: last[1], markup: last[0], text: textContent(last[2]).trim() }
}

const trailers = []
for (const { route, html } of pages) {
    const trailer = trailerFor(html)
    if (!trailer) continue
    trailers.push({ route, ...trailer })

    if (trailer.markup.includes('docs-heading-anchor')) {
        fail(
            route,
            `navigational trailer "${trailer.text}" carries a heading anchor; nothing links these sections from another page, so add its name to src/lib/trailers.ts`
        )
    }

    // The page outline, wherever a page renders one. This matched a class
    // that no longer exists for one revision, which is a gate that keeps
    // passing while checking nothing -- worth re-reading whenever the outline
    // markup moves.
    const outline = html.match(/<nav class="docs-toc[\s\S]*?<\/nav>/)
    if (outline && outline[0].includes(`#${trailer.id}`)) {
        fail(
            route,
            `navigational trailer "${trailer.text}" is listed in the page outline, which names what the page covers and not where it exits to`
        )
    }
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
console.log(
    `Markup gates: ${pages.length} pages checked, ${exemptRoutes.size} exempt from the duplicate-id gate (${[...exemptRoutes].sort().join(', ')})`
)
console.log(
    `Trailer gate: ${trailers.length} navigational trailers, none anchored, none in a page outline (${
        [...new Set(trailers.map((t) => t.text))].sort().join(', ')
    })`
)
console.log(
    'Nav gate: every page is filed in a group, no ungrouped bucket rendered'
)
