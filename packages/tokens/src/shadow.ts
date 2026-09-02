/** Shadow recipes.

    Three different kinds of difference hide in these, and only one of them
    is real:

    - `-ring` / `-ring-light` genuinely differ in alpha. The docs site runs
      its neutral rings a step heavier because its surface tier is
      shallower — an intentional divergence DESIGN.md §3.1 calls out.

    - `-focus` genuinely differs in SYNTAX, forced by the consumer: the
      webapp's `--color-focus` is a bare triplet so it can write
      `rgb(var(--x) / .18)`, while docs holds a complete colour and has to
      reach for `color-mix()`. Same recipe, two spellings. This one already
      has a dedicated gate (`focusRingTokenFailures` in the parent repo's
      `check-governance.mjs`), which compares the parsed core and halo
      rather than the text.

    - `-card` / `-elevated` differ in one layer and one layer only, and are
      written in two house styles on top of that. Measured [2026-09-02]: the
      two DROP layers are identical, but the webapp writes each layer
      colour-first (`rgba(…) 0 1px 2px -1px`) while docs writes it
      offset-first (`0 1px 2px -1px rgba(…)`) — CSS accepts both and they
      paint the same. The RING layer, though, runs a step heavier on docs
      (.12 vs .11 on card, .14 vs .12 on elevated), which is the same
      intentional divergence as `-ring` above, applied consistently.

      That consistency is the evidence it is deliberate: the "docs rings run
      one step heavier" rule holds across all four tokens. It also means the
      only way to see these differences is to normalise the spellings first,
      which `normalizeShadow` does — reading the raw text, the matching
      layers look different and the differing layer looks the same. */

export interface ShadowSpec {
    /** As the consumer's stylesheet writes it. Kept verbatim so adopting
        this package produces no diff; the normaliser is what proves two
        spellings are the same paint. */
    readonly web: string
    readonly docs?: string
    readonly note?: string
    /** Set when the two are genuinely meant to differ. */
    readonly divergence?: { readonly reason: string }
}

/** Collapses a `box-shadow` value so layer order within a layer, colour
    position and whitespace stop mattering. Two values that normalise equal
    paint the same pixels. */
export function normalizeShadow(value: string): string {
    return value
        .split(/,(?![^(]*\))/)
        .map((layer) => {
            const text = layer.trim().replace(/\s+/g, ' ')
            const colours: string[] = []
            const rest = text
                .replace(
                    /(rgba?\([^)]*\)|color-mix\([^)]*\)|var\([^)]*\)|#[0-9a-fA-F]{3,8})/g,
                    (match) => {
                        colours.push(match.replace(/\s+/g, ''))
                        return ''
                    }
                )
                .trim()
                .replace(/\s+/g, ' ')
            const inset = /\binset\b/.test(rest)
            const lengths = rest
                .replace(/\binset\b/g, '')
                .trim()
                .split(' ')
                .filter(Boolean)
            return [...colours.sort(), ...lengths, inset ? 'inset' : '']
                .filter(Boolean)
                .join(' ')
        })
        .join(' | ')
}

export const shadows = {
    ring: {
        web: 'rgba(10, 12, 15, 0.12) 0 0 0 1px',
        docs: 'rgba(10, 12, 15, 0.18) 0 0 0 1px',
        note: '结构性 1px 环',
        divergence: {
            reason: 'docs 的表面层级更浅，中性环按 DESIGN.md §3.1 重一档（.18 vs .12）'
        }
    },
    ringLight: {
        web: 'rgba(10, 12, 15, 0.09) 0 0 0 1px',
        docs: 'rgba(10, 12, 15, 0.12) 0 0 0 1px',
        note: '静置发丝环',
        divergence: { reason: '同 ring（.12 vs .09）' }
    },
    card: {
        web: 'rgba(10, 12, 15, 0.05) 0 1px 2px -1px, rgba(10, 12, 15, 0.07) 0 4px 10px -5px, rgba(10, 12, 15, 0.11) 0 0 0 1px',
        docs: '0 1px 2px -1px rgba(10, 12, 15, 0.05), 0 4px 10px -5px rgba(10, 12, 15, 0.07), rgba(10, 12, 15, 0.12) 0 0 0 1px',
        note: '静置卡片：实色填充 + 1px 环 + 单层下投',
        divergence: {
            reason: '两层下投完全相同；只有环重一档（.12 vs .11），与 ring / ring-light 同一条规则'
        }
    },
    elevated: {
        web: 'rgba(10, 12, 15, 0.08) 0 2px 6px -2px, rgba(10, 12, 15, 0.13) 0 12px 28px -10px, rgba(10, 12, 15, 0.12) 0 0 0 1px',
        docs: '0 2px 6px -2px rgba(10, 12, 15, 0.08), 0 12px 28px -10px rgba(10, 12, 15, 0.13), rgba(10, 12, 15, 0.14) 0 0 0 1px',
        note: '浮层：popover / menu / modal',
        divergence: {
            reason: '同 card：只有环重一档（.14 vs .12）'
        }
    }
} as const satisfies Record<string, ShadowSpec>

export type ShadowName = keyof typeof shadows

/** The drop layers that must stay identical across consumers — everything
    except the trailing ring, which is where the intentional step lives.
    Strips the last layer and compares the rest. */
export function dropLayersOf(recipe: string): string[] {
    return recipe.split(/,(?![^(]*\))/).slice(0, -1)
}
