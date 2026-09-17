import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { build } from 'vite'
import { buildAppHtml, buildPageHtml } from '../src/seo/artifacts'
import { seoPageForPath } from '../src/seo/pages'
import { renderMarketingBody } from '../src/seo/renderStatic'

const app = resolve(import.meta.dirname, '..')
const root = resolve(app, '../..')

test(
    'the served marketing body paints before a low-priority entry while product navigation retains default priority',
    { timeout: 90_000 },
    async () => {
        const result = await build({
            configFile: false,
            envDir: false,
            root: app,
            logLevel: 'silent',
            define: { 'import.meta.env.VITE_API_URL': JSON.stringify('/api') },
            resolve: {
                alias: {
                    '@': resolve(app, 'src'),
                    '@manyfold/i18n': resolve(
                        root,
                        'packages/i18n/src/browser.ts'
                    ),
                    '@manyfold/sdk': resolve(root, 'packages/sdk/src/index.ts'),
                    '@manyfold/shared': resolve(
                        root,
                        'packages/shared/src/index.ts'
                    )
                }
            },
            build: { write: false, minify: false }
        })
        assert.ok(!('on' in result) && !Array.isArray(result))
        const shell = result.output.find(
            (item) => item.type === 'asset' && item.fileName === 'index.html'
        )
        assert.ok(shell?.type === 'asset')
        const entry = result.output.find(
            (item) => item.type === 'chunk' && item.isEntry
        )!
        const entryPath = '/' + entry.fileName
        const pageEntry = seoPageForPath('/')!
        const marketing = buildPageHtml(String(shell.source), {
            entry: pageEntry,
            bodyHtml: renderMarketingBody(pageEntry),
            env: 'production'
        })
        const product = buildAppHtml(String(shell.source))
        const assets = new Map(
            result.output.map((item) => [
                '/' + item.fileName,
                item.type === 'chunk' ? item.code : item.source
            ])
        )
        let holdEntry = true
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        let authCalls = 0
        const server = createServer(async (request, response) => {
            const path = new URL(request.url!, 'http://owned').pathname
            if (path === '/api/auth/config') {
                authCalls++
                response.setHeader('content-type', 'application/json')
                return response.end(JSON.stringify({ configured: false }))
            }
            if (path === '/' || path === '/workspace' || path === '/login') {
                response.setHeader('content-type', 'text/html')
                return response.end(path === '/' ? marketing : product)
            }
            if (holdEntry && path === entryPath) await gate
            const asset = assets.get(path)
            if (asset !== undefined) {
                response.setHeader(
                    'content-type',
                    path.endsWith('.css')
                        ? 'text/css'
                        : path.endsWith('.js')
                          ? 'text/javascript'
                          : path.endsWith('.svg')
                            ? 'image/svg+xml'
                            : 'application/octet-stream'
                )
                return response.end(asset)
            }
            response.writeHead(204)
            response.end()
        })
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve)
        )
        const address = server.address()
        assert.ok(address && typeof address !== 'string')
        const origin = `http://127.0.0.1:${address.port}`
        const browser = await chromium.launch({ headless: true })
        try {
            for (const isMarketing of [true, false]) {
                holdEntry = isMarketing
                const context = await browser.newContext()
                const page = await context.newPage()
                const errors: string[] = []
                page.on('pageerror', (error) => errors.push(error.message))
                await page.route('**/*', (route) =>
                    new URL(route.request().url()).origin === origin
                        ? route.continue()
                        : route.abort()
                )
                const cdp = await context.newCDPSession(page)
                const priorities: string[] = []
                await cdp.send('Network.enable')
                cdp.on('Network.requestWillBeSent', (event) => {
                    if (new URL(event.request.url).pathname === entryPath)
                        priorities.push(event.request.initialPriority)
                })
                await page.goto(origin + (isMarketing ? '/' : '/workspace'), {
                    waitUntil: 'commit'
                })
                if (isMarketing) {
                    await page.locator('.seo-main h1').waitFor()
                    await page.waitForFunction(
                        () =>
                            performance.getEntriesByName(
                                'first-contentful-paint'
                            ).length === 1
                    )
                    assert.equal(authCalls, 0)
                    assert.deepEqual(priorities, ['Low'])
                    release()
                    await page.locator('.lp-scene h1').waitFor()
                } else {
                    await page.waitForLoadState('networkidle')
                    assert.equal(priorities.length, 1)
                    assert.notEqual(priorities[0], 'Low')
                }
                assert.deepEqual(errors, [])
                await context.close()
            }
        } finally {
            release()
            await browser.close()
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            )
        }
    }
)
