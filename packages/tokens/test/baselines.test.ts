import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { formatValue, listDrift } from '../src/emit'
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
