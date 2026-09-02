import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AA_TEXT, contrastRatio, resolveRgb } from '../src/contrast'
import { productColors } from '../src/product-colors'
import type { Consumer, Theme } from '../src/index'

/** Status `-fg` tokens are used as TEXT colours — 93 call sites across
    `apps/web/src` reach for `text-info` / `text-success` / `text-warning` /
    `text-error` — so each one has to clear AA against the surface it sits
    on.

    Every entry below is a BUG, not an exemption. They are recorded so the
    gate can run today; the list must only ever shrink. A token that starts
    passing also fails the test, which is deliberate: it forces the entry to
    be deleted rather than left to rot. Ratios measured against the light
    canvas `--color-main-bg` / dark `--color-main-bg`. */
const KNOWN_FAILURES: Record<string, Partial<Record<Theme, number>>> = {
    '--color-info': { light: 3.82 },
    '--color-success': { light: 3.2 },
    '--color-warning': { light: 2.58 },
    '--color-error': { light: 4.5 },
    '--color-idle': { light: 3.06, dark: 3.92 }
}

const STATUS = [
    '--color-info',
    '--color-success',
    '--color-warning',
    '--color-error',
    '--color-idle'
]

const CANVAS: Record<Consumer, string> = {
    web: '--color-main-bg',
    docs: '--color-main'
}

describe('status colours clear WCAG AA as text', () => {
    for (const consumer of ['web', 'docs'] as Consumer[]) {
        for (const theme of ['light', 'dark'] as Theme[]) {
            for (const token of STATUS) {
                const label = `${consumer} ${theme} ${token}`
                it(label, () => {
                    const fg = resolveRgb(productColors, token, consumer, theme)
                    const bg = resolveRgb(
                        productColors,
                        CANVAS[consumer],
                        consumer,
                        theme
                    )
                    if (!fg || !bg) return
                    const ratio = contrastRatio(fg, bg)
                    const known = KNOWN_FAILURES[token]?.[theme]
                    if (known === undefined) {
                        assert.ok(
                            ratio >= AA_TEXT,
                            `${label} is ${ratio.toFixed(2)}:1, below AA ${AA_TEXT}:1. ` +
                                `Fix the value, or — only with a stated reason — add it to KNOWN_FAILURES.`
                        )
                        return
                    }
                    assert.ok(
                        ratio < AA_TEXT,
                        `${label} now measures ${ratio.toFixed(2)}:1 and passes AA. ` +
                            `Delete its KNOWN_FAILURES entry so the gate protects it.`
                    )
                    assert.ok(
                        Math.abs(ratio - known) < 0.15,
                        `${label} measures ${ratio.toFixed(2)}:1 but KNOWN_FAILURES records ${known}. ` +
                            `The value moved — update the entry, or fix it properly and delete the entry.`
                    )
                })
            }
        }
    }
})
