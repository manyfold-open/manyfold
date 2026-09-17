import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import test from 'node:test'
import { chromium, webkit } from 'playwright'
import { build } from 'vite'

declare global {
    interface Window {
        __consentFixture: {
            consent(value: 'granted' | 'denied'): void
            navigate(path: string): void
            event(): void
        }
        __gaFixture: {
            config: Record<string, unknown>
            events: Array<{ name: string; params: Record<string, unknown> }>
        }
    }
}

const root = resolve(import.meta.dirname, '../../..')
const measurementId = 'G-OWNED1286'

const bundle = async () => {
    const result = await build({
        configFile: false,
        envDir: false,
        root: resolve(root, 'apps/web'),
        logLevel: 'silent',
        define: {
            'import.meta.env.VITE_GA_MEASUREMENT_ID':
                JSON.stringify(measurementId)
        },
        resolve: {
            alias: {
                '@': resolve(root, 'apps/web/src'),
                '@manyfold/shared': resolve(
                    root,
                    'packages/shared/src/index.ts'
                ),
                '@manyfold/sdk': resolve(root, 'packages/sdk/src/index.ts'),
                '@manyfold/i18n': resolve(root, 'packages/i18n/src/index.ts')
            }
        },
        plugins: [
            {
                name: 'owned-consent-fixture',
                resolveId(id) {
                    if (id === 'virtual:consent-fixture') return '\0' + id
                },
                load(id) {
                    if (id !== '\0virtual:consent-fixture') return
                    return `
                    import React, { useEffect } from 'react'
                    import { createRoot } from 'react-dom/client'
                    import { BrowserRouter, useNavigate } from 'react-router-dom'
                    import { GoogleAnalytics, trackEvent } from '@/lib/googleAnalytics'
                    import { setAnalyticsConsent } from '@/lib/analyticsConsent'
                    const Fixture = () => {
                        const navigate = useNavigate()
                        useEffect(() => {
                            window.__consentFixture = {
                                consent: setAnalyticsConsent, navigate,
                                event: () => trackEvent('owned_fixture_event')
                            }
                        }, [navigate])
                        return React.createElement(GoogleAnalytics)
                    }
                    createRoot(document.getElementById('root')).render(
                        React.createElement(BrowserRouter, null, React.createElement(Fixture)))
                `
                }
            }
        ],
        build: {
            write: false,
            minify: false,
            sourcemap: false,
            rollupOptions: {
                input: 'virtual:consent-fixture',
                output: { inlineDynamicImports: true }
            }
        }
    })
    assert.ok(!('on' in result))
    const output = (Array.isArray(result) ? result : [result]).flatMap(
        (item) => item.output
    )
    const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
    assert.ok(entry?.type === 'chunk')
    return entry.code
}

// An owned transport consumer, not a claim about Google's backend. The live
// acceptance run separately inspects vendor cookie writes with sends blocked.
const receiver = `
    window.__gaFixture = { config: {}, events: [] }
    let id
    const consume = entry => {
        const [command, name, params] = Array.from(entry)
        if (command === 'config') {
            id = name
            window.__gaFixture.config = params
            document.cookie = '_ga=owned-fixture;path=/;max-age=' + (params.cookie_expires ?? 63072000)
            document.cookie = '_ga_OWNED1286=owned-fixture;path=/;max-age=' + (params.cookie_expires ?? 63072000)
        }
        if (command === 'event' && !window['ga-disable-' + id])
            window.__gaFixture.events.push({ name, params })
    }
    window.mfDataLayer.forEach(consume)
    window.mfDataLayer.push = function (entry) { consume(entry); return Array.prototype.push.call(this, entry) }
`

test(
    'consent gates the actual GA module, fixes cookie lifetime, and preserves single sanitized pageviews',
    { timeout: 90_000 },
    async () => {
        const source = await bundle()
        const server = createServer((req, res) => {
            if (req.url === '/fixture.js') {
                res.setHeader('content-type', 'text/javascript')
                res.end(source)
            } else {
                res.setHeader('content-type', 'text/html')
                res.end(
                    '<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'
                )
            }
        })
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve)
        )
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        const origin = `http://127.0.0.1:${address.port}`
        try {
            for (const engine of [chromium, webkit]) {
                const browser = await engine.launch({ headless: true })
                try {
                    const context = await browser.newContext()
                    const page = await context.newPage()
                    const google: string[] = []
                    const unexpected: string[] = []
                    await page.route('**/*', async (route) => {
                        const url = new URL(route.request().url())
                        if (url.origin === origin) return route.continue()
                        if (
                            url.hostname === 'www.googletagmanager.com' &&
                            url.pathname === '/gtag/js'
                        ) {
                            google.push(url.pathname)
                            return route.fulfill({
                                contentType: 'text/javascript',
                                body: receiver
                            })
                        }
                        unexpected.push(url.hostname)
                        return route.abort()
                    })
                    await page.goto(
                        origin +
                            '/?key=owned-sensitive-marker&cmd=owned-command#session=owned-token'
                    )
                    await page.waitForFunction(() =>
                        Boolean(window.__consentFixture)
                    )
                    assert.deepEqual(google, [])
                    assert.deepEqual(await context.cookies(), [])
                    await page.evaluate(() =>
                        window.__consentFixture.consent('denied')
                    )
                    await page.reload()
                    await page.waitForFunction(() =>
                        Boolean(window.__consentFixture)
                    )
                    assert.deepEqual(google, [])
                    await page.evaluate(() =>
                        window.__consentFixture.consent('granted')
                    )
                    await page.waitForFunction(
                        () => window.__gaFixture?.events.length === 1
                    )
                    const config = await page.evaluate(
                        () => window.__gaFixture.config
                    )
                    assert.equal(config.send_page_view, false)
                    assert.equal(config.cookie_expires, 400 * 24 * 60 * 60)
                    assert.equal(config.cookie_update, true)
                    assert.equal(google.length, 1)
                    assert.equal(
                        (await context.cookies()).filter((cookie) =>
                            cookie.name.startsWith('_ga')
                        ).length,
                        2
                    )
                    const initial = await page.evaluate(
                        () => window.__gaFixture.events[0]
                    )
                    assert.equal(initial.name, 'page_view')
                    assert.doesNotMatch(
                        JSON.stringify(initial),
                        /owned-sensitive-marker|owned-command|owned-token/
                    )
                    assert.match(String(initial.params.page_title), /Manyfold/)
                    await page.evaluate(() =>
                        window.__consentFixture.navigate('/zh/')
                    )
                    await page.waitForFunction(
                        () => window.__gaFixture.events.length === 2
                    )
                    const chinese = await page.evaluate(
                        () => window.__gaFixture.events[1]
                    )
                    assert.match(
                        String(chinese.params.page_title),
                        /[\u3400-\u9fff]/
                    )
                    await page.reload()
                    await page.waitForFunction(
                        () =>
                            Boolean(window.__consentFixture) &&
                            window.__gaFixture?.events.length === 1
                    )
                    assert.equal(
                        google.length,
                        2,
                        'stored consent loads one tag per document'
                    )
                    await page.evaluate(() => {
                        window.__consentFixture.consent('denied')
                        window.__consentFixture.navigate(
                            '/login?token=owned-token'
                        )
                        window.__consentFixture.event()
                    })
                    await page.waitForURL('**/login?token=owned-token')
                    assert.equal(
                        (await context.cookies()).filter((cookie) =>
                            cookie.name.startsWith('_ga')
                        ).length,
                        0
                    )
                    assert.equal(
                        await page.evaluate(
                            () => window.__gaFixture.events.length
                        ),
                        1
                    )
                    await page.reload()
                    await page.waitForFunction(() =>
                        Boolean(window.__consentFixture)
                    )
                    assert.equal(
                        google.length,
                        2,
                        'withdrawal survives a reload without Google bootstrap'
                    )
                    assert.deepEqual(unexpected, [])
                } finally {
                    await browser.close()
                }
            }
        } finally {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            )
        }
    }
)
