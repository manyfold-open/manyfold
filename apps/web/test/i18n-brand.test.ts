import assert from 'node:assert/strict'
import test from 'node:test'
import {
    registerExtraTranslations,
    setBrandName,
    t,
    tForLanguage
} from '@manyfold/i18n'

// Phase-4 white-label substitution: one setBrandName() call rebrands every
// catalog string instead of forking ~950 strings across eleven catalogs.
// The reset discipline matters: brand state is module-global, shared with
// the completeness suite running in the same process.

test('default brand leaves catalog strings byte-identical', () => {
    setBrandName(undefined)
    assert.equal(t('common.appName'), 'Manyfold')
    assert.equal(tForLanguage('zh', 'common.appName'), 'Manyfold')
})

test('a configured brand substitutes across catalogs and languages', () => {
    setBrandName('Acme Agents')
    try {
        assert.equal(t('common.appName'), 'Acme Agents')
        assert.equal(tForLanguage('zh', 'common.appName'), 'Acme Agents')
        // A sentence-embedded occurrence, not just the standalone key.
        assert.ok(
            tForLanguage(
                'en',
                'web.selfOwned.deleteHostDesc',
                { name: 'm1' }
            ).includes('Acme Agents')
        )
    } finally {
        setBrandName(undefined)
    }
})

test('params are user content and are never rebranded', () => {
    setBrandName('Acme Agents')
    try {
        // An agent the user literally named "Manyfold helper" must keep its
        // name: the swap runs on the resolved template BEFORE interpolation.
        const text = tForLanguage(
            'en',
            'web.selfOwned.deleteHostDesc',
            { name: 'Manyfold helper' }
        )
        assert.ok(text.includes('Manyfold helper'))
        assert.ok(!text.includes('Acme Agents helper'))
    } finally {
        setBrandName(undefined)
    }
})

test('registered extras go through the same substitution point', () => {
    registerExtraTranslations({
        en: { 'test.brandExtra': 'Welcome to Manyfold!' }
    })
    setBrandName('Acme Agents')
    try {
        assert.equal(t('test.brandExtra'), 'Welcome to Acme Agents!')
    } finally {
        setBrandName(undefined)
        registerExtraTranslations({})
    }
})

test('blank or whitespace names fall back to the default brand', () => {
    setBrandName('   ')
    try {
        assert.equal(t('common.appName'), 'Manyfold')
    } finally {
        setBrandName(undefined)
    }
})
