// Markdown twin of /api-reference. See src/lib/surface-markdown.ts.
import type { APIRoute } from 'astro'
import { renderApiReferenceMarkdown } from '@/lib/surface-markdown'

const FALLBACK_SITE = 'https://docs.manyfold.ai'

export const GET: APIRoute = ({ site }) =>
    new Response(
        renderApiReferenceMarkdown('en', site?.toString() ?? FALLBACK_SITE),
        { headers: { 'content-type': 'text/markdown; charset=utf-8' } }
    )
