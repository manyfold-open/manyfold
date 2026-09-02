import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { formatValue, listDrift } from '../src/emit'
import { landingColors } from '../src/landing-colors'
import { coolBiasAt, iris } from '../src/palette'
import { dropLayersOf, normalizeShadow, shadows } from '../src/shadow'
import {
    headingWeight,
    lineHeight,
    productSizes,
    tracking
} from '../src/typography'
import { normalizeValue, parseColorTokens } from '../src/parse'
import { productColors } from '../src/product-colors'

const pkgRoot = resolve(__dirname, '..')

describe('the CSS baselines agree with this package', () => {
    it('tokens:verify passes', () => {
        // The gate itself is the assertion; a disagreement exits non-zero.
        execFileSync(
            process.execPath,
            ['--import', 'tsx', 'scripts/verify.ts'],
            { cwd: pkgRoot, stdio: 'pipe' }
        )
    })
})

describe('emit', () => {
    it('spells an opaque colour per consumer', () => {
        assert.equal(formatValue([10, 12, 15], 'web'), '10 12 15')
        assert.equal(formatValue([10, 12, 15], 'docs'), 'rgb(10 12 15)')
    })

    it('passes non-colour values through untouched', () => {
        const raw = { raw: 'rgba(10, 12, 15, 0.18)' }
        assert.equal(formatValue(raw, 'web'), 'rgba(10, 12, 15, 0.18)')
        assert.equal(formatValue(raw, 'docs'), 'rgba(10, 12, 15, 0.18)')
    })
})

describe('parse', () => {
    it('collapses the two spellings of one colour', () => {
        assert.equal(normalizeValue('rgb(10 12 15)'), '10 12 15')
        assert.equal(normalizeValue('10 12 15'), '10 12 15')
        assert.equal(normalizeValue('rgb(10, 12, 15)'), '10 12 15')
    })

    it('separates light from dark by brace matching', () => {
        const css = `
            :root { --color-fg: 1 1 1; }
            html[data-theme='dark'] { --color-fg: 2 2 2; }
        `
        const parsed = parseColorTokens(css)
        assert.equal(parsed.light['--color-fg'], '1 1 1')
        assert.equal(parsed.dark['--color-fg'], '2 2 2')
    })

    it('ignores declarations inside comments', () => {
        const parsed = parseColorTokens(`
            :root { /* --color-fg: 9 9 9; */ --color-fg: 1 1 1; }
        `)
        assert.equal(parsed.light['--color-fg'], '1 1 1')
    })
})

describe('drift ledger', () => {
    it('every override states a reason', () => {
        for (const [token, def] of Object.entries(productColors)) {
            for (const [consumer, override] of Object.entries(
                def.overrides ?? {}
            )) {
                assert.ok(
                    override.reason.trim().length > 0,
                    `${token} override for ${consumer} has no reason`
                )
            }
        }
    })

    it('holds the drift list at its recorded size', () => {
        // Raising this number means a new accidental divergence landed.
        // Lowering it means one was resolved — update it in that commit.
        assert.equal(listDrift(productColors).length, 6)
    })
})

describe('the shared ramp is what both registers point at', () => {
    it('landing iris tokens derive from the palette, not from copies', () => {
        // The point of `palette.ts` is that aligning the product with
        // landing means pointing at the same steps. If these ever stop
        // being the same objects' values, the two registers can drift on
        // the brand colour again.
        for (const step of [
            50, 100, 200, 300, 400, 500, 600, 700, 800, 900
        ] as const) {
            const token = landingColors[`--lp-iris-${step}`]
            assert.ok(token, `--lp-iris-${step} is not declared`)
            assert.deepEqual(
                token.light,
                [...iris[step]],
                `--lp-iris-${step} light does not match palette step ${step}`
            )
            assert.deepEqual(
                token.dark,
                [...iris[step]],
                `--lp-iris-${step} dark does not match palette step ${step}`
            )
        }
    })

    it('the cool-bias curve is not the flat 2-4 the old spec claimed', () => {
        // Guards the correction in DESIGN.landing.md §1.2: the offset peaks
        // in the mid-greys. A flat reading of it flattened the product ink
        // ramp and made the whole page read warm.
        assert.equal(coolBiasAt(252, 'light'), 1)
        assert.equal(coolBiasAt(244, 'light'), 2)
        assert.ok(
            coolBiasAt(92, 'light') >= 9,
            'mid-grey light bias should peak near 10'
        )
        assert.ok(
            coolBiasAt(140, 'dark') >= 9,
            'mid-grey dark bias should peak near 10'
        )
        assert.equal(coolBiasAt(5, 'dark'), 1)
    })
})

describe('typography', () => {
    it('shares tracking across both registers', () => {
        // Measured [2026-09-02]: the two baselines already agreed on all
        // five rungs. Declared once so they cannot stop agreeing.
        assert.equal(tracking.display, '-0.025em')
        assert.equal(tracking.h1, '-0.02em')
        assert.equal(tracking.h4, '-0.005em')
    })

    it('shares line-height from the body rung down', () => {
        // Heading tiers legitimately differ (the sizes do); below them the
        // rungs carry the same size for the same job, so they must match.
        for (const rung of ['body', 'ui', 'caption', 'code'] as const) {
            assert.equal(
                lineHeight.product[rung],
                lineHeight.docs[rung],
                `line-height diverged at the ${rung} rung`
            )
        }
    })

    it('caps product heading weight at 500', () => {
        // DESIGN.md §5: never 600, never 700 on a product surface.
        assert.equal(headingWeight.product, 500)
    })

    it('records docs 600 headings as drift, not as licence', () => {
        assert.equal(headingWeight.docs.value, 600)
        assert.equal(headingWeight.docs.drift, true)
        assert.ok(headingWeight.docs.reason.includes('DESIGN.md §5'))
    })

    it('keeps the compact column below the default column', () => {
        for (const [rung, col] of Object.entries(productSizes)) {
            assert.ok(
                col.compact < col.default && col.default < col.large,
                `${rung} column is not ascending`
            )
        }
    })
})

describe('shadows', () => {
    it('sees through the two house styles', () => {
        // The webapp writes layers colour-first, docs offset-first. CSS
        // accepts both; a textual diff cannot tell you they are the same.
        assert.equal(
            normalizeShadow('rgba(10, 12, 15, 0.05) 0 1px 2px -1px'),
            normalizeShadow('0 1px 2px -1px rgba(10, 12, 15, 0.05)')
        )
    })

    it('does not collapse a genuine alpha difference', () => {
        assert.notEqual(
            normalizeShadow('rgba(10, 12, 15, 0.11) 0 0 0 1px'),
            normalizeShadow('rgba(10, 12, 15, 0.12) 0 0 0 1px')
        )
    })

    it('keeps every divergence scoped to the ring layer', () => {
        // "docs rings run one step heavier" must not become licence to
        // change the drop layers on one side only.
        for (const [name, spec] of Object.entries(shadows)) {
            if (!spec.docs || !spec.web.includes('),')) continue
            const web = dropLayersOf(spec.web).map(normalizeShadow)
            const docs = dropLayersOf(spec.docs).map(normalizeShadow)
            assert.deepEqual(
                web,
                docs,
                `${name} diverges beyond its ring layer`
            )
        }
    })

    it('states a reason for every divergence', () => {
        for (const [name, spec] of Object.entries(shadows)) {
            if (!spec.docs) continue
            const same =
                normalizeShadow(spec.web) === normalizeShadow(spec.docs)
            if (same) continue
            assert.ok(
                'divergence' in spec && spec.divergence.reason.length > 0,
                `${name} differs between consumers with no stated reason`
            )
        }
    })
})
