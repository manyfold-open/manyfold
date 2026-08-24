// Destination: apps/docs/src/pages/llms-full.txt.ts
//
// Whole-corpus single file, following fal.ai/docs/llms-full.txt. fal's is 3.2 MB because
// they have 426 pages; this is around 290 KB after the CLI reference split and the two
// non-collection surfaces below, and still needs no pagination.
//
// "Whole corpus" now means what llms.txt says it means. That index lists the docs pages
// and then an API reference section holding the reference, the changelog, the status page
// and the support page, and it describes this file as "every page above, concatenated".
// It was the docs collection only: the API surface appeared zero times, and `changelog`
// appeared zero times, so the index promised a superset of what this returned.
//
// The reference and the changelog are appended here through the same renderers their .md
// twins use, with the pointer block suppressed so it appears once at the top rather than
// at every surface boundary. Nothing is written for this file; it is the strings those
// surfaces already publish.
//
// Status and support are deliberately still out. They are the two entries in that section
// with no documentation content: one renders a service-status widget and the other is a
// search box over this very corpus, so concatenating them would add chrome, not text.
//
// Ordering follows the sidebar groups rather than the filesystem, so a model reading top
// to bottom gets the intended learning order instead of alphabetical noise.
//
// For the Chinese equivalent, add src/pages/[locale]/llms-full.txt.ts using the same
// getStaticPaths pattern as locale-llms.txt.ts and call buildLlmsFull(locale, site).
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import {
    entryHref,
    filterDocsByLocale,
    getUi,
    groupDocs,
    type Locale
} from '@/lib/i18n'
import {
    renderApiReferenceMarkdown,
    renderChangelogMarkdown
} from '@/lib/surface-markdown'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const buildLlmsFull = async (
    locale: Locale,
    siteUrl: string
): Promise<string> => {
    const abs = (path: string) => new URL(path, siteUrl).toString()
    const ui = getUi(locale)
    const entries = filterDocsByLocale(await getCollection('docs'), locale)
    const { grouped, remaining } = groupDocs(entries, locale)
    const ordered = [...grouped.flatMap((group) => group.entries), ...remaining]

    const parts: string[] = [
        '# Manyfold documentation',
        '',
        ui.docsDescription,
        '',
        `Index: ${abs('/llms.txt')}`,
        '',
        '---',
        ''
    ]

    for (const entry of ordered) {
        parts.push(
            `# ${entry.data.title}`,
            '',
            `Source: ${abs(entryHref(entry, locale))}`,
            '',
            entry.data.description,
            '',
            (entry.body ?? '').trim(),
            '',
            '---',
            ''
        )
    }

    // Last, and in llms.txt's own order: the sidebar groups above are the
    // learning path, and these two are reference material a reader arrives at
    // already knowing what they want.
    parts.push(
        renderApiReferenceMarkdown(locale, siteUrl, { pointer: false }),
        '',
        '---',
        '',
        renderChangelogMarkdown(
            await getCollection('changelog'),
            locale,
            siteUrl,
            { pointer: false }
        ),
        '',
        '---',
        ''
    )

    return parts.join('\n')
}

export const GET: APIRoute = async ({ site }) => {
    const body = await buildLlmsFull('en', site?.toString() ?? FALLBACK_SITE)
    return new Response(body, {
        headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
}
