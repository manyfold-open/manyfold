import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { build } from 'vite'

declare global {
    interface Window {
        __ownedEntryEvaluated?: boolean
    }
}

const app = resolve(import.meta.dirname, '..')
const root = resolve(app, '../..')

test(
    'the actual async entry waits for a late root and also mounts after DOM readiness has already passed',
    { timeout: 90_000 },
    async () => {
        const output = await build({
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
            plugins: [
                {
                    name: 'observe-owned-entry',
                    transform(code, id) {
                        if (id === resolve(app, 'src/main.tsx'))
                            return (
                                code +
                                '\nwindow.__ownedEntryEvaluated = true;\n'
                            )
                    }
                }
            ],
            build: { write: false, minify: false }
        })
        assert.ok(!('on' in output) && !Array.isArray(output))
        const htmlAsset = output.output.find(
            (item) => item.type === 'asset' && item.fileName === 'index.html'
        )
        assert.ok(htmlAsset?.type === 'asset')
        const html = String(htmlAsset.source)
        const entryTag = html.match(/<script[^>]+type="module"[^>]*>/)?.[0]
    assert.ok(entryTag)
    assert.ok(
        entryTag.includes('async'),
            'Vite must preserve the actual entry async attribute'
        )
        const entryPath = /src="([^"]+)"/.exec(entryTag)?.[1]
        assert.ok(entryPath)
        const assets = new Map(
            output.output.map((item) => [
                '/' + item.fileName,
                item.type === 'chunk' ? item.code : item.source
            ])
        )
        const split = html.indexOf('<body>')
        assert.ok(split > 0)
        let holdBody = true
        let releaseBody!: () => void
        const bodyGate = new Promise<void>((resolve) => {
            releaseBody = resolve
        })
        let releaseEntry!: () => void
        const entryGate = new Promise<void>((resolve) => {
            releaseEntry = resolve
        })
        let authCalls = 0
        const server = createServer(async (request, response) => {
            const path = new URL(request.url!, 'http://owned').pathname
            if (path === '/api/auth/config') {
                authCalls++
                response.setHeader('content-type', 'application/json')
                return response.end(JSON.stringify({ configured: false }))
            }
            if (path === '/') {
                response.setHeader('content-type', 'text/html')
                if (holdBody) {
                    response.write(html.slice(0, split))
                    response.flushHeaders()
                    await bodyGate
                    return response.end(html.slice(split))
                }
                return response.end(html)
            }
            if (!holdBody && path === entryPath) await entryGate
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
            for (const earlyEntry of [true, false]) {
                holdBody = earlyEntry
                const context = await browser.newContext()
                const page = await context.newPage()
                const errors: string[] = []
                page.on('pageerror', (error) => errors.push(error.message))
                page.on('console', (message) => {
                    if (
                        /already.*createRoot|createRoot.*already/.test(
                            message.text()
                        )
                    )
                        errors.push(message.text())
                })
                await page.route('**/*', (route) =>
                    new URL(route.request().url()).origin === origin
                        ? route.continue()
                        : route.abort()
                )
                const before = authCalls
                await page.goto(origin, { waitUntil: 'commit' })
                if (earlyEntry) {
                    await page
                        .waitForFunction(
                            () => window.__ownedEntryEvaluated === true
                        )
                        .catch((error) => {
                            throw new Error(
                                `Entry evaluation did not complete; page errors: ${JSON.stringify(errors)}`,
                                { cause: error }
                            )
                        })
                    await page.evaluate(() => Promise.resolve())
                    assert.equal(await page.locator('#root').count(), 0)
                    assert.equal(
                        authCalls,
                        before,
                        'the actual auth provider must not start before its root exists'
                    )
                    assert.deepEqual(errors, [])
                    releaseBody()
                } else {
                    await page.waitForFunction(
                        () => document.readyState !== 'loading'
                    )
                    assert.equal(await page.locator('#root').count(), 1)
                    assert.equal(await page.locator('#root').innerHTML(), '')
                    releaseEntry()
                }
                await page.locator('.landing-root h1').waitFor()
                await page.waitForLoadState('networkidle')
                const mountedCalls = authCalls
                assert.ok(mountedCalls > before)
                await page.evaluate(async () => {
                    document.dispatchEvent(new Event('DOMContentLoaded'))
                    await new Promise<void>((resolve) =>
                        requestAnimationFrame(() =>
                            requestAnimationFrame(() => resolve())
                        )
                    )
                })
                assert.equal(
                    authCalls,
                    mountedCalls,
                    'a second readiness notification must not start another root'
                )
                assert.deepEqual(errors, [])
                await context.close()
            }
        } finally {
            releaseBody()
            releaseEntry()
            await browser.close()
            server.closeAllConnections()
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            )
        }
    }
)
