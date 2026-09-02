/** Gate: the two CSS baselines must agree with @manyfold/tokens.

    Until the declarations are physically generated into the stylesheets,
    this package is the authoritative *statement* of every `--color-*` value
    and this script is what makes the statement binding. It fails on three
    things:

      - a token whose CSS value differs from what this package declares
        (someone changed one side only — the drift this package exists to
        stop)
      - a `--color-*` in a stylesheet that this package does not know about
      - a token this package declares for a consumer that its stylesheet
        does not carry

    Divergences that are already recorded as an `override` pass, because the
    package declares them on purpose. Run `pnpm tokens:drift` for the ones
    still believed accidental. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatValue } from '../src/emit'
import { normalizeValue, parseColorTokens, parseTokens } from '../src/parse'
import {
    normalizeStack,
    parseFontStack,
    parseRadius,
    parseTailwindRadius
} from '../src/parse-scale'
import { landingColors } from '../src/landing-colors'
import { productColors } from '../src/product-colors'
import { fontStackCss, radius, radiusPill } from '../src/scale'
import { isRaw, type Consumer, type Theme } from '../src/index'

const oss = resolve(__dirname, '../../..')

const BASELINES: Array<{ consumer: Consumer; file: string }> = [
    { consumer: 'web', file: 'apps/web/src/styles.css' },
    { consumer: 'docs', file: 'apps/docs/src/styles/global.css' }
]

const THEMES: Theme[] = ['light', 'dark']
const problems: string[] = []
let compared = 0

for (const { consumer, file } of BASELINES) {
    const css = parseColorTokens(readFileSync(resolve(oss, file), 'utf8'))

    const declared = Object.entries(productColors).filter(
        ([, def]) => !def.only || def.only.includes(consumer)
    )

    for (const theme of THEMES) {
        for (const [name, def] of declared) {
            const expected = def.overrides?.[consumer]?.[theme] ?? def[theme]
            const actual = css[theme][name]
            if (actual === undefined) {
                problems.push(
                    `${file} [${theme}] is missing ${name}, which @manyfold/tokens declares for '${consumer}'`
                )
                continue
            }
            compared++
            const want = normalizeValue(formatValue(expected, consumer))
            const got = normalizeValue(actual)
            if (want === got) continue
            const hint = isRaw(expected)
                ? ''
                : ` (declared as [${(expected as readonly number[]).join(', ')}])`
            problems.push(
                `${file} [${theme}] ${name}\n` +
                    `      css declares : ${actual}\n` +
                    `      tokens expect: ${formatValue(expected, consumer)}${hint}\n` +
                    `      → change the value in packages/tokens/src/product-colors.ts, ` +
                    `or record the difference as an override with a reason`
            )
        }

        const known = new Set(declared.map(([name]) => name))
        for (const name of Object.keys(css[theme])) {
            if (known.has(name)) continue
            if (name in productColors) {
                problems.push(
                    `${file} [${theme}] carries ${name}, but @manyfold/tokens restricts it to ${productColors[
                        name
                    ].only?.join(', ')}`
                )
            } else {
                problems.push(
                    `${file} [${theme}] carries ${name}, which @manyfold/tokens does not declare — ` +
                        `add it to packages/tokens/src/product-colors.ts`
                )
            }
        }
    }
}

// ─────────────────────── landing register ───────────────────────
// `--lp-*` is scoped to `.landing-root`, so it is one file and one
// consumer — no cross-baseline drift is possible. What the gate protects is
// the seam to the shared ramp: if someone edits a hex in the stylesheet,
// the value stops matching the step it is supposed to derive from.
{
    const file = 'apps/web/src/styles.css'
    const css = parseTokens(readFileSync(resolve(oss, file), 'utf8'), '--lp-')
    for (const theme of THEMES) {
        for (const [name, def] of Object.entries(landingColors)) {
            const expected = def[theme]
            const actual = css[theme][name]
            if (actual === undefined) {
                // A token that does not change with the theme is declared
                // once and inherited — re-declaring it in the dark block
                // would be dead weight. Only a token whose value actually
                // differs has to appear in both.
                const sameBothThemes =
                    normalizeValue(formatValue(def.light, 'landing')) ===
                    normalizeValue(formatValue(def.dark, 'landing'))
                if (theme === 'dark' && sameBothThemes) continue
                problems.push(
                    `${file} [${theme}] is missing ${name}, which @manyfold/tokens declares`
                )
                continue
            }
            compared++
            const want = normalizeValue(formatValue(expected, 'landing'))
            if (want === normalizeValue(actual)) continue
            problems.push(
                `${file} [${theme}] ${name}\n` +
                    `      css declares : ${actual}\n` +
                    `      tokens expect: ${formatValue(expected, 'landing')}`
            )
        }
    }
}

// ─────────────────── radius and font stacks ───────────────────
// Not colours, but the same failure mode: one value written down in three
// places with nothing comparing them.

const read = (file: string) => readFileSync(resolve(oss, file), 'utf8')
const webCss = read('apps/web/src/styles.css')
const docsCss = read('apps/docs/src/styles/global.css')
const twConfig = read('apps/web/tailwind.config.ts')

function compareRadius(
    label: string,
    actual: Record<string, number>,
    expected: Record<string, number>,
    expectedPill: number
) {
    for (const [tier, value] of Object.entries(expected)) {
        const got = actual[tier]
        if (got === undefined) {
            problems.push(
                `${label} is missing radius tier '${tier}' (${value}px)`
            )
            continue
        }
        compared++
        if (got !== value)
            problems.push(
                `${label} radius '${tier}' is ${got}px, @manyfold/tokens declares ${value}px`
            )
    }
    if (actual.pill !== undefined) {
        compared++
        if (actual.pill !== expectedPill)
            problems.push(
                `${label} radius 'pill' is ${actual.pill}px, @manyfold/tokens declares ${expectedPill}px`
            )
    }
}

// The webapp's Tailwind config IMPORTS these values, so there is nothing to
// compare — it cannot disagree. What can regress is someone replacing the
// import with literals again, so assert the shape instead of the values.
{
    const label = 'apps/web/tailwind.config.ts'
    if (!/from '@manyfold\/tokens'/.test(twConfig)) {
        problems.push(
            `${label} no longer imports @manyfold/tokens — radius and font stacks must come from the package`
        )
    } else {
        compared++
    }
    const literals = parseTailwindRadius(twConfig)
    const hardcoded = Object.entries(literals).filter(([, value]) =>
        Number.isFinite(value)
    )
    if (hardcoded.length) {
        problems.push(
            `${label} has hardcoded borderRadius values (${hardcoded
                .map(([tier, value]) => `${tier}: ${value}px`)
                .join(', ')}) — take them from radius.product instead`
        )
    }
    for (const role of ['sans', 'mono', 'display'] as const) {
        if (
            !new RegExp(`${role}:\\s*\\[\\.\\.\\.fontStacks\\.${role}\\]`).test(
                twConfig
            )
        ) {
            problems.push(
                `${label} fontFamily.${role} does not spread fontStacks.${role} — it must come from the package`
            )
        } else {
            compared++
        }
    }
}

compareRadius(
    'apps/docs/src/styles/global.css',
    parseRadius(docsCss, '--radius-'),
    radius.product,
    radiusPill.product
)
compareRadius(
    'apps/web/src/styles.css (--lp-r-*)',
    parseRadius(webCss, '--lp-r-'),
    radius.landing,
    radiusPill.landing
)

const STACKS: Array<{
    label: string
    actual: string | null
    role: 'sans' | 'mono' | 'display'
}> = [
    {
        label: 'apps/docs --font-sans',
        actual: parseFontStack(docsCss, '--font-sans'),
        role: 'sans'
    },
    {
        label: 'apps/docs --font-mono',
        actual: parseFontStack(docsCss, '--font-mono'),
        role: 'mono'
    },
    {
        label: 'apps/web --lp-mono',
        actual: parseFontStack(webCss, '--lp-mono'),
        role: 'mono'
    },
    {
        label: 'apps/web --lp-display',
        actual: parseFontStack(webCss, '--lp-display'),
        role: 'display'
    }
]

for (const { label, actual, role } of STACKS) {
    if (actual === null) {
        problems.push(`${label} not found — @manyfold/tokens declares it`)
        continue
    }
    compared++
    const want = normalizeStack(fontStackCss(role))
    if (actual !== want)
        problems.push(
            `${label}\n      css declares : ${actual}\n      tokens expect: ${want}`
        )
}

if (problems.length) {
    console.error(
        `\n  ✗ ${problems.length} token disagreement(s) between the baselines and @manyfold/tokens:\n`
    )
    for (const p of problems) console.error(`    ${p}\n`)
    process.exit(1)
}
console.log(
    `  ✓ ${compared} token values agree across both baselines and @manyfold/tokens`
)
