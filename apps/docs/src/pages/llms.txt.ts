// Destination: apps/docs/src/pages/llms.txt.ts
//
// Grouped link index for retrieving agents, following the replicate.com/docs/llms.txt
// shape: an H1 for the site, an H2 per section, and one "- [Title](url): description"
// line per page. Group titles and membership come from docsGroupsFor() in i18n.ts, the
// same source the sidebar uses, so this file cannot drift out of sync with the nav.
//
// The non-docs routes (API reference, changelog, status, Ask AI) are appended the same
// way search.json.ts appends them, so the index covers every canonical page rather than
// only the content collection.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { apiReferenceFor } from '@/lib/api-reference'
import { dashboardCopyFor } from '@/lib/dashboard-copy'
import {
    entryHref,
    filterDocsByLocale,
    getSupportUi,
    getUi,
    groupDocs,
    localePath,
    type Locale
} from '@/lib/i18n'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const buildLlmsIndex = async (
    locale: Locale,
    siteUrl: string
): Promise<string> => {
    const abs = (path: string) => new URL(path, siteUrl).toString()
    const ui = getUi(locale)
    const entries = filterDocsByLocale(await getCollection('docs'), locale)
    const { grouped, remaining } = groupDocs(entries, locale)

    const lines: string[] = ['# Manyfold', '']
    lines.push(ui.docsDescription, '')
    // The entry page was missing from its own index: this file listed every
    // guide and never /docs/, so the page a reader lands on first was the one
    // page an agent could not discover here.
    const dashboard = dashboardCopyFor(locale)
    lines.push(
        `- [${dashboard.heading}](${abs(localePath(locale, '/docs/'))}): ${dashboard.deck}`,
        ''
    )

    const section = (title: string, description: string, items: string[]) => {
        if (items.length === 0) return
        lines.push(`## ${title}`, '')
        if (description) lines.push(`${description}`, '')
        lines.push(...items, '')
    }

    for (const group of grouped) {
        section(
            group.title,
            group.description,
            group.entries.map(
                (entry) =>
                    `- [${entry.data.title}](${abs(entryHref(entry, locale))}): ${entry.data.description}`
            )
        )
    }

    section(
        ui.more,
        '',
        remaining.map(
            (entry) =>
                `- [${entry.data.title}](${abs(entryHref(entry, locale))}): ${entry.data.description}`
        )
    )

    const reference = apiReferenceFor(locale)
    const support = getSupportUi(locale)
    section(ui.apiReference, '', [
        `- [${reference.title}](${abs(localePath(locale, '/api-reference/'))}): ${reference.description}`,
        `- [${ui.changelogTitle}](${abs(localePath(locale, '/changelog/'))}): ${ui.changelogDescription}`,
        `- [${ui.statusTitle}](${abs(localePath(locale, '/status/'))}): ${ui.statusDescription}`,
        `- [${support.supportTitle}](${abs(localePath(locale, '/support/'))}): ${support.supportDescription}`
    ])

    // Point retrieving agents at the full corpus and at the per-page markdown
    // convention, so an agent that lands here knows both other affordances exist.
    lines.push(
        '## Full text',
        '',
        `- [Complete documentation, single file](${abs(localePath(locale, '/llms-full.txt'))}): every page above, concatenated.`,
        '',
        'Any documentation URL also serves markdown by appending .md, for example',
        `${abs(localePath(locale, '/docs/getting-started.md'))}`,
        ''
    )

    return lines.join('\n')
}

export const GET: APIRoute = async ({ site }) => {
    const body = await buildLlmsIndex('en', site?.toString() ?? FALLBACK_SITE)
    return new Response(body, {
        headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
}
