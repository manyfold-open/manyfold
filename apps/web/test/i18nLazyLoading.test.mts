import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { build } from 'vite'
import { overlayResolver } from '../vite-overlay'

const root = resolve(import.meta.dirname, '../../..')
const overlay = process.env.I18N_OVERLAY_ROOT
const languages = [
    'en',
    'zh',
    'ar',
    'de',
    'es',
    'fr',
    'hi',
    'ja',
    'ko',
    'pt',
    'ru'
]

declare global {
    interface Window {
        __languageFixture: {
            select(language: string): void
            ready(language: string): Promise<void>
            current(): string
            navigate(path: string | number): void
            mounts(): number
        }
    }
}

test(
    'Web catalog loading pins URL language and keeps late or failed selections from replacing the current language',
    { timeout: 90_000 },
    async () => {
        const result = await build({
            configFile: false,
            envDir: false,
            root: resolve(root, 'apps/web'),
            logLevel: 'silent',
            define: { 'process.env.NODE_ENV': JSON.stringify('development') },
            resolve: {
                alias: {
                    '@': resolve(root, 'apps/web/src'),
                    '@manyfold/shared': resolve(
                        root,
                        'packages/shared/src/index.ts'
                    ),
                    '@manyfold/sdk': resolve(root, 'packages/sdk/src/index.ts'),
                    '@manyfold/i18n': resolve(
                        root,
                        'packages/i18n/src/browser.ts'
                    )
                }
            },
            plugins: [
                overlayResolver(
                    resolve(root, 'apps/web/src'),
                    overlay ? resolve(overlay, 'apps/web-cloud/src') : undefined
                ),
                {
                    name: 'owned-language-fixture',
                    resolveId(id) {
                        if (id === 'virtual:language-fixture') return '\0' + id
                    },
                    load(id) {
                        if (id !== '\0virtual:language-fixture') return
                        return `
                    import React, { StrictMode, useEffect } from 'react'
                    import { createRoot } from 'react-dom/client'
                    import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom'
                    import { I18nProvider, useI18n, i18nReady, loadWebLanguage } from '@/lib/i18n'
                    import { useMarketingLanguagePin } from '@/seo/useMarketingLanguagePin'
                    import { isMarketingPath } from '@/seo/pages'
                    import { getLocale } from '@manyfold/i18n'
                    let marketingMounts = 0
                    const MarketingPin = () => {
                        useMarketingLanguagePin()
                        useEffect(() => { marketingMounts++ }, [])
                        return null
                    }
                    const Fixture = () => {
                        const { language, setLanguage, t } = useI18n()
                        const { pathname } = useLocation()
                        const navigate = useNavigate()
                        useEffect(() => { window.__languageFixture = { select: setLanguage, ready: loadWebLanguage, current: () => language, navigate, mounts: () => marketingMounts } }, [language, setLanguage, navigate])
                        return React.createElement('main', null,
                            isMarketingPath(pathname) && React.createElement(MarketingPin),
                            React.createElement('output', { id: 'pathname' }, pathname),
                            React.createElement('output', { id: 'locale' }, getLocale()),
                            React.createElement('output', { id: 'translated' }, t('common.loading')))
                    }
                    i18nReady.then(() => createRoot(document.getElementById('root')).render(
                        React.createElement(StrictMode, null, React.createElement(I18nProvider, null, React.createElement(BrowserRouter, null, React.createElement(Fixture))))))
                `
                    }
                }
            ],
            build: {
                write: false,
                minify: false,
                sourcemap: false,
                rollupOptions: { input: 'virtual:language-fixture' }
            }
        })
        assert.ok(!('on' in result))
        const output = (Array.isArray(result) ? result : [result]).flatMap(
            (item) => item.output
        )
        const entry = output.find(
            (item) => item.type === 'chunk' && item.isEntry
        )
        assert.ok(entry?.type === 'chunk')
        const catalogPaths = new Map<string, string>()
        for (const item of output)
            if (item.type === 'chunk') {
                assert.ok(
                    !Object.keys(item.modules).some((id) =>
                        id.endsWith('/packages/i18n/src/index.ts')
                    )
                )
                for (const id of Object.keys(item.modules)) {
                    const language =
                        /\/(?:langs(?:\/generated)?|i18n-extra)\/([a-z]{2})\.ts$/.exec(
                            id
                        )?.[1]
                    if (language && language !== 'en') {
                        assert.notEqual(item.fileName, entry.fileName)
                        catalogPaths.set('/' + item.fileName, language)
                    }
                }
            }
        const server = createServer((request, response) => {
            const asset = output.find(
                (item) => '/' + item.fileName === request.url
            )
            if (asset) {
                response.setHeader('content-type', 'text/javascript')
                response.end(asset.type === 'chunk' ? asset.code : asset.source)
            } else {
                response.setHeader('content-type', 'text/html')
                response.end(
                    `<!doctype html><div id="root">Owned static body</div><script type="module" src="/${entry.fileName}"></script>`
                )
            }
        })
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve)
        )
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        const origin = `http://127.0.0.1:${address.port}`
        const browser = await chromium.launch({ headless: true })
        let releaseFrench!: () => void
        const frenchHeld = new Promise<void>((resolve) => {
            releaseFrench = resolve
        })
        try {
            const context = await browser.newContext({ locale: 'en-US' })
            await context.addInitScript(() =>
                localStorage.setItem('nca.web.language', 'de')
            )
            const requested: string[] = []
            const page = await context.newPage()
            const errors: string[] = []
            page.on('pageerror', (error) => errors.push(error.message))
            await page.route('**/*', async (route) => {
                const url = new URL(route.request().url())
                if (url.origin !== origin) return route.abort()
                const language = catalogPaths.get(url.pathname)
                if (language) requested.push(language)
                if (language === 'fr') await frenchHeld
                if (language === 'ja') return route.abort('failed')
                return route.continue()
            })
            await page.goto(origin + '/zh/')
            await page.waitForFunction(
                () => window.__languageFixture?.current() === 'zh'
            )
            assert.equal(
                await page.evaluate(() => window.__languageFixture.mounts()),
                2,
                'the fixture exercises StrictMode effect replay'
            )
            assert.deepEqual([...new Set(requested)], ['zh'])
            assert.equal(
                await page.evaluate(() =>
                    localStorage.getItem('nca.web.language')
                ),
                'de',
                'URL pin must not overwrite stored product language'
            )
            assert.match(
                await page.locator('#translated').innerText(),
                /[\u3400-\u9fff]/
            )
            await page.evaluate(() => window.__languageFixture.select('fr'))
            await page.evaluate(() => window.__languageFixture.select('de'))
            await page.waitForFunction(
                () => window.__languageFixture.current() === 'de'
            )
            releaseFrench()
            await page.evaluate(() => window.__languageFixture.ready('fr'))
            assert.equal(
                await page.evaluate(() => window.__languageFixture.current()),
                'de'
            )
            assert.equal(await page.locator('#locale').innerText(), 'de-DE')
            await page.evaluate(() => window.__languageFixture.select('ja'))
            await page.evaluate(() =>
                window.__languageFixture.ready('ja').catch(() => {})
            )
            assert.equal(
                await page.evaluate(() => window.__languageFixture.current()),
                'de'
            )
            assert.deepEqual(
                errors,
                [],
                'catalog failure is consumed without an unhandled rejection'
            )

            const all = await browser.newContext({ locale: 'en-US' })
            await all.route('**/*', (route) =>
                new URL(route.request().url()).origin === origin
                    ? route.continue()
                    : route.abort()
            )
            const everyPage = await all.newPage()
            await everyPage.goto(origin)
            await everyPage.waitForFunction(() =>
                Boolean(window.__languageFixture)
            )
            for (const language of languages) {
                await everyPage.evaluate(
                    (language) => window.__languageFixture.select(language),
                    language
                )
                await everyPage.waitForFunction(
                    (language) =>
                        window.__languageFixture.current() === language,
                    language
                )
                assert.ok(
                    (await everyPage.locator('#translated').innerText())
                        .length > 0
                )
            }

            for (const destination of [
                'back',
                '/workspace',
                'user-selection'
            ]) {
                const navigation = await browser.newContext({ locale: 'en-US' })
                await navigation.addInitScript(() =>
                    localStorage.setItem('nca.web.language', 'de')
                )
                const navigationPage = await navigation.newPage()
                let releaseChinese!: () => void
                const chineseHeld = new Promise<void>((resolve) => {
                    releaseChinese = resolve
                })
                let requestedChinese!: () => void
                const chineseRequested = new Promise<void>((resolve) => {
                    requestedChinese = resolve
                })
                await navigationPage.route('**/*', async (route) => {
                    const url = new URL(route.request().url())
                    if (url.origin !== origin) return route.abort()
                    if (catalogPaths.get(url.pathname) === 'zh') {
                        requestedChinese()
                        await chineseHeld
                    }
                    return route.continue()
                })
                try {
                    await navigationPage.goto(origin)
                    await navigationPage.waitForFunction(() =>
                        Boolean(window.__languageFixture)
                    )
                    await navigationPage.evaluate(() =>
                        window.__languageFixture.navigate('/zh/')
                    )
                    await chineseRequested
                    await navigationPage.evaluate((destination) => {
                        window.__languageFixture.navigate(
                            destination === 'back' ? -1 : '/workspace'
                        )
                        if (destination === 'user-selection')
                            window.__languageFixture.select('fr')
                    }, destination)
                    await navigationPage.waitForFunction(
                        (pathname) =>
                            document.getElementById('pathname')?.textContent ===
                            pathname,
                        destination === 'back' ? '/' : '/workspace'
                    )
                    releaseChinese()
                    await navigationPage.evaluate(async (destination) => {
                        await window.__languageFixture.ready('zh')
                        if (destination === 'user-selection')
                            await window.__languageFixture.ready('fr')
                        await new Promise((resolve) =>
                            requestAnimationFrame(() =>
                                requestAnimationFrame(resolve)
                            )
                        )
                    }, destination)
                    assert.equal(
                        await navigationPage.evaluate(() =>
                            window.__languageFixture.current()
                        ),
                        destination === 'user-selection' ? 'fr' : 'en',
                        `leaving a pending marketing pin must preserve the current selection: ${destination}`
                    )
                    assert.equal(
                        await navigationPage.evaluate(() =>
                            localStorage.getItem('nca.web.language')
                        ),
                        destination === 'user-selection' ? 'fr' : 'de'
                    )
                    await navigationPage.evaluate(() =>
                        window.__languageFixture.navigate('/workspace')
                    )
                    await navigationPage.waitForURL('**/workspace')
                    await navigationPage.evaluate(() =>
                        window.__languageFixture.navigate('/zh/')
                    )
                    await navigationPage.waitForFunction(
                        () => window.__languageFixture.current() === 'zh'
                    )
                } finally {
                    releaseChinese()
                    await navigation.close()
                }
            }
        } finally {
            releaseFrench()
            await browser.close()
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            )
        }
    }
)
