import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { chromium, webkit } from 'playwright'
import { build, type Plugin } from 'vite'
import ts from 'typescript'
import type { Logger } from '@axiomhq/logging'
import type { createBrowserTelemetry } from '@manyfold/shared'
import type * as Sentry from '@sentry/react'

declare global {
    interface Window {
        __vitalCallbacks?: Record<string, (metric: unknown) => void>
        __fixture: {
            logger: Logger
            browserTelemetry: ReturnType<typeof createBrowserTelemetry>
            Sentry: typeof Sentry
            vital: () => void
            popupFailure: () => void
        }
    }
}

interface LogRow {
    source: string
    message: string
    path?: string
    webVital: Record<string, unknown>
    fields: {
        app?: string
        env?: string
        reason?: string
        sink?: string
        suppressedCount?: number
    }
}

const root = resolve(import.meta.dirname, '../../..')
const webVitalsModule = createRequire(
    createRequire(import.meta.url).resolve('@axiomhq/react')
).resolve('web-vitals')
const baseline = process.env.BROWSER_TELEMETRY_BASELINE
if (baseline) assert.match(baseline, /^[a-f0-9]{40}$/)
const globalBaseline = process.env.BROWSER_GLOBAL_ERRORS_BASELINE
if (globalBaseline) assert.match(globalBaseline, /^[a-f0-9]{40}$/)

const fixture = async (
    surface: 'web' | 'admin',
    dsn: string
): Promise<string> => {
    const src = resolve(root, 'apps', surface, 'src')
    const entrySource = globalBaseline
        ? execFileSync(
              'git',
              ['show', globalBaseline + ':apps/' + surface + '/src/main.tsx'],
              { cwd: root, encoding: 'utf8' }
          )
        : readFileSync(resolve(src, 'main.tsx'), 'utf8')
    const entryAst = ts.createSourceFile(
        'main.tsx',
        entrySource,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
    )
    const listeners = entryAst.statements.filter((statement) => {
        if (
            !ts.isExpressionStatement(statement) ||
            !ts.isCallExpression(statement.expression)
        )
            return false
        const call = statement.expression
        const name = call.expression.getText(entryAst)
        if (name === 'browserTelemetry.install') return true
        return (
            name === 'window.addEventListener' &&
            call.arguments[0] &&
            ts.isStringLiteral(call.arguments[0]) &&
            ['error', 'unhandledrejection'].includes(call.arguments[0].text)
        )
    })
    assert.ok(
        listeners.length > 0,
        'fixture must exercise the actual app error-listener registration'
    )
    const registration = ts.transpile(
        listeners.map((statement) => statement.getText(entryAst)).join('\n'),
        {
            target: ts.ScriptTarget.ES2022
        }
    )
    const plugin: Plugin = {
        name: 'browser-telemetry-fixture',
        enforce: 'pre',
        resolveId(id) {
            if (id === 'virtual:telemetry-fixture' || id === 'web-vitals')
                return '\0' + id
        },
        load(id) {
            if (baseline && id === resolve(src, 'lib/axiom.ts')) {
                const source = execFileSync(
                    'git',
                    [
                        'show',
                        baseline + ':apps/' + surface + '/src/lib/axiom.ts'
                    ],
                    { cwd: root, encoding: 'utf8' }
                )
                // Preserve the old reporter under test; supply the new shared
                // policy so the rest of the same browser scenario still runs.
                return (
                    source +
                    `
                    import { createBrowserTelemetry } from '@manyfold/shared'
                    export const browserTelemetry = createBrowserTelemetry(logger, { origin: location.origin })
                `
                )
            }
            if (id === '\0web-vitals')
                return (
                    `import * as native from ${JSON.stringify(webVitalsModule)}\n` +
                    ['LCP', 'FID', 'CLS', 'INP', 'FCP', 'TTFB']
                        .map(
                            (name) => `
                    export const on${name} = (callback) => {
                        (window.__vitalCallbacks ??= {})['${name}'] = callback
                        native.on${name}(callback)
                    }
                `
                        )
                        .join('\n')
                )
            if (id !== '\0virtual:telemetry-fixture') return
            return `
                import React from 'react'
                import { createRoot } from 'react-dom/client'
                import { WebVitals, logger, browserTelemetry } from '@/lib/axiom'
                import { Sentry } from '@/lib/sentry'
                import { openDashboardInPopup } from '@/lib/openDashboard'
                ${registration}
                createRoot(document.getElementById('root')).render(
                    React.createElement('main', null,
                        React.createElement('a', { href: '#fixture' }, 'Fixture'),
                        React.createElement(WebVitals)))
                window.__fixture = {
                    logger, browserTelemetry, Sentry,
                    popupFailure: () => {
                        const realOpen = window.open
                        window.open = () => ({ closed: false })
                        openDashboardInPopup({ getControlUiUrl: async () => { throw new Error('original mint failure') } }, { runtimeId: 'fixture' })
                        window.open = realOpen
                    },
                    vital: () => {
                        const element = document.querySelector('a')
                        if (!Object.keys(element).some(key => key.startsWith('__reactFiber')))
                            throw new Error('React did not attach a Fiber to the real DOM node')
                        window.__vitalCallbacks.LCP({ name: 'LCP', value: 20,
                            delta: 20, rating: 'good', id: 'circular-fixture',
                            navigationType: 'navigate', entries: [{ element }] })
                    }
                }
            `
        }
    }
    const output = await build({
        configFile: false,
        envDir: false,
        root: resolve(root, 'apps', surface),
        logLevel: 'silent',
        plugins: [plugin],
        define: {
            'import.meta.env.VITE_AXIOM_TOKEN': JSON.stringify(
                'synthetic-fixture-token'
            ),
            'import.meta.env.VITE_AXIOM_DATASET':
                JSON.stringify('browser-fixture'),
            'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(dsn),
            'import.meta.env.VITE_MF_ENV': JSON.stringify('staging')
        },
        resolve: {
            alias: {
                '@': src,
                '@manyfold/shared': resolve(
                    root,
                    'packages/shared/src/index.ts'
                ),
                '@manyfold/sdk': resolve(root, 'packages/sdk/src/index.ts'),
                '@manyfold/i18n': resolve(root, 'packages/i18n/src/index.ts')
            }
        },
        build: {
            write: false,
            minify: false,
            sourcemap: false,
            rollupOptions: {
                input: 'virtual:telemetry-fixture',
                output: { inlineDynamicImports: true }
            }
        }
    })
    assert.ok(!('on' in output))
    const outputs = Array.isArray(output) ? output : [output]
    const entry = outputs
        .flatMap((value) => value.output)
        .find((value) => value.type === 'chunk' && value.isEntry)
    assert.ok(entry?.type === 'chunk')
    return entry.code
}

for (const surface of ['web', 'admin'] as const) {
    test(
        `${surface}: real React metric, Axiom/Sentry wire and inaccessible popup in Chromium/WebKit`,
        { timeout: 90_000 },
        async () => {
            const envelopes: Array<{
                type: string
                event: Record<string, unknown>
            }> = []
            const server = createServer((req, res) => {
                if (
                    !new URL(
                        req.url ?? '/',
                        'http://localhost'
                    ).pathname.endsWith('/envelope/')
                ) {
                    res.writeHead(404).end()
                    return
                }
                const chunks: Buffer[] = []
                req.on('data', (chunk) => chunks.push(chunk))
                req.on('end', () => {
                    const bytes = Buffer.concat(chunks)
                    const lines = (
                        req.headers['content-encoding'] === 'gzip'
                            ? gunzipSync(bytes)
                            : bytes
                    )
                        .toString()
                        .trim()
                        .split('\n')
                    for (let i = 1; i < lines.length; i += 2)
                        envelopes.push({
                            type: JSON.parse(lines[i]).type,
                            event: JSON.parse(lines[i + 1])
                        })
                    res.setHeader('content-type', 'application/json')
                    res.end('{}')
                })
            })
            await new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', resolve)
            )
            const address = server.address()
            assert.ok(address && typeof address !== 'string')
            const origin = `http://127.0.0.1:${address.port}`
            try {
                const bundle = await fixture(
                    surface,
                    origin.replace('http://', 'http://public@') + '/1'
                )
                for (const engine of [chromium, webkit]) {
                    envelopes.length = 0
                    const browser = await engine.launch({ headless: true })
                    try {
                        const page = await browser.newPage()
                        const rows: LogRow[] = []
                        const unexpected: string[] = []
                        await page.route('**/*', async (route) => {
                            const request = route.request()
                            const url = new URL(request.url())
                            if (
                                url.origin === origin &&
                                url.pathname.endsWith('/envelope/')
                            )
                                return route.continue()
                            if (url.hostname === 'api.axiom.co') {
                                if (request.method() !== 'OPTIONS') {
                                    const bytes =
                                        request.postDataBuffer() ??
                                        Buffer.alloc(0)
                                    const body =
                                        request.headers()[
                                            'content-encoding'
                                        ] === 'gzip'
                                            ? gunzipSync(bytes).toString()
                                            : bytes.toString()
                                    rows.push(
                                        ...body
                                            .trim()
                                            .split('\n')
                                            .filter(Boolean)
                                            .map((line) => JSON.parse(line))
                                    )
                                }
                                return route.fulfill({
                                    contentType: 'application/json',
                                    body: '{"ingested":1,"failed":0}',
                                    headers: {
                                        'access-control-allow-origin': '*',
                                        'access-control-allow-headers': '*'
                                    }
                                })
                            }
                            if (
                                url.origin === origin &&
                                url.pathname === '/entry.js'
                            )
                                return route.fulfill({
                                    contentType: 'text/javascript',
                                    body: bundle
                                })
                            if (url.origin === origin)
                                return route.fulfill({
                                    contentType: 'text/html',
                                    body: '<!doctype html><div id="root"></div><script type="module" src="/entry.js"></script>'
                                })
                            unexpected.push(request.url())
                            await route.abort()
                        })
                        await page.goto(
                            origin +
                                '/agents/agt_abcdefghijklmnopqrstuvwxyz/chat'
                        )
                        await page.waitForFunction(() =>
                            Boolean(window.__vitalCallbacks?.LCP)
                        )
                        await page.evaluate(async () => {
                            const f = window.__fixture
                            f.vital()
                            await f.logger.flush()
                        })
                        const vital = rows.find(
                            (row) =>
                                row.source === 'web-vital' &&
                                row.webVital.id === 'circular-fixture'
                        )
                        assert.ok(
                            vital,
                            'circular metric reaches the actual Axiom wire'
                        )
                        assert.equal(vital.fields.app, surface)
                        assert.equal(vital.fields.env, 'staging')
                        assert.equal(vital.path, '/agents/:id/chat')
                        assert.deepEqual(Object.keys(vital.webVital).sort(), [
                            'delta',
                            'id',
                            'name',
                            'navigationType',
                            'rating',
                            'value'
                        ])
                        const sentryState = await page.evaluate(async () => {
                            const f = window.__fixture
                            f.logger.error('after-circular-vital', { ok: true })
                            await f.logger.flush()
                            const signature =
                                'Invalid call to runtime.sendMessage(). Tab not found.'
                            for (let i = 0; i < 20_000; i++) {
                                const event = new Event('unhandledrejection', {
                                    cancelable: true
                                })
                                Object.defineProperty(event, 'reason', {
                                    value: signature
                                })
                                window.dispatchEvent(event)
                                if (event.defaultPrevented)
                                    throw new Error('default prevented')
                            }
                            // A separate genuine first-party error must still reach
                            // both SDK transports after the rejected extension burst.
                            const real = new Error(
                                'first-party-telemetry-fixture'
                            )
                            const event = new Event('unhandledrejection')
                            Object.defineProperty(event, 'reason', {
                                value: real
                            })
                            window.dispatchEvent(event)
                            const flushed = await f.Sentry.flush(10_000)
                            await f.browserTelemetry.flush()
                            return {
                                flushed,
                                dsn: f.Sentry.getClient()?.getDsn(),
                                handler: typeof window.onunhandledrejection,
                                integrations: f.Sentry.getClient()
                                    ?.getOptions()
                                    .integrations.map(
                                        (integration: { name: string }) =>
                                            integration.name
                                    )
                            }
                        })
                        assert.ok(
                            rows.some(
                                (row) => row.message === 'after-circular-vital'
                            )
                        )
                        assert.equal(
                            rows.filter(
                                (row) =>
                                    row.message === 'unhandledrejection' &&
                                    row.fields.reason?.includes(
                                        'runtime.sendMessage'
                                    )
                            ).length,
                            0
                        )
                        assert.equal(
                            rows.filter(
                                (row) =>
                                    row.message === 'unhandledrejection' &&
                                    row.fields.reason?.includes(
                                        'first-party-telemetry-fixture'
                                    )
                            ).length,
                            1
                        )
                        const summary = rows.find(
                            (row) =>
                                row.message === 'browser.error.suppressed' &&
                                row.fields.sink === 'axiom'
                        )
                        assert.equal(summary?.fields.suppressedCount, 20_000)
                        assert.ok(
                            envelopes.some(
                                (row) =>
                                    row.type === 'event' &&
                                    JSON.stringify(row.event).includes(
                                        'first-party-telemetry-fixture'
                                    )
                            ),
                            JSON.stringify({ sentryState, envelopes })
                        )
                        assert.equal(
                            envelopes.filter(
                                (row) =>
                                    row.type === 'event' &&
                                    JSON.stringify(
                                        row.event.exception
                                    ).includes('runtime.sendMessage')
                            ).length,
                            0
                        )
                        const openedDialog = page.waitForEvent('dialog')
                        const opening = page.evaluate(() =>
                            window.__fixture.popupFailure()
                        )
                        const dialog = await openedDialog
                        assert.match(dialog.message(), /original mint failure/)
                        await dialog.accept()
                        await opening
                        await page.evaluate(() =>
                            window.__fixture.Sentry.flush(10_000)
                        )
                        const popupError = envelopes.find(
                            (row) =>
                                row.event.message ===
                                'Dashboard could not be opened'
                        )
                        assert.equal(
                            (popupError?.event.tags as Record<string, string>)
                                ?.phase,
                            'mint'
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
}
