import type { Rgb } from './types'

/** Iris — the brand ramp, and the thing both registers are meant to share.

    Calibrated in OKLCH rather than guessed in HSL: hue sits at ~266°, and
    chroma traces an arc peaking near 700 (C 0.231) because blue's usable
    chroma maxes out around L 0.47 — pushing for more at 600's lightness
    just falls out of gamut. Step 600 is the light-mode brand colour at
    C 0.215, the same register as Tailwind blue-600, which is the line
    between "definitely a colour" and "fluorescent".

    The whole ramp is the token; everything else derives from it. Do not
    expose only info/info-bg/info-strong — the ring on a pricing card and a
    focus ring on a dark ground both need step 300, and a step that is not
    exposed is a step someone writes as a bare hex.

    Landing consumes these through `--lp-iris-*`. The product register
    points at the same steps rather than carrying its own blue — which is
    what makes the two read as one brand (DESIGN.product-iris.md §2). */
export const iris = {
    50: [237, 241, 255],
    100: [219, 227, 255],
    200: [185, 200, 253],
    300: [140, 165, 249],
    400: [93, 128, 244],
    500: [66, 107, 240],
    600: [53, 96, 235],
    700: [24, 66, 216],
    800: [24, 51, 160],
    900: [21, 36, 102]
} as const satisfies Record<number, Rgb>

export type IrisStep = keyof typeof iris

/** Ash — the neutral axis.

    Two facts about it are easy to get wrong, and both have already cost a
    round of work:

    1. The cool bias (B above R) is NOT a constant. It tracks lightness —
       0-3 units at the near-white and near-black ends, peaking around 10 in
       the mid-greys where the ink ramp sits. `DESIGN.landing.md` §1.2 once
       claimed a flat "2-4 units", which is true of the background tiers
       only; applied to a whole ramp it flattens the text colours and the
       page reads warm, because what gets neutralised is the foreground.

    2. Paper feel comes from near-white lightness and very narrow steps
       between tiers, never from tinting the ground. Tint the ground and the
       accent loses contrast against its own light end, and the whole
       surface wears a filter that cannot be washed out.

    These are the landing tiers. The product keeps its own lightness ladder
    (it has a rail and a floor to stack) but takes this curve for the hue —
    interpolating the offsets between these anchors, which is how the two
    end up on the same hue angle at every lightness. */
export const ashLanding = {
    bgDeep: [231, 232, 234],
    bg: [244, 244, 246],
    bgSoft: [249, 249, 251],
    paper: [252, 252, 253],
    paperRaised: [255, 255, 255],
    ink: [16, 16, 19],
    inkSoft: [42, 43, 48],
    muted: [92, 94, 102],
    subtle: [141, 143, 151],
    faint: [184, 185, 191]
} as const satisfies Record<string, Rgb>

export const ashLandingDark = {
    bgDeep: [5, 5, 6],
    bg: [10, 10, 12],
    bgSoft: [16, 16, 19],
    paper: [22, 23, 25],
    paperRaised: [30, 31, 35],
    ink: [237, 237, 239],
    inkSoft: [198, 199, 203],
    muted: [140, 142, 150],
    subtle: [98, 100, 107],
    faint: [64, 66, 72]
} as const satisfies Record<string, Rgb>

/** The cool-bias curve, as (R channel, B−R) anchors read off the tiers
    above. Interpolating between them is how a consumer with a different
    lightness ladder — the product — lands on the same hue at every step.
    Used by the migration tooling; kept here so the curve has one home. */
export function coolBiasAt(r: number, theme: 'light' | 'dark'): number {
    const anchors: Array<[number, number]> =
        theme === 'light'
            ? [
                  [16, 3],
                  [42, 6],
                  [92, 10],
                  [141, 10],
                  [184, 7],
                  [231, 3],
                  [244, 2],
                  [249, 2],
                  [252, 1],
                  [255, 0]
              ]
            : [
                  [5, 1],
                  [10, 2],
                  [16, 3],
                  [22, 3],
                  [30, 5],
                  [64, 8],
                  [98, 9],
                  [140, 10],
                  [198, 5],
                  [237, 2]
              ]
    if (r <= anchors[0][0]) return anchors[0][1]
    if (r >= anchors[anchors.length - 1][0])
        return anchors[anchors.length - 1][1]
    for (let i = 0; i < anchors.length - 1; i++) {
        const [r0, b0] = anchors[i]
        const [r1, b1] = anchors[i + 1]
        if (r >= r0 && r <= r1) {
            const t = r1 === r0 ? 0 : (r - r0) / (r1 - r0)
            return Math.round(b0 + (b1 - b0) * t)
        }
    }
    return anchors[anchors.length - 1][1]
}
