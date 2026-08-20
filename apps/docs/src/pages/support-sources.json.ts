import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { entryHref, entryLocale, entrySlug } from '@/lib/i18n'

// Maps a Dify retriever `document_name` back to the page it was uploaded from.
// The dataset flattens the content path with '--', so 'channels/lark.md' under
// the zh tree arrives as 'zh--channels--lark.md'. Building this at build time
// (from the same helpers the router uses) is what keeps citation links from
// drifting away from the real routes.
export const GET: APIRoute = async () => {
    const docs = await getCollection('docs')
    const map = new Map<string, { href: string; title: string }>()

    for (const entry of docs) {
        const locale = entryLocale(entry)
        const key = `${locale}--${entrySlug(entry).replaceAll('/', '--')}.md`
        const existing = map.get(key)
        if (existing)
            throw new Error(
                `support-sources: '${key}' maps to both ${existing.href} and ${entryHref(entry, locale)}`
            )
        map.set(key, { href: entryHref(entry, locale), title: entry.data.title })
    }

    return new Response(JSON.stringify(Object.fromEntries(map)), {
        headers: { 'content-type': 'application/json; charset=utf-8' }
    })
}