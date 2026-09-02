/** Non-colour design values: radius, font stacks, type ramps.

    These were spread across more places than the colours were. Radius lived
    in three (the webapp's `tailwind.config.ts`, the docs `--radius-*`, the
    landing `--lp-r-*`); the font stacks in three; the type ramps in two with
    different shapes. None of it was checked. */

// ─────────────────────────────── radius ───────────────────────────────

/** The two registers diverge ON PURPOSE at the two working tiers, and
    nowhere else — see DESIGN.md §6.1. The product runs tighter because a
    dense page split into many cards reads bubbly at larger corners, and it
    never reaches above `md`; landing keeps the sculptural hero scale. Both
    scales are honest and fully ascending. */
export const radius = {
    product: {
        xs: 8,
        sm: 10,
        md: 14,
        lg: 20,
        xl: 24,
        '2xl': 28,
        '3xl': 32
    },
    landing: {
        xs: 8,
        sm: 12,
        md: 16,
        lg: 20,
        xl: 24,
        '2xl': 28,
        '3xl': 32
    }
} as const

/** Pill differs only in digit count — 9999 in the product, 999 on landing.
    Both round a finite box completely, so the difference is cosmetic; it is
    recorded rather than unified so neither baseline shows a diff for it. */
export const radiusPill = { product: 9999, landing: 999 } as const

export type RadiusTier = keyof typeof radius.product

/** The webapp's Tailwind `borderRadius.DEFAULT`. Points at the same tier a
    bare `rounded` should mean: the control tier, not the card tier. */
export const radiusDefaultTier: RadiusTier = 'sm'

export const px = (n: number) => `${n}px`

// ───────────────────────────── font stacks ─────────────────────────────

/** One stack per role, shared by every register. The fallbacks matter as
    much as the first entry: dropping the `Variable` suffix off the display
    family falls through to a CJK serif in silence — invisible on a Chinese
    page, obvious on an English one. */
export const fontStacks = {
    sans: [
        'Geist',
        '-apple-system',
        'BlinkMacSystemFont',
        'Segoe UI',
        'Roboto',
        'Arial',
        'sans-serif'
    ],
    mono: [
        'Geist Mono',
        'ui-monospace',
        'SFMono-Regular',
        'Menlo',
        'Monaco',
        'Courier New',
        'monospace'
    ],
    /** Display serif. Source Serif 4 — NOT Fraunces, and it has no SOFT or
        WONK axis, so never emit `font-variation-settings` for it. Loaded
        globally by `styles.css`, so the product can reach for it without
        adding a dependency. */
    display: [
        'Source Serif 4 Variable',
        'Source Han Serif SC',
        'Noto Serif SC',
        'Songti SC',
        'SimSun',
        'serif'
    ]
} as const

export type FontRole = keyof typeof fontStacks

/** Renders a stack the way CSS wants it: multi-word families quoted, the
    generic keyword and `-apple-system`-style idents bare. */
export function fontStackCss(role: FontRole): string {
    return fontStacks[role]
        .map((family) => (/^[a-z-]+$/.test(family) ? family : `'${family}'`))
        .join(', ')
}

/** The display register's shared parameters (DESIGN.landing.md §2.3). */
export const displayParams = {
    weight: 400,
    tracking: '-0.018em',
    lineHeight: '1',
    /** Same visual mass needs a different actual size per face; Source
        Serif 4 takes 1. */
    scale: 1
} as const
