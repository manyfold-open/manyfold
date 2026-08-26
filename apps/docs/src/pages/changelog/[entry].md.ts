// Markdown twin of each release page.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import type { CollectionEntry } from 'astro:content'
import { changelogSlug } from '@/lib/changelog'
import { renderChangelogEntryMarkdown } from '@/lib/surface-markdown'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export async function getStaticPaths() {
    const entries = await getCollection('changelog')
    return entries.map((entry) => ({
        params: { entry: changelogSlug(entry) },
        props: { entry }
    }))
}

export const GET: APIRoute = ({ props, site }) =>
    new Response(
        renderChangelogEntryMarkdown(
            (props as { entry: CollectionEntry<'changelog'> }).entry,
            'en',
            site?.toString() ?? FALLBACK_SITE
        ),
        { headers: { 'content-type': 'text/markdown; charset=utf-8' } }
    )
