import { emailPalette } from '@manyfold/tokens'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    DARK_PALETTE,
    LIGHT_PALETTE
} from '../src/modules/email/templates/email-content'
import { renderEmail } from '../src/modules/email/templates/render-email'

/** Mail clients strip custom properties, so email colours are literal hexes
    in the markup — which made this palette a hand-maintained copy of the
    product ramp that fell behind it. `@manyfold/tokens` owns the mapping
    now; these tests pin the seam.

    They exist because the templates have no other colour source: 0 bare
    hexes remain in `email-content.ts` and `render-email.ts`, so if the
    palette is right the rendered mail is right. */
test('the templates take their palette from @manyfold/tokens', () => {
    assert.deepEqual(LIGHT_PALETTE, emailPalette('light'))
    assert.deepEqual(DARK_PALETTE, emailPalette('dark'))
})

test('rendered mail inlines the palette hexes', () => {
    const { html } = renderEmail({
        preheader: 'Verify your address',
        greeting: 'Hello',
        blocks: [
            { kind: 'paragraph', text: 'Confirm the address to continue.' },
            { kind: 'code', value: '482913' },
            { kind: 'button', label: 'Verify', url: 'https://example.test/v' }
        ],
        signoff: 'Thanks'
    })

    // The card, its rule, the recessed code block and the button all draw
    // from the palette. A change to any of these is a visible change to
    // every product email, so it should surface here first.
    for (const [field, hex] of Object.entries(LIGHT_PALETTE)) {
        assert.ok(
            html.includes(hex),
            `light ${field} (${hex}) is missing from the rendered HTML`
        )
    }

    // Dark mode rides a media query in the same document.
    for (const [field, hex] of Object.entries(DARK_PALETTE)) {
        assert.ok(
            html.includes(hex),
            `dark ${field} (${hex}) is missing from the rendered HTML`
        )
    }
})
