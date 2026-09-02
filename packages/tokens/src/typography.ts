/** Type ramps.

    Unlike colour, the two registers are NOT supposed to converge here: the
    webapp is a workbench read for hours at close range and its head scale is
    deliberately compressed (22px page titles), while docs is article-shaped
    and climbs to 30/40px. Forcing one ramp on both would be the wrong kind
    of consistency.

    What genuinely is shared — and what drifted unnoticed — is everything
    that is not a size: tracking, the line-heights below the heading tiers,
    and the weight cap. Those live here once. */

/** Letter-spacing tightens as size grows. Declared in `em`, so one value
    serves every column and both registers — and measured [2026-09-02] the
    two already agreed on all five rungs, which is worth locking in before
    they don't. */
export const tracking = {
    display: '-0.025em',
    h1: '-0.02em',
    h2: '-0.015em',
    h3: '-0.01em',
    h4: '-0.005em'
} as const

/** Line-height diverges only where the sizes do — the heading tiers. From
    `body` down the two registers are identical, which follows: those rungs
    carry the same sizes for the same job. */
export const lineHeight = {
    product: {
        display: '1.15',
        h1: '1.25',
        h2: '1.3',
        h3: '1.4',
        body: '1.5',
        ui: '1.43',
        caption: '1.33',
        code: '1.6'
    },
    docs: {
        display: '1.05',
        h1: '1.1',
        h2: '1.3',
        h3: '1.4',
        h4: '1.45',
        body: '1.5',
        ui: '1.43',
        caption: '1.33',
        code: '1.6'
    }
} as const

/** The webapp's three display-mode columns, in px.

    Hand-picked per rung rather than one base times a coefficient: a ratio
    cannot compress both ends, and the ends are exactly where a ramp needs
    to — small text has a legibility floor, large text has diminishing
    returns. Note `default → large` adds 2 at the top but only 1 at the
    bottom. See DESIGN.md §5. */
export const productSizes = {
    display: { compact: 28, default: 32, large: 36 },
    h1: { compact: 20, default: 22, large: 24 },
    h2: { compact: 18, default: 20, large: 22 },
    h3: { compact: 16, default: 18, large: 20 },
    body: { compact: 15, default: 16, large: 17 },
    chat: { compact: 13, default: 14, large: 15 },
    ui: { compact: 13, default: 14, large: 15 },
    caption: { compact: 11, default: 12, large: 13 },
    code: { compact: 11, default: 12, large: 13 }
} as const

export type ProductRung = keyof typeof productSizes
export type DisplayMode = 'compact' | 'default' | 'large'

/** docs has no display-mode switch, so one column in rem. */
export const docsSizes = {
    display: '2.5rem',
    h1: '1.875rem',
    h2: '1.375rem',
    h3: '1.125rem',
    h4: '1rem',
    body: '0.9375rem',
    ui: '0.8125rem',
    caption: '0.6875rem',
    code: '0.8125rem'
} as const

/** Weight is capped at 500 on every product surface — body sits at 400, so
    500 already reads as a clear step up, and at workbench density a 600
    title reads as shouting. Hierarchy is carried by size, tracking, colour
    and space. DESIGN.md §5: never 600, never 700.

    docs currently ships 600 on h1-h4, which violates that cap. It is
    recorded rather than silently corrected because dropping it to 500 is a
    visible change to every heading on the site. */
export const headingWeight = {
    product: 500,
    docs: {
        value: 600,
        drift: true,
        reason: 'DESIGN.md §5 caps product surfaces at 500 and names 600 explicitly. docs h1–h4 predate that rule; lowering them is a visible change to every docs heading, so it needs its own commit'
    }
} as const

/** Sizes a rung for a mode, as the px string the stylesheet carries. */
export const productSizeCss = (rung: ProductRung, mode: DisplayMode) =>
    `${productSizes[rung][mode]}px`
