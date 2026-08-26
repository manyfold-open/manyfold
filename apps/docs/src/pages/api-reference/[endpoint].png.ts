// Per-endpoint social card. English only: Geist ships no CJK.
import type { APIRoute } from 'astro'
import { apiReferenceFor, type ApiEndpoint } from '@/lib/api-reference'
import { renderOgCard } from '@/pages/docs/[...slug].png'

export const getStaticPaths = () =>
    apiReferenceFor('en').endpoints.map((endpoint) => ({
        params: { endpoint: endpoint.id },
        props: { endpoint }
    }))

export const GET: APIRoute = async ({ props }) => {
    const { endpoint } = props as { endpoint: ApiEndpoint }
    return new Response(
        new Uint8Array(
            await renderOgCard(
                `${endpoint.method} ${endpoint.path}`,
                endpoint.title,
                endpoint.description
            )
        ),
        { headers: { 'content-type': 'image/png' } }
    )
}
