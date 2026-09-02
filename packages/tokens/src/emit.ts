import { isRaw, type Consumer, type TokenTable, type TokenValue } from './types'

export type Theme = 'light' | 'dark'

/** The two colour syntaxes this package exists to reconcile.

    `web` runs Tailwind 3 and reads tokens through `rgb(var(--x) / a)`, so an
    opaque colour must be a bare triplet. `docs` runs Tailwind 4, whose
    `@theme` block needs a complete colour value to derive its utilities.
    `landing` is hand-written CSS in hex. One value, three spellings —
    maintaining them by hand is what let the baselines drift apart. */
export function formatValue(value: TokenValue, consumer: Consumer): string {
    if (isRaw(value)) return value.raw
    const [r, g, b] = value
    if (consumer === 'web') return `${r} ${g} ${b}`
    if (consumer === 'landing')
        return (
            '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')
        )
    return `rgb(${r} ${g} ${b})`
}

function resolve(
    table: TokenTable,
    name: string,
    consumer: Consumer,
    theme: Theme
): TokenValue | null {
    const def = table[name]
    if (!def) return null
    if (def.only && !def.only.includes(consumer)) return null
    return def.overrides?.[consumer]?.[theme] ?? def[theme]
}

/** Emit the `--name: value;` lines for one consumer and one theme, indented
    to sit inside whatever selector the consumer wraps them in. */
export function emitDeclarations(
    table: TokenTable,
    consumer: Consumer,
    theme: Theme,
    indent = ''
): string {
    const lines: string[] = []
    for (const name of Object.keys(table).sort()) {
        const value = resolve(table, name, consumer, theme)
        if (value === null) continue
        const note = table[name].note
        const decl = `${indent}${name}: ${formatValue(value, consumer)};`
        lines.push(note ? `${decl} /* ${note} */` : decl)
    }
    return lines.join('\n')
}

export interface DriftEntry {
    token: string
    consumer: Consumer
    reason: string
}

/** Every divergence still flagged as accidental. Surfaced by
    `pnpm tokens:drift` so the list cannot quietly grow. */
export function listDrift(table: TokenTable): DriftEntry[] {
    const out: DriftEntry[] = []
    for (const [token, def] of Object.entries(table)) {
        for (const [consumer, override] of Object.entries(
            def.overrides ?? {}
        )) {
            if (override.drift)
                out.push({
                    token,
                    consumer: consumer as Consumer,
                    reason: override.reason
                })
        }
    }
    return out.sort((a, b) => a.token.localeCompare(b.token))
}
