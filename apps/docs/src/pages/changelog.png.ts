// Per-page social card for the changelog. English only, same reason as
// api-reference.png.ts.
import type { APIRoute } from 'astro'
import { getUi } from '@/lib/i18n'
import { renderOgCard } from '@/pages/docs/[...slug].png'

export const GET: APIRoute = async () => {
    const copy = getUi('en')
    return new Response(
        new Uint8Array(
            await renderOgCard(
                copy.brandShort,
                copy.changelogTitle,
                copy.changelogDescription
            )
        ),
        { headers: { 'content-type': 'image/png' } }
    )
}
