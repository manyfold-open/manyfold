// Destination: apps/docs/src/pages/docs/[...slug].png.ts
//
// Serves a generated Open Graph image per docs page, so /docs/getting-started/ has a card
// at /docs/getting-started.png. Copied from replicate.com, which serves
// replicate.com/docs/<same path>.png as its og:image. fal.ai does not do this: every fal
// docs page reuses logo/light.svg declared as 1200x630, which is a bug worth not copying.
//
// Why bother: docs pages get shared in Slack, Discord, and X far more than they get
// indexed, and a per-page card is the difference between a recognisable link and a grey
// box. It costs one route and zero per-page maintenance, because the title and
// description already exist in frontmatter.
//
// getStaticPaths mirrors src/pages/docs/[...slug].astro, the same way
// docs-md-endpoint.ts does, so the route sets cannot diverge.
//
// NEW DEPENDENCIES. This file needs two packages the app does not currently have:
//
//     pnpm --filter docs add satori @resvg/resvg-js
//
// If adding them is not acceptable, see the "No-dependency fallback" note at the bottom of
// this file. Do not ship an .svg og:image instead; several crawlers, including Slack's,
// will not render it.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import type { CollectionEntry } from 'astro:content'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import {
    entrySlug,
    filterDocsByLocale,
    groupTitleFor,
    type Locale
} from '@/lib/i18n'

const WIDTH = 1200
const HEIGHT = 630

// Brand tokens, kept literal rather than imported from global.css so a CSS refactor
// cannot silently change every social card. Update both together on purpose.
const INK = '#111827'
const MUTED = '#536073'
const TEAL = '#0f8c6f'
const LINE = '#dbe3ee'
const SURFACE = '#ffffff'

// Satori needs real font buffers; it cannot resolve a font-family name. This
// originally read Inter from apps/docs/src/assets/fonts/, which does not exist:
// the app's typeface is Geist, already a dependency via @fontsource/geist, and
// there is no vendored font directory at all. Resolved through require.resolve
// rather than a relative path because pnpm hoists node_modules to the workspace
// root, two levels above this app.
//
// .woff, not .woff2: satori reads ttf, otf and woff only, and @fontsource ships
// both, so the card would render blank glyphs on the compressed one.
const fontFile = (weight: 400 | 600) =>
    createRequire(import.meta.url).resolve(
        `@fontsource/geist/files/geist-latin-${weight}-normal.woff`
    )

const loadFonts = async () => {
    const [regular, bold] = await Promise.all([
        readFile(fontFile(400)),
        readFile(fontFile(600))
    ])
    return [
        { name: 'Geist', data: regular, weight: 400 as const, style: 'normal' as const },
        { name: 'Geist', data: bold, weight: 600 as const, style: 'normal' as const }
    ]
}

// Satori accepts a React-element-shaped object literal, so no JSX and no React import.
const el = (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({
    type,
    props: { ...props, children: children.length === 1 ? children[0] : children }
})

const card = (eyebrow: string, title: string, description: string) =>
    el(
        'div',
        {
            style: {
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '72px 80px',
                backgroundColor: SURFACE,
                // A teal rule down the left edge is the cheapest way to make the card
                // recognisable at thumbnail size without a logo file.
                borderLeft: `16px solid ${TEAL}`,
                fontFamily: 'Geist'
            }
        },
        el(
            'div',
            { style: { display: 'flex', flexDirection: 'column' } },
            el(
                'div',
                {
                    style: {
                        fontSize: 26,
                        fontWeight: 600,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                        color: TEAL,
                        marginBottom: 28
                    }
                },
                eyebrow
            ),
            el(
                'div',
                {
                    style: {
                        fontSize: title.length > 58 ? 60 : 72,
                        fontWeight: 600,
                        lineHeight: 1.12,
                        letterSpacing: '-0.03em',
                        color: INK
                    }
                },
                title
            ),
            el(
                'div',
                {
                    style: {
                        marginTop: 26,
                        fontSize: 30,
                        lineHeight: 1.45,
                        color: MUTED,
                        // Two lines is all a 1200x630 card can carry under the title.
                        display: 'block',
                        lineClamp: 2
                    }
                },
                description
            )
        ),
        el(
            'div',
            {
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingTop: 28,
                    borderTop: `2px solid ${LINE}`,
                    fontSize: 28,
                    color: MUTED
                }
            },
            el('div', { style: { fontWeight: 600, color: INK } }, 'Manyfold Docs'),
            el('div', {}, 'docs.manyfold.ai')
        )
    )

// The card from three strings, so a surface that is not a docs collection
// entry can have one too. /api-reference and /changelog were both falling back
// to the shared static art.
export const renderOgCard = async (
    eyebrow: string,
    title: string,
    description: string
): Promise<Buffer> => {
    const svg = await satori(
        card(eyebrow, title, description) as Parameters<typeof satori>[0],
        { width: WIDTH, height: HEIGHT, fonts: await loadFonts() }
    )
    return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng()
}

export const renderOgImage = async (
    entry: CollectionEntry<'docs'>,
    locale: Locale
): Promise<Buffer> => {
    const svg = await satori(
        card(
            groupTitleFor(entry, locale) ?? 'Documentation',
            entry.data.title,
            entry.data.description ?? ''
        ) as Parameters<typeof satori>[0],
        { width: WIDTH, height: HEIGHT, fonts: await loadFonts() }
    )
    return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng()
}

export const getStaticPaths = async () => {
    const entries = filterDocsByLocale(await getCollection('docs'), 'en')
    return entries.map((entry) => ({
        params: { slug: entrySlug(entry) },
        props: { entry }
    }))
}

export const GET: APIRoute = async ({ props }) => {
    const { entry } = props as { entry: CollectionEntry<'docs'> }
    const png = await renderOgImage(entry, 'en')
    return new Response(new Uint8Array(png), {
        headers: {
            'content-type': 'image/png',
            // Static output, so this is only a hint for the CDN in front of it.
            'cache-control': 'public, max-age=31536000, immutable'
        }
    })
}

// The locale variant is a four-line wrapper following the same pattern as
// locale-llms.txt.ts: getStaticPaths over nonDefaultLocales, then renderOgImage(entry, locale).
// Destination: apps/docs/src/pages/[locale]/docs/[...slug].png.ts
//
// ---------------------------------------------------------------------------
// No-dependency fallback
//
// If satori and resvg cannot be added, do NOT fall back to an .svg og:image; Slack and
// several other unfurlers will not render it. Instead keep the single shared card that
// exists today, and make it honest: the current declaration claims 1200x630 while pointing
// at a logo SVG, which is what fal gets wrong. Either point og:image at a real 1200x630
// PNG in public/, or drop the width and height meta tags so the crawler measures it.
//
// groupTitleFor() is assumed to exist in @/lib/i18n alongside groupDocs(); if the group
// title is only computed inside groupDocs(), export a small helper rather than duplicating
// the mapping here.
