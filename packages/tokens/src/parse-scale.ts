/** Reads radius and font-stack declarations back out of a stylesheet, so the
    gate can compare them against `scale.ts`. Same narrow-target rationale as
    `parse.ts`. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** `--radius-md: 14px` → `{ md: 14 }`, `--lp-r-md: 16px` → `{ md: 16 }`. */
export function parseRadius(
    css: string,
    prefix: '--radius-' | '--lp-r-'
): Record<string, number> {
    const out: Record<string, number> = {}
    const pattern = new RegExp(
        `${prefix.replace(/[-]/g, '\\$&')}([a-z0-9]+)\\s*:\\s*([\\d.]+)px`,
        'g'
    )
    for (const m of stripComments(css).matchAll(pattern)) {
        if (!(m[1] in out)) out[m[1]] = Number(m[2])
    }
    return out
}

/** Collapses a font stack so quoting and whitespace differences do not
    register as a mismatch — only the family sequence matters. */
export function normalizeStack(value: string): string {
    return value
        .split(',')
        .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .join(', ')
}

export function parseFontStack(css: string, name: string): string | null {
    const m = new RegExp(`${name}\\s*:\\s*([^;{}]+);`).exec(stripComments(css))
    return m ? normalizeStack(m[1]) : null
}

/** The webapp keeps its stacks in `tailwind.config.ts` as JS arrays. */
export function parseTailwindStack(
    source: string,
    role: string
): string | null {
    const m = new RegExp(`${role}:\\s*\\[([^\\]]+)\\]`).exec(source)
    return m ? normalizeStack(m[1]) : null
}

/** Tailwind's `borderRadius` block, as `{ tier: px }`. */
export function parseTailwindRadius(source: string): Record<string, number> {
    const block = /borderRadius:\s*\{([\s\S]*?)\n\s*\},/.exec(source)
    if (!block) return {}
    const out: Record<string, number> = {}
    for (const m of block[1].matchAll(/'?([a-z0-9]+)'?\s*:\s*'([\d.]+)px'/g)) {
        out[m[1]] = Number(m[2])
    }
    return out
}
