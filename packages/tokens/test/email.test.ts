import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    emailFields,
    emailPalette,
    listEmailDrift,
    type EmailField
} from '../src/email'

/** The exact hexes the templates inlined before they consumed this module.
    Captured from `apps/api/src/modules/email/templates/email-content.ts` at
    the commit that introduced the package. Adopting the module must not
    change a single byte of what lands in someone's inbox — a mail already
    sent cannot be recalled, so any intended change to these is its own
    reviewed commit. */
const SHIPPED_LIGHT = {
    floor: '#d8dce0',
    card: '#f7fafc',
    ring: '#dadee3',
    fg: '#0a0c0f',
    muted: '#525861',
    subtle: '#6d747e',
    fill: '#e6e9ed',
    buttonBg: '#0a0c0f',
    buttonFg: '#f7fafc'
}

const SHIPPED_DARK = {
    floor: '#07090c',
    card: '#20242a',
    ring: '#3a3f46',
    fg: '#e4e7ec',
    muted: '#b9bec6',
    subtle: '#7c838c',
    fill: '#2a2f36',
    buttonBg: '#e4e7ec',
    buttonFg: '#0a0c0f'
}

describe('email palette', () => {
    it('reproduces the shipped light palette exactly', () => {
        assert.deepEqual(emailPalette('light'), SHIPPED_LIGHT)
    })

    it('reproduces the shipped dark palette exactly', () => {
        assert.deepEqual(emailPalette('dark'), SHIPPED_DARK)
    })

    it('states a reason for every held-back value', () => {
        const fields = Object.entries(emailFields) as Array<
            [string, EmailField]
        >
        for (const [key, field] of fields) {
            if (!field.drift) continue
            assert.ok(
                field.drift.reason.trim().length > 0,
                `${key} holds a drifted value with no reason`
            )
        }
    })

    it('holds the email drift list at its recorded size', () => {
        // Lowering this means a field was reconciled with its token — do it
        // in the same commit. Raising it means a new one slipped.
        assert.equal(listEmailDrift().length, 6)
    })
})
