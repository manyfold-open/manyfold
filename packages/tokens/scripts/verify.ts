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
import { normalizeValue, parseColorTokens } from '../src/parse'
import { productColors } from '../src/product-colors'
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

if (problems.length) {
    console.error(
        `\n  ✗ ${problems.length} token disagreement(s) between the CSS baselines and @manyfold/tokens:\n`
    )
    for (const p of problems) console.error(`    ${p}\n`)
    process.exit(1)
}
console.log(
    `  ✓ ${compared} token values agree across both baselines and @manyfold/tokens`
)
