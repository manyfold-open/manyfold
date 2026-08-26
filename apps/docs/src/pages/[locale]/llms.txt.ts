// Destination: apps/docs/src/pages/[locale]/llms.txt.ts
//
// Chinese (and any future non-default locale) index. Mirrors the getStaticPaths shape
// used by src/pages/[locale]/docs/[...slug].astro so the route set stays consistent.
import type { APIRoute } from 'astro'
import { nonDefaultLocales, type Locale } from '@/lib/i18n'
import { buildLlmsIndex } from '@/pages/llms.txt'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const getStaticPaths = () =>
    nonDefaultLocales.map((locale) => ({ params: { locale } }))

export const GET: APIRoute = async ({ params, site }) => {
    const locale = params.locale as Locale
    const body = await buildLlmsIndex(locale, site?.toString() ?? FALLBACK_SITE)
    return new Response(body, {
        headers: { 'content-type': 'text/plain; charset=utf-8' }
    })
}
