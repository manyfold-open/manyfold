// Destination: apps/docs/src/pages/[locale]/docs/[...slug].md.ts
//
// Chinese markdown twins. getStaticPaths mirrors
// src/pages/[locale]/docs/[...slug].astro exactly.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import type { CollectionEntry } from 'astro:content'
import {
    entrySlug,
    filterDocsByLocale,
    nonDefaultLocales,
    type Locale
} from '@/lib/i18n'
import { renderDocMarkdown } from '@/pages/docs/[...slug].md'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const getStaticPaths = async () => {
    const allEntries = await getCollection('docs')

    return nonDefaultLocales.flatMap((locale) =>
        filterDocsByLocale(allEntries, locale).map((entry) => ({
            params: { locale, slug: entrySlug(entry) },
            props: { entry, locale }
        }))
    )
}

export const GET: APIRoute = ({ props, site }) => {
    const { entry, locale } = props as {
        entry: CollectionEntry<'docs'>
        locale: Locale
    }
    const body = renderDocMarkdown(
        entry,
        locale,
        site?.toString() ?? FALLBACK_SITE
    )
    return new Response(body, {
        headers: { 'content-type': 'text/markdown; charset=utf-8' }
    })
}
