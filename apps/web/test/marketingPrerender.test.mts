import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import test from 'node:test'
import { chromium, type Page } from 'playwright'
import { build } from 'vite'
import { seoPageEntries } from '../src/seo/pages'

const app = resolve(import.meta.dirname, '..')

const TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2'
}

// Visitor state a marketing page's first render must ignore (ADR-0042).
const VISITORS: Record<string, Record<string, string>> = {
    'dark theme': { 'nca.web.theme': 'dark' },
    'stored language': { 'nca.web.language': 'ja' },
    'signed-in session': { mf_session: 'mfs_fixture' },
    'consent given': { 'mf.web.analyticsConsent': 'granted' }
}

const worldDrawn = (page: Page): Promise<unknown> =>
    page.waitForFunction(
        () => (document.querySelector('svg.lp-world')?.childElementCount ?? 0) > 0
    )

test(
    'marketing pages are prerendered from the app tree, paint before the app starts and hydrate in place',
    { timeout: 300_000 },
    async () => {
        const out = mkdtempSync(join(tmpdir(), 'mf-prerender-'))
        const dist = join(out, 'dist')
        const ssr = join(out, 'dist-ssr')
        process.env.VITE_API_URL = '/api'
        try {
            await build({
                root: app,
                logLevel: 'silent',
                build: { outDir: dist, emptyOutDir: true, sourcemap: false }
            })
            await build({
                root: app,
                logLevel: 'silent',
                build: {
                    ssr: 'src/entry-server.tsx',
                    outDir: ssr,
                    emptyOutDir: true,
                    sourcemap: false
                }
            })
            const rendered = spawnSync(
                process.execPath,
                [
                    '--import',
                    'tsx',
                    'scripts/render-static.ts',
                    '--dist',
                    dist,
                    '--ssr',
                    ssr
                ],
                {
                    cwd: app,
                    encoding: 'utf8',
                    env: { ...process.env, VITE_MF_ENV: 'production' }
                }
            )
            assert.equal(rendered.status, 0, rendered.stderr)

            const text = (html: string): string =>
                html.replace(/<[^>]+>/g, '').replace(/\s+/g, '')
            for (const entry of seoPageEntries()) {
                const path = entry.path
                const file =
                    path === '/'
                        ? 'index.html'
                        : `${path.replace(/^\/|\/$/g, '')}/index.html`
                const html = readFileSync(join(dist, file), 'utf8')
                const h1s = html.match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? []
                assert.equal(h1s.length, 1, `${path} needs exactly one H1`)
                assert.equal(
                    text(h1s[0]),
                    text(entry.copy.h1),
                    `${path} H1 drifted from the manifest`
                )
                assert.match(html, /<div id="root" data-prerendered="">/)
                assert.doesNotMatch(
                    html,
                    /<script[^>]*type="module"[^>]*src=/,
                    `${path} must start the app after its first paint`
                )
                assert.match(html, /rel="preload" as="font"[^>]*fraunces/)
            }
            const landing = readFileSync(join(dist, 'index.html'), 'utf8')
            assert.match(
                landing,
                /<svg class="lp-world"[^>]*><\/svg>/,
                'the decorative world is drawn after hydration, not shipped in the HTML'
            )
            assert.match(landing, /class="lp-scene" style="opacity:1"/)
            assert.match(
                readFileSync(join(dist, 'app.html'), 'utf8'),
                /<script[^>]*type="module"[^>]*src=/
            )

            const entryPath =
                /src=\\?"(\/assets\/index-[^"\\]+\.js)\\?"/.exec(landing)?.[1] ??
                ''
            assert.ok(entryPath, 'the loader names the app entry')
            let holdEntry = true
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            let authCalls = 0
            let entryRequestedAt = 0
            const server = createServer(async (request, response) => {
                const path = new URL(request.url!, 'http://owned').pathname
                if (path.startsWith('/api/')) {
                    if (path === '/api/auth/config') authCalls++
                    response.setHeader('content-type', 'application/json')
                    return response.end(JSON.stringify({ configured: false }))
                }
                if (path === entryPath && !entryRequestedAt)
                    entryRequestedAt = Date.now()
                if (holdEntry && path === entryPath) await gate
                const file =
                    path === '/'
                        ? 'index.html'
                        : path === '/zh/'
                          ? 'zh/index.html'
                          : path === '/workspace'
                            ? 'app.html'
                            : path.slice(1)
                try {
                    const body = readFileSync(join(dist, file))
                    response.setHeader(
                        'content-type',
                        TYPES[extname(file)] ?? 'application/octet-stream'
                    )
                    response.end(body)
                } catch {
                    response.writeHead(404)
                    response.end()
                }
            })
            await new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', resolve)
            )
            const address = server.address()
            assert.ok(address && typeof address !== 'string')
            const origin = `http://127.0.0.1:${address.port}`
            const browser = await chromium.launch({ headless: true })
            try {
                const context = await browser.newContext()
                const page = await context.newPage()
                const errors: string[] = []
                page.on('pageerror', (error) => errors.push(error.message))
                await page.route('**/*', (route) =>
                    new URL(route.request().url()).origin === origin
                        ? route.continue()
                        : route.abort()
                )
                await page.goto(origin + '/', { waitUntil: 'commit' })
                // The hero paints from HTML while the app is held back, then
                // the app is fetched only once that paint has happened.
                await page.waitForFunction(
                    () =>
                        performance.getEntriesByName('first-contentful-paint')
                            .length === 1
                )
                for (let i = 0; !entryRequestedAt && i < 100; i++)
                    await new Promise((resolve) => setTimeout(resolve, 50))
                assert.ok(entryRequestedAt, 'the page never started the app')
                // Both sides read the machine clock: the server stamped the
                // entry request, the page reports its first paint.
                const paintedAt = await page.evaluate(() => {
                    const hero = document.querySelector('.lp-scene h1') as
                        | (HTMLElement & { prerendered?: boolean })
                        | null
                    if (hero) hero.prerendered = true
                    return hero
                        ? performance.timeOrigin +
                              performance.getEntriesByName(
                                  'first-contentful-paint'
                              )[0].startTime
                        : 0
                })
                assert.ok(paintedAt, 'the hero is in the prerendered page')
                assert.ok(
                    entryRequestedAt >= paintedAt - 5,
                    `the app was requested ${paintedAt - entryRequestedAt}ms before the first paint`
                )
                assert.equal(authCalls, 0)
                holdEntry = false
                release()
                await worldDrawn(page)
                assert.equal(
                    await page.evaluate(
                        () =>
                            (
                                document.querySelector('.lp-scene h1') as
                                    | (HTMLElement & { prerendered?: boolean })
                                    | null
                            )?.prerendered === true
                    ),
                    true,
                    'hydration kept the prerendered hero instead of replacing it'
                )
                assert.deepEqual(errors, [])
                await context.close()

                for (const [visitor, stored] of Object.entries(VISITORS)) {
                    for (const path of ['/', '/zh/']) {
                        const visit = await browser.newContext()
                        await visit.addInitScript((items) => {
                            for (const [key, value] of Object.entries(items))
                                localStorage.setItem(key, value)
                        }, stored)
                        const visitPage = await visit.newPage()
                        const visitErrors: string[] = []
                        visitPage.on('pageerror', (error) =>
                            visitErrors.push(error.message)
                        )
                        await visitPage.route('**/*', (route) =>
                            new URL(route.request().url()).origin === origin
                                ? route.continue()
                                : route.abort()
                        )
                        await visitPage.goto(origin + path)
                        await worldDrawn(visitPage)
                        assert.deepEqual(
                            visitErrors,
                            [],
                            `${path} with ${visitor} failed to hydrate`
                        )
                        await visit.close()
                    }
                }

                const product = await browser.newContext()
                const productPage = await product.newPage()
                const requests: string[] = []
                productPage.on('request', (request) =>
                    requests.push(new URL(request.url()).pathname)
                )
                await productPage.goto(origin + '/workspace', {
                    waitUntil: 'domcontentloaded'
                })
                assert.ok(
                    requests.includes(entryPath),
                    'a product shell still loads the app with the page'
                )
                await product.close()
            } finally {
                release()
                await browser.close()
                server.closeAllConnections()
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => (error ? reject(error) : resolve()))
                )
            }
        } finally {
            rmSync(out, { recursive: true, force: true })
        }
    }
)
