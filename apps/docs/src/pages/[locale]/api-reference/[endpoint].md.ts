// Chinese markdown twin of each endpoint page.
import type { APIRoute } from 'astro'
import { apiReferenceFor, type ApiEndpoint } from '@/lib/api-reference'
import { nonDefaultLocales, type Locale } from '@/lib/i18n'
import { renderEndpointMarkdown } from '@/lib/surface-markdown'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const getStaticPaths = () =>
    nonDefaultLocales.flatMap((locale) =>
        apiReferenceFor(locale).endpoints.map((endpoint) => ({
            params: { locale, endpoint: endpoint.id },
            props: { locale, endpoint }
        }))
    )

export const GET: APIRoute = ({ props, site }) => {
    const { locale, endpoint } = props as { locale: Locale; endpoint: ApiEndpoint }
    return new Response(
        renderEndpointMarkdown(endpoint, locale, site?.toString() ?? FALLBACK_SITE),
        { headers: { 'content-type': 'text/markdown; charset=utf-8' } }
    )
}
