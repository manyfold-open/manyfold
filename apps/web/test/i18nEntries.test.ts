import assert from 'node:assert/strict'
import test from 'node:test'
import * as synchronous from '../../../packages/i18n/src/index'
import * as browser from '../../../packages/i18n/src/browser'

test('browser and synchronous i18n entries share language, branding and extras state', () => {
    assert.equal(browser.t, synchronous.t)
    assert.equal(browser.setLanguage, synchronous.setLanguage)
    try {
        browser.setLanguage('zh')
        assert.match(synchronous.t('common.loading'), /[\u3400-\u9fff]/)
        synchronous.registerExtraTranslations({
            zh: { 'owned.fixture': 'Manyfold fixture' }
        })
        browser.setBrandName('Owned brand')
        assert.equal(synchronous.t('owned.fixture'), 'Owned brand fixture')
        synchronous.setLanguage('en')
        assert.equal(browser.getLocale(), 'en-US')
        assert.equal(
            synchronous.tForLanguage('zh', 'common.loading'),
            browser.tForLanguage('zh', 'common.loading')
        )
    } finally {
        browser.setLanguage('en')
        browser.setBrandName(null)
        browser.registerExtraTranslations({})
    }
})
