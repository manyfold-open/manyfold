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

/** The apps that consume this package. Each one gets its own emitted file
    because their Tailwind majors disagree on colour syntax. */
export type Consumer = 'web' | 'docs'

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
