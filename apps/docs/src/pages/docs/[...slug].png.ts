// The generated social card, and the card body all five .png routes share:
// this one, changelog.png.ts, changelog/[entry].png.ts, api-reference.png.ts
// and api-reference/[endpoint].png.ts. So /docs/getting-started/ has a card at
// /docs/getting-started.png, drawn from the frontmatter that is already there.
//
// Why bother: docs pages get shared in Slack, Discord and X far more than they
// get indexed, and a per-page card is the difference between a recognisable
// link and a grey box. It costs one route and zero per-page maintenance.
//
// The art is the landing register, not a second look: Ash neutrals, one Iris
// accent, Fraunces for the title, Geist Mono for the eyebrow and the URL, and
// one Fieldwork sphere (DESIGN.landing.md §1–§3). The static poster in
// apps/web/scripts/og renders the same system through a browser; this one goes
// through satori, which is why the field is characters rather than an image —
// satori can typeset a glyph grid, and cannot rasterise anything else.
//
// getStaticPaths mirrors src/pages/docs/[...slug].astro, the same way
// docs-md-endpoint.ts does, so the route sets cannot diverge.
//
// English only. Geist ships latin, latin-ext, cyrillic and vietnamese and no
// CJK at all, and the vendored Fraunces instance is a latin subset, so a
// Chinese card would render every character as a tofu box. The Chinese pages
// keep the shared static card until a CJK face is vendored; src/pages/[locale]
// has no .png route for the same reason.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import type { CollectionEntry } from 'astro:content'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import displayFontUri from '@/assets/fonts/fraunces-card.ttf?inline'
import {
    entrySlug,
    filterDocsByLocale,
    groupTitleFor,
    type Locale
} from '@/lib/i18n'

const WIDTH = 1200
const HEIGHT = 630

// Brand tokens, kept literal rather than imported from global.css so a CSS
// refactor cannot silently change every card that is already in circulation.
// Update both together on purpose. These are the landing register's values
// (DESIGN.landing.md §1.2 Ash, §1.3 Iris), which the product tokens track.
const INK = '#101013' /* --lp-ink          */
const MUTED = '#5c5e66' /* --lp-muted        */
const SUBTLE = '#8d8f97' /* --lp-subtle       */
const IRIS = '#3560eb' /* --lp-iris-600     */
const IRIS_DEEP = '#1842d8' /* --lp-iris-700     */
const CANVAS = '#f4f4f6' /* --lp-bg           */
// --lp-line-strong, not --lp-line: X draws its own border around a card but
// Slack and Discord do not, and a near-white card with a .12 ring dissolves
// into their white unfurl.
const RING = 'rgba(16, 16, 22, 0.22)'

const SITE = 'docs.manyfold.ai'

// ---------------------------------------------------------------------------
// Faces
//
// satori needs real font buffers; it cannot resolve a family name, and it
// reads ttf, otf and woff only — never woff2, which is what @fontsource ships
// alongside. Geist and Geist Mono are resolved out of node_modules so the card
// cannot drift from the app's own dependency; Fraunces is vendored next to
// this route because satori would otherwise take the variable font's default
// instance, which is a different typeface (see assets/fonts/README.md).
const require_ = createRequire(import.meta.url)

const installed = (weight: 400 | 500, mono: boolean): string =>
    require_.resolve(
        mono
            ? `@fontsource/geist-mono/files/geist-mono-latin-${weight}-normal.woff`
            : `@fontsource/geist/files/geist-latin-${weight}-normal.woff`
    )

// Inlined by Vite rather than read off disk: this module is bundled into
// dist/.prerender before it runs, so a path relative to import.meta.url points
// at the build output, where the font is not.
const VENDORED_DISPLAY = Buffer.from(
    displayFontUri.slice(displayFontUri.indexOf(',') + 1),
    'base64'
)

type LoadedFont = {
    name: string
    data: Buffer
    weight: 400 | 500
    style: 'normal'
}

// Read once. A full build renders one card per docs page, per changelog entry
// and per API endpoint, and re-reading four files for each of them is the kind
// of cost that only shows up once the site is big.
let faces: Promise<LoadedFont[]> | null = null

const loadFonts = (): Promise<LoadedFont[]> => {
    faces ??= Promise.all([
        Promise.resolve(VENDORED_DISPLAY),
        readFile(installed(400, false)),
        readFile(installed(500, false)),
        readFile(installed(400, true)),
        readFile(installed(500, true))
    ]).then(([display, sans, sansMedium, mono, monoMedium]) => [
        {
            name: 'Fraunces Card',
            data: display,
            weight: 400 as const,
            style: 'normal' as const
        },
        {
            name: 'Geist',
            data: sans,
            weight: 400 as const,
            style: 'normal' as const
        },
        {
            name: 'Geist',
            data: sansMedium,
            weight: 500 as const,
            style: 'normal' as const
        },
        {
            name: 'Geist Mono',
            data: mono,
            weight: 400 as const,
            style: 'normal' as const
        },
        {
            name: 'Geist Mono',
            data: monoMedium,
            weight: 500 as const,
            style: 'normal' as const
        }
    ])
    return faces
}

// ---------------------------------------------------------------------------
// The field
//
// One sphere, held at a chosen phase. The maths is the `sphere` sampler from
// apps/web/src/components/field/fields.ts with the loop frozen — a poster is a
// still, so it wants the frame where the object reads most like itself, which
// for the sphere is t=0.75 (roundest outline, clearest terminator). The ramp
// and the plate split are §3.2 and §3.3 verbatim.
//
// Copied rather than imported because apps/docs cannot reach into apps/web.
// If the sampler there changes, this has to change with it; the shapes are
// defined by their maths, so a silent divergence shows up as a differently
// lit ball, not as a broken build.
const RAMP = [' ', '·', ':', '+', '1', '0', '8', '@'] as const
const PLATE = [0, 1, 1, 2, 2, 3, 3, 3] as const
const CELL_ASPECT = 1.36
const HOLD = 0.75

const FIELD_SIZE = 21
const FIELD_COLS = 34
const FIELD_ROWS = 30
const CELL_W = FIELD_SIZE * 0.66 /* 0.6em advance + 0.06em tracking */
const CELL_H = FIELD_SIZE * 0.92

// The browser-rendered poster ends its field with a mask. satori has no mask,
// so the fade is folded into the field's own values instead — which is the
// honest place for it anyway: the ink thins out, rather than an image being
// cut off. Only the first few columns are touched.
const FADE_FROM = 1.4
const FADE_TO = 3.8

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

const spherePlates = (): [string[], string[], string[]] => {
    const cx = (FIELD_COLS - 1) / 2
    const cy = (FIELD_ROWS - 1) / 2
    const radius = Math.min(FIELD_COLS / 2, (FIELD_ROWS * CELL_ASPECT) / 2)
    const lx = -0.4
    const ly = -0.55
    const lz = 0.73
    const plates: [string[], string[], string[]] = [[], [], []]
    for (let row = 0; row < FIELD_ROWS; row++) {
        const line = ['', '', '']
        for (let col = 0; col < FIELD_COLS; col++) {
            const x = (col - cx) / radius
            const y = ((row - cy) * CELL_ASPECT) / radius
            const d = (x * x + y * y) / 0.9
            let v = 0
            if (d <= 1) {
                const z = Math.sqrt(1 - d)
                const lambert = clamp01(-(x * lx + y * ly) + z * lz)
                const band =
                    0.74 +
                    0.26 * Math.sin(6 * Math.atan2(x, z) - Math.PI * 2 * HOLD)
                v = clamp01(lambert * band * (1 - Math.pow(d, 5) * 0.5))
                v *= clamp01((col - FADE_FROM) / (FADE_TO - FADE_FROM))
            }
            const level = Math.max(0, Math.min(7, Math.round(v * 7)))
            const glyph = RAMP[level]
            const plate = PLATE[level]
            line[0] += plate === 1 ? glyph : ' '
            line[1] += plate === 2 ? glyph : ' '
            line[2] += plate === 3 ? glyph : ' '
        }
        for (let i = 0; i < 3; i++) plates[i].push(line[i])
    }
    return plates
}

// ---------------------------------------------------------------------------
// Layout
//
// satori accepts a React-element-shaped object literal, so no JSX and no React
// import. A node with several children must say `display: flex` explicitly,
// and a node with none must not carry a `children` key at all.
const el = (
    type: string,
    props: Record<string, unknown>,
    ...children: unknown[]
): unknown => ({
    type,
    props:
        children.length === 0
            ? { ...props }
            : {
                  ...props,
                  children: children.length === 1 ? children[0] : children
              }
})

// The BrandMark as a data URI, because satori rasterises <img> but not an
// inline <svg> subtree. Same four polygons as src/components/Brand.tsx in the
// web app, with the two tones written out instead of inherited.
const MARK = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 135 100">' +
        `<polygon points="10,80 35,15 47.5,15 22.5,80" fill="${INK}"/>` +
        `<polygon points="35,15 60,80 47.5,15 72.5,80" fill="${SUBTLE}"/>` +
        `<polygon points="60,80 85,15 72.5,80 97.5,15" fill="${INK}"/>` +
        `<polygon points="85,15 110,80 97.5,15 122.5,80" fill="${SUBTLE}"/>` +
        '</svg>'
)}`

// The title carries the card, so its size steps with the length rather than
// wrapping to a fourth line. The thresholds are where a line breaks at the
// 700px measure: a single word gets the display size, a sentence gets the base
// size, a long sentence steps down twice.
const titleSize = (title: string): number =>
    title.length <= 14
        ? 104
        : title.length <= 28
          ? 76
          : title.length <= 56
            ? 62
            : 52

// One line, top right: where this page lives. It replaces the footer the first
// card carried — X stamps its own title over the lower-left 800x110 of every
// large-image card, so nothing readable belongs down there. 58 characters of
// Geist Mono at 21px is 731px, which still clears the wordmark; anything
// longer drops the path rather than shrinking the line.
const sourceLine = (path?: string): string => {
    const full = path ? `${SITE}${path}` : SITE
    return full.length <= 58 ? full : SITE
}

const plateEl = (lines: string[], color: string): unknown =>
    el(
        'div',
        {
            style: {
                position: 'absolute',
                top: 0,
                left: 0,
                display: 'flex',
                flexDirection: 'column',
                fontFamily: 'Geist Mono',
                fontSize: FIELD_SIZE,
                lineHeight: `${CELL_H}px`,
                letterSpacing: '0.06em',
                color
            }
        },
        ...lines.map((line) =>
            el('div', { style: { whiteSpace: 'pre', height: CELL_H } }, line)
        )
    )

const card = (
    eyebrow: string,
    title: string,
    description: string,
    path?: string
): unknown => {
    const [light, mid, deep] = spherePlates()
    const size = titleSize(title)
    return el(
        'div',
        {
            style: {
                width: WIDTH,
                height: HEIGHT,
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                padding: 64,
                backgroundColor: CANVAS,
                fontFamily: 'Geist'
            }
        },
        // z=0: the field, behind everything and never under the text
        el(
            'div',
            {
                style: {
                    position: 'absolute',
                    top: 50,
                    left: WIDTH + 20 - FIELD_COLS * CELL_W,
                    width: FIELD_COLS * CELL_W,
                    height: FIELD_ROWS * CELL_H,
                    display: 'flex'
                }
            },
            plateEl(light, `${IRIS}4d` /* 0.30 */),
            plateEl(mid, `${IRIS}a8` /* 0.66 */),
            plateEl(deep, IRIS_DEEP)
        ),
        el('div', {
            style: {
                position: 'absolute',
                top: 0,
                left: 0,
                width: WIDTH,
                height: HEIGHT,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: RING
            }
        }),
        // The identity band. Same place on every card, which is the only thing
        // a reader can lock onto at the 504px X renders this at.
        el(
            'div',
            {
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                }
            },
            el(
                'div',
                { style: { display: 'flex', alignItems: 'center' } },
                el('img', { src: MARK, width: 62, height: 46 }),
                el(
                    'div',
                    {
                        style: {
                            marginLeft: 12,
                            fontSize: 33,
                            fontWeight: 500,
                            letterSpacing: '-0.015em',
                            color: INK
                        }
                    },
                    'Manyfold'
                )
            ),
            el(
                'div',
                {
                    style: {
                        fontFamily: 'Geist Mono',
                        fontSize: 21,
                        color: SUBTLE
                    }
                },
                sourceLine(path)
            )
        ),
        // eyebrow -> serif title -> sans lead, the §2.6 T5 sandwich
        el(
            'div',
            {
                style: {
                    display: 'flex',
                    flexDirection: 'column',
                    flexGrow: 1,
                    justifyContent: 'center',
                    paddingBottom: 64
                }
            },
            el(
                'div',
                {
                    style: {
                        display: 'flex',
                        alignItems: 'center',
                        marginBottom: 22
                    }
                },
                el('div', {
                    style: {
                        width: 9,
                        height: 9,
                        marginRight: 10,
                        borderRadius: 9,
                        backgroundColor: IRIS
                    }
                }),
                el(
                    'div',
                    {
                        style: {
                            fontFamily: 'Geist Mono',
                            fontSize: 21,
                            fontWeight: 500,
                            color: MUTED
                        }
                    },
                    eyebrow
                )
            ),
            el(
                'div',
                {
                    style: {
                        fontFamily: 'Fraunces Card',
                        fontSize: size,
                        lineHeight: 1.04,
                        letterSpacing: '-0.018em',
                        color: INK,
                        maxWidth: 700
                    }
                },
                title
            ),
            el(
                'div',
                {
                    style: {
                        marginTop: 26,
                        fontSize: size > 62 ? 27 : 25,
                        lineHeight: 1.34,
                        letterSpacing: '-0.01em',
                        color: MUTED,
                        maxWidth: 700,
                        // Two lines is all the card can carry under the title.
                        display: 'block',
                        lineClamp: 2
                    }
                },
                description
            )
        )
    )
}

// The card from three strings plus where it lives, so a surface that is not a
// docs collection entry can have one too. /api-reference and /changelog were
// both falling back to the shared static art before this existed.
export const renderOgCard = async (
    eyebrow: string,
    title: string,
    description: string,
    path?: string
): Promise<Buffer> => {
    const svg = await satori(
        card(eyebrow, title, description, path) as Parameters<typeof satori>[0],
        { width: WIDTH, height: HEIGHT, fonts: await loadFonts() }
    )
    return new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } })
        .render()
        .asPng()
}

export const renderOgImage = async (
    entry: CollectionEntry<'docs'>,
    locale: Locale
): Promise<Buffer> =>
    renderOgCard(
        groupTitleFor(entry, locale) ?? 'Documentation',
        entry.data.title,
        entry.data.description ?? '',
        `/docs/${entrySlug(entry)}`
    )

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
