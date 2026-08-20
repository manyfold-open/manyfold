import assert from 'node:assert/strict'
import test from 'node:test'
import type { Language } from '@manyfold/i18n'
import {
    marketingLanguageMenuItems,
    selectMarketingLanguage,
    shouldPinMarketingLanguage
} from '../src/components/marketing/marketingLanguage'
import {
    marketingLinkLanguage,
    marketingLinksFor
} from '../src/seo/marketingLinks'

test('marketing links follow the SEO path language and use canonical docs URLs', () => {
    assert.equal(marketingLinkLanguage('/zh/', 'en'), 'zh')
    assert.equal(marketingLinkLanguage('/', 'zh'), 'en')
    assert.equal(marketingLinkLanguage('/challenge', 'zh'), 'zh')
    assert.equal(marketingLinkLanguage('/challenge', 'es'), 'en')

    assert.deepEqual(marketingLinksFor('zh'), {
        home: '/zh/',
        docs: 'https://docs.manyfold.ai/zh/docs/getting-started/',
        changelog: 'https://docs.manyfold.ai/zh/changelog/',
        status: 'https://docs.manyfold.ai/zh/status/',
        privacy: 'https://docs.manyfold.ai/privacy/',
        terms: 'https://docs.manyfold.ai/terms/'
    })
})

test('marketing language menus expose reviewed locales without inventing SEO paths', () => {
    const items = marketingLanguageMenuItems({ en: '/', zh: '/zh/' })

    assert.equal(items.length, 11)
    assert.deepEqual(
        items
            .filter((item) => item.path !== undefined)
            .map((item) => item.code),
        ['en', 'zh']
    )
    assert.deepEqual(
        items
            .filter((item) => item.path === undefined)
            .map((item) => item.code),
        ['es', 'fr', 'de', 'ja', 'ko', 'pt', 'ru', 'ar', 'hi']
    )
})

test('marketing language pin runs once for each pathname', () => {
    assert.equal(shouldPinMarketingLanguage('/', null, 'en'), true)
    assert.equal(shouldPinMarketingLanguage('/', '/', 'en'), false)
    assert.equal(shouldPinMarketingLanguage('/zh/', '/', 'zh'), true)
    assert.equal(shouldPinMarketingLanguage('/zh/', '/zh/', 'zh'), false)
    assert.equal(shouldPinMarketingLanguage('/', null, null), false)
})

test('marketing language pin tracks non-marketing paths between SEO visits', () => {
    let lastPathname: string | null = null
    const visit = (pathname: string, target: 'en' | 'zh' | null): boolean => {
        const shouldPin = shouldPinMarketingLanguage(
            pathname,
            lastPathname,
            target
        )
        lastPathname = pathname
        return shouldPin
    }

    assert.equal(visit('/', 'en'), true)
    assert.equal(visit('/workspace', null), false)
    assert.equal(visit('/', 'en'), true)
})

test('SEO language links use a transient selection even on the current path', () => {
    const items = marketingLanguageMenuItems({ en: '/', zh: '/zh/' })
    const english = items.find((item) => item.code === 'en')
    const chinese = items.find((item) => item.code === 'zh')
    const spanish = items.find((item) => item.code === 'es')
    assert.ok(english)
    assert.ok(chinese)
    assert.ok(spanish)
    const calls: Array<[Language, { persist?: boolean } | undefined]> = []
    const setLanguage = (
        code: Language,
        options?: { persist?: boolean }
    ): void => {
        calls.push([code, options])
    }

    selectMarketingLanguage(english, setLanguage)
    selectMarketingLanguage(chinese, setLanguage)
    selectMarketingLanguage(spanish, setLanguage)
    assert.deepEqual(calls, [
        ['en', { persist: false }],
        ['zh', { persist: false }],
        ['es', undefined]
    ])
})
