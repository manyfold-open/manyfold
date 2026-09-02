/** Reads the `--color-*` declarations back out of a consumer's stylesheet.

    This exists so the gate can compare what the CSS actually says against
    what this package declares. Parsing CSS with regexes is normally a bad
    idea; it is sound here because the target is narrow — custom-property
    declarations at the top level of a `:root` / `@theme` / dark block — and
    a parse miss surfaces as a loud gate failure, never as a wrong colour. */
export type Theme = 'light' | 'dark'

/** Matches a dark-theme block opener. The `[^{]*` is load-bearing: the
    product declares its tokens on `html[data-theme='dark']` directly, while
    the landing register scopes them to
    `html[data-theme='dark'] .landing-root` — requiring `{` right after the
    attribute selector silently misses every landing dark value. */
const DARK_SELECTOR = /html\s*\[\s*data-theme\s*=\s*'dark'\s*\][^{]*\{/g

/** Spans of the file that sit inside a dark-theme block, by brace matching. */
function darkSpans(css: string): Array<[number, number]> {
    const spans: Array<[number, number]> = []
    for (const match of css.matchAll(DARK_SELECTOR)) {
        let i = match.index! + match[0].length - 1
        let depth = 0
        for (; i < css.length; i++) {
            if (css[i] === '{') depth++
            else if (css[i] === '}') {
                depth--
                if (depth === 0) break
            }
        }
        spans.push([match.index!, i])
    }
    return spans
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Reads one custom-property family out of a stylesheet, split by theme.
    `prefix` selects the register: `--color-` for the product, `--lp-` for
    landing. */
export function parseTokens(
    css: string,
    prefix: string
): Record<Theme, Record<string, string>> {
    const source = stripComments(css)
    const spans = darkSpans(source)
    const inDark = (pos: number) => spans.some(([a, b]) => pos >= a && pos <= b)
    const out: Record<Theme, Record<string, string>> = { light: {}, dark: {} }
    const pattern = new RegExp(
        `(${prefix.replace(/-/g, '\\$&')}[a-z0-9-]+)\\s*:\\s*([^;{}]+);`,
        'g'
    )
    for (const match of source.matchAll(pattern)) {
        const theme: Theme = inDark(match.index!) ? 'dark' : 'light'
        const [, name, raw] = match
        // First declaration wins: later ones are scoped overrides inside
        // component rules, not the baseline.
        if (!(name in out[theme])) out[theme][name] = raw.trim()
    }
    return out
}

/** Collapses all three colour spellings so `10 12 15`, `rgb(10 12 15)` and
    `#0a0c0f` compare equal. Anything that is not a plain opaque colour is
    compared as whitespace-normalised text. */
export function normalizeValue(value: string): string {
    const v = value.trim().toLowerCase()
    const hex = /^#([0-9a-f]{6})$/.exec(v)
    if (hex)
        return [0, 2, 4]
            .map((i) => String(parseInt(hex[1].slice(i, i + 2), 16)))
            .join(' ')
    const short = /^#([0-9a-f]{3})$/.exec(v)
    if (short)
        return [0, 1, 2]
            .map((i) => String(parseInt(short[1][i].repeat(2), 16)))
            .join(' ')
    const triplet =
        /^rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\)$/.exec(v) ??
        /^([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)$/.exec(v)
    if (triplet)
        return triplet
            .slice(1)
            .map((n) => String(Math.round(Number(n))))
            .join(' ')
    return v.replace(/\s+/g, ' ')
}

/** Product register, the common case. */
export const parseColorTokens = (css: string) => parseTokens(css, '--color-')
