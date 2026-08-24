// Destination: apps/docs/src/pages/docs/[...slug].md.ts
//
// Serves a markdown twin for every English docs URL, so /docs/getting-started/ has a
// machine-readable counterpart at /docs/getting-started.md returning text/markdown.
//
// The leading pointer block is copied from fal.ai's convention. Their why-fal.md starts
// with a blockquote telling the retrieving agent where the full index lives, which means
// every single page teaches discovery rather than relying on the agent finding
// /llms.txt on its own. It costs three lines and it is the highest-leverage part of
// this file.
//
// getStaticPaths mirrors src/pages/docs/[...slug].astro exactly, so the two route sets
// cannot diverge. Astro treats "[...slug].md.ts" as the route /docs/[...slug].md, the
// same mechanism that makes the existing search.json.ts resolve to /search.json.
//
// Deliberately NOT added to the sitemap: check-seo.mjs enforces a strict two-way match
// between sitemap URLs and canonical HTML pages, so listing .md URLs would fail the
// build. That constraint is correct, the sitemap is for indexable HTML.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import type { CollectionEntry } from 'astro:content'
import {
    entryHref,
    entrySlug,
    filterDocsByLocale,
    localePath,
    type Locale
} from '@/lib/i18n'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const renderDocMarkdown = (
    entry: CollectionEntry<'docs'>,
    locale: Locale,
    siteUrl: string
): string => {
    const abs = (path: string) => new URL(path, siteUrl).toString()
    return [
        '> ## Documentation index',
        `> Fetch the complete documentation index at: ${abs(localePath(locale, '/llms.txt'))}`,
        '> Use this file to discover all available pages before exploring further.',
        '',
        `# ${entry.data.title}`,
        '',
        `> ${entry.data.description}`,
        '',
        `Source: ${abs(entryHref(entry, locale))}`,
        '',
        (entry.body ?? '').trim(),
        ''
    ].join('\n')
}

export const getStaticPaths = async () => {
    const entries = filterDocsByLocale(await getCollection('docs'), 'en')
    return entries.map((entry) => ({
        params: { slug: entrySlug(entry) },
        props: { entry }
    }))
}

export const GET: APIRoute = ({ props, site }) => {
    const { entry } = props as { entry: CollectionEntry<'docs'> }
    const body = renderDocMarkdown(entry, 'en', site?.toString() ?? FALLBACK_SITE)
    return new Response(body, {
        headers: { 'content-type': 'text/markdown; charset=utf-8' }
    })
}
