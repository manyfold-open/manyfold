// Markdown twin of /changelog. See src/lib/surface-markdown.ts.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { renderChangelogMarkdown } from '@/lib/surface-markdown'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const GET: APIRoute = async ({ site }) =>
    new Response(
        renderChangelogMarkdown(
            await getCollection('changelog'),
            'en',
            site?.toString() ?? FALLBACK_SITE
        ),
        { headers: { 'content-type': 'text/markdown; charset=utf-8' } }
    )
