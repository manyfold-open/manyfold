// Markdown twin of each endpoint page.
import type { APIRoute } from 'astro'
import { apiReferenceFor, type ApiEndpoint } from '@/lib/api-reference'
import { renderEndpointMarkdown } from '@/lib/surface-markdown'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const getStaticPaths = () =>
    apiReferenceFor('en').endpoints.map((endpoint) => ({
        params: { endpoint: endpoint.id },
        props: { endpoint }
    }))

export const GET: APIRoute = ({ props, site }) =>
    new Response(
        renderEndpointMarkdown(
            (props as { endpoint: ApiEndpoint }).endpoint,
            'en',
            site?.toString() ?? FALLBACK_SITE
        ),
        { headers: { 'content-type': 'text/markdown; charset=utf-8' } }
    )
