import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { build } from 'vite'
import { inlineEntryStyles } from '../src/seo/inlineEntryStyles'

test(
    'inline entry CSS paints before the module and keeps lazy route stylesheet precedence',
    { timeout: 60_000 },
    async () => {
        const dir = await mkdtemp(join(tmpdir(), 'mf-style-loading-'))
        let server: ReturnType<typeof createServer> | undefined
        let release = () => {}
        const browser = await chromium.launch({ headless: true })
        try {
            const result = await build({
                configFile: false,
                envDir: false,
                root: resolve(import.meta.dirname, '..'),
                logLevel: 'silent',
                css: { postcss: { plugins: [] } },
                plugins: [
                    {
                        name: 'owned-style-order',
                        resolveId(id) {
                            if (id.startsWith('virtual:')) return '\0' + id
                        },
                        load(id) {
                            if (id === '\0virtual:entry')
                                return `import 'virtual:base.css';document.getElementById('route').onclick=async()=>{await import('virtual:route');document.getElementById('sample').textContent='Route loaded'}`
                            if (id === '\0virtual:route')
                                return `import 'virtual:base.css';import 'virtual:route.css'`
                            if (id === '\0virtual:base.css')
                                return '#sample{color:rgb(255,0,0)}'
                            if (id === '\0virtual:route.css')
                                return '#sample{color:rgb(0,0,255)}'
                        }
                    }
                ],
                build: {
                    write: false,
                    minify: false,
                    rollupOptions: { input: 'virtual:entry' }
                }
            })
            assert.ok(!('on' in result) && !Array.isArray(result))
            const entry = result.output.find(
                (item) => item.type === 'chunk' && item.isEntry
            )!
            const css: string[] = [
                ...Reflect.get(entry, 'viteMetadata').importedCss
            ]
            assert.equal(css.length, 1)
            const assets = new Map(
                result.output.map((item) => [
                    '/' + item.fileName,
                    item.type === 'chunk' ? item.code : item.source
                ])
            )
            for (const [path, body] of assets) {
                const target = join(dir, path.slice(1))
                await mkdir(dirname(target), { recursive: true })
                await writeFile(target, body)
            }
            const html = await inlineEntryStyles(
                `<html><head><link rel="stylesheet" href="/${css[0]}"></head><body><div id="sample">Initial content</div><button id="route">Load route</button><script type="module" src="/${entry.fileName}"></script></body></html>`,
                dir
            )
            server = createServer((request, response) => {
                const path = new URL(request.url!, 'http://owned').pathname
                const asset = assets.get(path)
                response.setHeader(
                    'content-type',
                    asset === undefined
                        ? 'text/html'
                        : path.endsWith('.css')
                          ? 'text/css'
                          : 'text/javascript'
                )
                response.end(asset ?? html)
            })
            await new Promise<void>((resolve) =>
                server!.listen(0, '127.0.0.1', resolve)
            )
            const address = server.address()
            assert.ok(address && typeof address !== 'string')
            const origin = `http://127.0.0.1:${address.port}`
            const page = await browser.newPage()
            let releaseModule!: () => void
            const moduleHeld = new Promise<void>((resolve) => {
                releaseModule = resolve
            })
            release = releaseModule
            await page.route('**/*', async (route) => {
                const url = new URL(route.request().url())
                if (url.origin !== origin) return route.abort()
                if (
                    url.pathname === '/' + entry.fileName ||
                    url.pathname === '/' + css[0]
                )
                    await moduleHeld
                return route.continue()
            })
            await page.goto(origin, { waitUntil: 'commit' })
            await page.waitForFunction(
                () =>
                    document.getElementById('sample')?.textContent ===
                        'Initial content' &&
                    getComputedStyle(document.getElementById('sample')!)
                        .color === 'rgb(255, 0, 0)'
            )
            await page.waitForFunction(
                () =>
                    performance.getEntriesByName('first-contentful-paint')
                        .length === 1
            )
            assert.equal(
                await page
                    .locator(`link[href="/${css[0]}"]`)
                    .getAttribute('media'),
                'not all'
            )
            releaseModule()
            await page.waitForLoadState('load')
            await page.getByRole('button', { name: 'Load route' }).click()
            await page.waitForFunction(
                () =>
                    document.getElementById('sample')?.textContent ===
                        'Route loaded' &&
                    getComputedStyle(document.getElementById('sample')!)
                        .color === 'rgb(0, 0, 255)'
            )
            assert.equal(
                await page.locator(`link[href="/${css[0]}"]`).count(),
                1,
                'lazy routes must not append a duplicate global stylesheet after their overrides'
            )
        } finally {
            release()
            await browser.close()
            if (server)
                await new Promise<void>((resolve, reject) =>
                    server!.close((error) =>
                        error ? reject(error) : resolve()
                    )
                )
            await rm(dir, { recursive: true, force: true })
        }
    }
)
