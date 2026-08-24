// Per-page social card for the API reference. English only: the card is
// typeset in Geist, which ships no CJK, so a Chinese card renders every
// Chinese character as a tofu box. Verified by rendering one and looking.
import type { APIRoute } from 'astro'
import { apiReferenceFor } from '@/lib/api-reference'
import { renderOgCard } from '@/pages/docs/[...slug].png'

export const GET: APIRoute = async () => {
    const ref = apiReferenceFor('en')
    return new Response(
        new Uint8Array(
            await renderOgCard(ref.eyebrow, ref.title, ref.description)
        ),
        { headers: { 'content-type': 'image/png' } }
    )
}
