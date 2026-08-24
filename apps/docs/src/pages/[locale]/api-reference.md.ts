// Chinese markdown twin of the API reference. getStaticPaths mirrors
// src/pages/[locale]/api-reference.astro.
import type { APIRoute } from 'astro'
import { nonDefaultLocales, type Locale } from '@/lib/i18n'
import { renderApiReferenceMarkdown } from '@/lib/surface-markdown'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const getStaticPaths = () =>
    nonDefaultLocales.map((locale) => ({ params: { locale }, props: { locale } }))

export const GET: APIRoute = ({ props, site }) =>
    new Response(
        renderApiReferenceMarkdown(
            (props as { locale: Locale }).locale,
            site?.toString() ?? FALLBACK_SITE
        ),
        { headers: { 'content-type': 'text/markdown; charset=utf-8' } }
    )
