// Per-release social card. English only, same reason as changelog.png.ts: the
// card is typeset in Geist, which ships no CJK.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import type { CollectionEntry } from 'astro:content'
import {
    changelogLead,
    changelogProduct,
    changelogSlug,
    changelogTitle
} from '@/lib/changelog'
import { getUi } from '@/lib/i18n'
import { renderOgCard } from '@/pages/docs/[...slug].png'

export async function getStaticPaths() {
    const entries = await getCollection('changelog')
    return entries.map((entry) => ({
        params: { entry: changelogSlug(entry) },
        props: { entry }
    }))
}

export const GET: APIRoute = async ({ props }) => {
    const { entry } = props as { entry: CollectionEntry<'changelog'> }
    const copy = getUi('en')
    return new Response(
        new Uint8Array(
            await renderOgCard(
                `${copy.changelogTitle} · ${changelogProduct(entry)} ${entry.data.version}`,
                changelogTitle(entry),
                changelogLead(entry) ?? copy.changelogDescription
            )
        ),
        { headers: { 'content-type': 'image/png' } }
    )
}
