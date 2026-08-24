// Destination: apps/docs/src/pages/changelog/feed.xml.ts
//
// The cheapest single win on the changelog. Every feed path currently probed
// (changelog/rss.xml, feed.xml, atom.xml, changelog.xml) falls through to the
// catch-all and returns text/html, so there is no way to subscribe to Manyfold
// releases at all. render.com serves Atom at /changelog/feed.xml and fal serves
// RSS at /docs/changelog/rss.xml.
//
// Atom rather than RSS 2.0: it has a real date type, requires stable ids, and
// handles i18n via xml:lang, all of which matter here because there are two
// locales and the entries are versioned.
//
// DEPENDS ON the schema change in edits-baselayout-i18n-config.md section 3a:
// `title` and `summary` must exist on the changelog collection. Until they do,
// the fallbacks below keep the build green but produce weaker entry titles, so
// land the schema change first.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { getUi, localeOption, localePath, type Locale } from '@/lib/i18n'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

const escape = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')

// Atom requires RFC 3339. The collection stores a plain YYYY-MM-DD, so anchor
// it at midnight UTC rather than inventing a time.
const rfc3339 = (date: string): string => `${date}T00:00:00Z`

// Product plus version, never the title, so a reworded title cannot change an
// entry's identity in subscribers' readers. This is the feed <id> only, not the
// link: it stays stable if per-entry changelog pages are added later and the
// link moves off the timeline fragment, which would otherwise re-notify every
// subscriber about entries they have already read.
const entryId = (product: string, version: string): string =>
    `tag:docs.manyfold.ai,2026:changelog/${product}-${version}`

export const buildChangelogFeed = async (
    locale: Locale,
    siteUrl: string
): Promise<string> => {
    const abs = (path: string) => new URL(path, siteUrl).toString()
    const ui = getUi(locale)
    const option = localeOption(locale)

    const entries = (await getCollection('changelog')).sort(
        (a, b) => b.data.date.localeCompare(a.data.date)
    )

    const indexUrl = abs(localePath(locale, '/changelog/'))
    const selfUrl = abs(localePath(locale, '/changelog/feed.xml'))
    const updated = entries[0]?.data.date
        ? rfc3339(entries[0].data.date)
        : rfc3339('1970-01-01')

    const items = entries.map((entry) => {
        const { version, date } = entry.data
        // The changelog collection's schema is only { version, date }. Product,
        // title and summary are not frontmatter: the product is the filename
        // prefix (cli-v0.16.0 -> cli) and the title is the entry's own opening
        // H2, with the paragraph under it as the summary. Reading them off
        // entry.data returned undefined for all 37 entries.
        const product = entry.id.split('-v')[0] || 'cli'
        const heading = entry.body?.match(/^##\s+(.+)$/m)?.[1]?.trim()
        const title = heading || `${product} ${version}`
        // After the heading when there is one, from the top of the body when
        // there is not: one of the 37 entries (cli-v0.23.1, a maintenance note)
        // is a bare paragraph with no heading at all, and splitting on the
        // heading left it with an empty summary.
        const summarySource = heading
            ? (entry.body?.split(/^##\s+.+$/m)[1] ?? '')
            : (entry.body ?? '')
        const summary =
            summarySource
                .split(/\n\s*\n/)
                .map((block) => block.trim())
                .find((block) => block && !block.startsWith('#'))
                ?.replace(/\s+/g, ' ') ?? ''
        // There are no per-entry changelog pages: /changelog/ is one timeline
        // and ChangelogTimeline gives each entry id="v{version}". Linking to
        // /changelog/{product}-v{version}/ produced a feed of 404s.
        const url = abs(localePath(locale, `/changelog/#v${version}`))
        return `    <entry>
        <id>${escape(entryId(product, version))}</id>
        <title>${escape(title)}</title>
        <link rel="alternate" type="text/html" href="${escape(url)}"/>
        <updated>${rfc3339(date)}</updated>
        <category term="${escape(product)}"/>
${summary ? `        <summary>${escape(summary)}</summary>\n` : ''}    </entry>`
    })

    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escape(option.locale)}">
    <id>${escape(indexUrl)}</id>
    <title>${escape(`Manyfold ${ui.changelogTitle}`)}</title>
    <subtitle>${escape(ui.changelogDescription)}</subtitle>
    <updated>${updated}</updated>
    <link rel="self" type="application/atom+xml" href="${escape(selfUrl)}"/>
    <link rel="alternate" type="text/html" href="${escape(indexUrl)}"/>
    <author><name>Manyfold</name><uri>https://manyfold.ai</uri></author>
${items.join('\n')}
</feed>
`
}

export const GET: APIRoute = async ({ site }) => {
    const body = await buildChangelogFeed(
        'en',
        site?.toString() ?? FALLBACK_SITE
    )
    return new Response(body, {
        headers: { 'content-type': 'application/atom+xml; charset=utf-8' }
    })
}
