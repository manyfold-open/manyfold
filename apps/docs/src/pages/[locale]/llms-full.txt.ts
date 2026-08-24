// Destination: apps/docs/src/pages/[locale]/llms-full.txt.ts
//
// Required, not optional: llms.txt.ts links to localePath(locale, '/llms-full.txt') for
// every locale, so without this file the Chinese index carries a dead reference. That
// dead link would NOT be caught by check-seo.mjs, because its broken-link check only
// walks .html files.
import type { APIRoute } from 'astro'
import { nonDefaultLocales, type Locale } from '@/lib/i18n'
import { buildLlmsFull } from '@/pages/llms-full.txt'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const getStaticPaths = () =>
    nonDefaultLocales.map((locale) => ({ params: { locale } }))

export const GET: APIRoute = async ({ params, site }) => {
    const locale = params.locale as Locale
    const body = await buildLlmsFull(locale, site?.toString() ?? FALLBACK_SITE)
    return new Response(body, {
        headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
}
