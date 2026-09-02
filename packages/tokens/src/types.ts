/** An opaque colour, stored as its three channels so every consumer can pick
    its own syntax: the webapp needs a bare triplet for `rgb(var(--x) / a)`,
    the docs site needs a complete value for Tailwind 4's `@theme`. */
export type Rgb = readonly [number, number, number]

/** A value that is not a plain opaque colour — `rgba(...)`, `var(...)`, a
    shadow recipe, a length. Emitted verbatim to every consumer. */
export interface Raw {
    readonly raw: string
}

export type TokenValue = Rgb | Raw

export const isRaw = (v: TokenValue): v is Raw =>
    typeof v === 'object' && v !== null && 'raw' in v

/** The surfaces that consume this package. Each spells an opaque colour
    differently, which is the whole reason one value needs one home:

      web     bare triplet     `244 244 246`   — Tailwind 3 + rgb(var(--x) / a)
      docs    complete value   `rgb(244 244 246)` — Tailwind 4 `@theme`
      landing hex              `#f4f4f6`       — hand-written `.lp-*` CSS

    Three spellings maintained by hand is how they drifted apart. */
export type Consumer = 'web' | 'docs' | 'landing'

export interface Override {
    readonly light?: TokenValue
    readonly dark?: TokenValue
    /** Mandatory. An override without a stated reason is how the two
        baselines drifted apart in the first place. */
    readonly reason: string
    /** `true` marks a divergence believed to be accidental — copied wrong or
        changed on one side only — kept at its current value so this package
        lands with zero visual change. Unifying them is a separate decision;
        `pnpm tokens:drift` lists everything still flagged. */
    readonly drift?: boolean
}

export interface TokenDef {
    readonly light: TokenValue
    readonly dark: TokenValue
    /** Restrict the token to some consumers. Absent means every consumer. */
    readonly only?: readonly Consumer[]
    readonly overrides?: Partial<Record<Consumer, Override>>
    /** One line on what the token is for. Long rationale belongs in
        DESIGN.md, not here — see the comment convention in AGENTS.md. */
    readonly note?: string
}

export type TokenTable = Record<string, TokenDef>
