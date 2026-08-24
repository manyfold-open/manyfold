// Chinese markdown twin of the changelog. getStaticPaths mirrors
// src/pages/[locale]/changelog.astro.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { nonDefaultLocales, type Locale } from '@/lib/i18n'
import { renderChangelogMarkdown } from '@/lib/surface-markdown'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const getStaticPaths = () =>
    nonDefaultLocales.map((locale) => ({ params: { locale }, props: { locale } }))

export const GET: APIRoute = async ({ props, site }) =>
    new Response(
        renderChangelogMarkdown(
            await getCollection('changelog'),
            (props as { locale: Locale }).locale,
            site?.toString() ?? FALLBACK_SITE
        ),
        { headers: { 'content-type': 'text/markdown; charset=utf-8' } }
    )
