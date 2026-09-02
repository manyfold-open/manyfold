import { isRaw, type Consumer, type TokenTable, type TokenValue } from './types'
import type { Theme } from './parse'

const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export const relativeLuminance = ([r, g, b]: readonly number[]) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

/** WCAG 2.1 contrast ratio. */
export function contrastRatio(
    a: readonly number[],
    b: readonly number[]
): number {
    const la = relativeLuminance(a)
    const lb = relativeLuminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** WCAG 1.4.3 for body text, 1.4.11 for non-text marks. */
export const AA_TEXT = 4.5
export const AA_NON_TEXT = 3

/** Resolves a token to plain channels, or null when it is not an opaque
    colour (an `rgba()` line, a `var()` alias) and so cannot be measured
    without knowing what it lands on. */
export function resolveRgb(
    table: TokenTable,
    name: string,
    consumer: Consumer,
    theme: Theme
): readonly number[] | null {
    const seen = new Set<string>()
    let current: string | undefined = name
    while (current) {
        if (seen.has(current)) return null
        seen.add(current)
        const def = table[current]
        if (!def) return null
        const value: TokenValue =
            def.overrides?.[consumer]?.[theme] ?? def[theme]
        if (!isRaw(value)) return value
        const alias = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(value.raw)
        if (!alias) return null
        current = alias[1]
    }
    return null
}
