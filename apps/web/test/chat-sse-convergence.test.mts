import assert from 'node:assert/strict'
import {
    createServer,
    request as proxyRequest,
    type ServerResponse
} from 'node:http'
import { setTimeout as wait } from 'node:timers/promises'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import test, { before } from 'node:test'
import { chromium, type Page } from 'playwright'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '../../..')
let bundle = ''
let styles = ''
const assets = new Map<string, { contentType: string; body: string | Buffer }>()
before(async () => {
    const output = await build({
        configFile: false,
        envDir: false,
        root: resolve(root, 'apps/web'),
        logLevel: 'silent',
        define: {
            'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(''),
            'import.meta.env.VITE_AXIOM_TOKEN': JSON.stringify('')
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
        build: {
            target: 'esnext',
            write: false,
            minify: false,
            rollupOptions: {
                input: resolve(import.meta.dirname, 'chat-sse-fixture.tsx'),
                output: { inlineDynamicImports: true }
            }
        }
    })
    assert.ok(!('on' in output))
    for (const item of (Array.isArray(output) ? output : [output]).flatMap(
        (item) => item.output
    )) {
        if (item.type === 'chunk' && item.isEntry) bundle = item.code
        else if (item.type === 'asset') {
            const path = '/' + item.fileName
            if (path.endsWith('.css'))
                styles += `<link rel="stylesheet" href="${path}">`
            assets.set(path, {
                contentType: path.endsWith('.css')
                    ? 'text/css'
                    : 'application/octet-stream',
                body:
                    typeof item.source === 'string'
                        ? item.source
                        : Buffer.from(item.source)
            })
        }
    }
    assert.ok(bundle)
})

type Evidence = {
    snapshot: {
        status: string
        stalled: boolean
        streamingAssistantId: string | null
        reconnectRequired?: boolean
    }
    events: Array<{
        name: string
        reason?: string
        attempts?: number
        attempt?: number
        elapsedMs?: number
    }>
    fallbackCalls: number
    resolvedPages: number
}
const read = (page: Page): Promise<Evidence> =>
    page.evaluate(() =>
        (
            window as unknown as { __chatSseFixture: { read: () => Evidence } }
        ).__chatSseFixture.read()
    )
const until = async (condition: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000
    while (!(await condition())) {
        if (Date.now() > deadline)
            throw new Error('browser fixture condition timed out')
        await wait(10)
    }
}

for (const [mode, width, theme] of [
    ['api-restart', 1440, 'light'],
    ['api-restart', 390, 'dark'],
    ['client-offline', 1440, 'dark'],
    ['client-offline', 390, 'light'],
    ['healthy-keepalive', 1440, 'light']
] as const) {
    test(
        `real browser bounds ${mode} reconnects with only an idle cursor (${width}/${theme})`,
        { timeout: 30_000 },
        async () => {
            let requests = 0,
                active = 0,
                peak = 0
            let pageRecovered = false,
                loads = 0,
                mutations = 0
            const streams = new Set<ServerResponse>()
            const downstream = new Set<ServerResponse>()
            const api = createServer((req, res) => {
                if (req.url === '/health') {
                    res.end('ok')
                    return
                }
                streams.add(res)
                res.once('close', () => streams.delete(res))
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                res.write(': fixture-connected\n\n')
            })
            await new Promise<void>((resolve) =>
                api.listen(0, '127.0.0.1', resolve)
            )
            const apiAddress = api.address()
            assert.ok(apiAddress && typeof apiAddress !== 'string')
            const apiOrigin = `http://127.0.0.1:${apiAddress.port}`
            const server = createServer((req, res) => {
                if (req.method !== 'GET') {
                    mutations++
                    res.writeHead(405).end()
                    return
                }
                const asset = assets.get(req.url ?? '')
                if (asset) {
                    res.writeHead(200, {
                        'content-type': asset.contentType
                    }).end(asset.body)
                    return
                }
                if (req.url === '/entry.js') {
                    res.writeHead(200, {
                        'content-type': 'text/javascript'
                    }).end(bundle)
                    return
                }
                if (req.url?.includes('/messages')) {
                    if (pageRecovered)
                        res.writeHead(200, {
                            'content-type': 'application/json'
                        }).end(
                            JSON.stringify({
                                messages: [],
                                inflightAssistantMessageId: null,
                                streamCursorEventId: '2',
                                hasMore: false,
                                nextBefore: null
                            })
                        )
                    return
                }
                if (req.url?.includes('/stream')) {
                    requests++
                    active++
                    peak = Math.max(peak, active)
                    downstream.add(res)
                    const upstream = proxyRequest(
                        apiOrigin + req.url,
                        (reply) => {
                            res.writeHead(
                                reply.statusCode ?? 502,
                                reply.headers
                            )
                            reply.pipe(res)
                            reply.on('error', () => res.destroy())
                        }
                    )
                    upstream.on('error', () => res.destroy())
                    upstream.end()
                    res.once('close', () => {
                        active--
                        downstream.delete(res)
                        upstream.destroy()
                    })
                    return
                }
                loads++
                res.writeHead(200, { 'content-type': 'text/html' }).end(
                    `<!doctype html><html class="${theme === 'dark' ? 'dark' : ''}" data-theme="${theme}"><head>${styles}</head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`
                )
            })
            await new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', resolve)
            )
            const address = server.address()
            assert.ok(address && typeof address !== 'string')
            const origin = `http://127.0.0.1:${address.port}`
            const browser = await chromium.launch({ headless: true })
            try {
                const context = await browser.newContext({
                    viewport: { width, height: 900 },
                    colorScheme: theme
                })
                await context.route('**/*', (route) =>
                    new URL(route.request().url()).origin === origin
                        ? route.continue()
                        : route.abort()
                )
                const page = await context.newPage()
                await page.goto(origin)
                await page.waitForFunction(() => '__chatSseFixture' in window)
                await page.clock.install()
                await page.evaluate(
                    (knownTurn) =>
                        (
                            window as unknown as {
                                __chatSseFixture: {
                                    start: (id?: string) => void
                                }
                            }
                        ).__chatSseFixture.start(
                            knownTurn ? 'fixture-message' : undefined
                        ),
                    mode === 'healthy-keepalive'
                )
                await until(async () => requests === 1 && streams.size === 1)
                if (mode === 'client-offline') {
                    await context.setOffline(true)
                    // Chromium's offline emulation rejects new fetches but may keep
                    // established TCP reads alive. Cut only the client-facing leg.
                    for (const stream of downstream) stream.destroy()
                    assert.equal(
                        await (await fetch(apiOrigin + '/health')).text(),
                        'ok'
                    )
                } else for (const stream of streams) stream.destroy()
                await until(async () =>
                    (await read(page)).events.some(
                        (event) => event.name === 'chat.sse.disconnected'
                    )
                )
                if (mode === 'healthy-keepalive') {
                    await page.clock.runFor(500)
                    await until(async () => streams.size === 1)
                    await page.clock.runFor(15_000)
                    for (const stream of streams)
                        stream.write(': keepalive 15000\n\n')
                    await page.clock.runFor(15_000)
                    for (const stream of streams)
                        stream.write(': keepalive 30000\n\n')
                    await until(async () =>
                        (await read(page)).events.some(
                            (event) => event.name === 'chat.sse.reconnected'
                        )
                    )
                    await page.clock.runFor(6 * 60_000)
                    assert.equal(
                        (await read(page)).snapshot.reconnectRequired,
                        false
                    )
                    assert.equal(
                        (await read(page)).snapshot.streamingAssistantId,
                        'fixture-message'
                    )
                    assert.equal(streams.size, 1)
                    assert.equal(requests, 2)
                    assert.equal(mutations, 0)
                    return
                }
                for (let iteration = 0; iteration < 20; iteration++) {
                    const count = (await read(page)).events.length
                    await page.clock.runFor(30_000)
                    if (mode === 'api-restart') {
                        await until(
                            async () =>
                                streams.size > 0 ||
                                (await read(page)).snapshot
                                    .reconnectRequired === true
                        )
                        for (const stream of streams) stream.destroy()
                    }
                    await until(
                        async () =>
                            (await read(page)).events.length > count ||
                            (await read(page)).snapshot.reconnectRequired ===
                                true
                    )
                }
                const evidence = await read(page)
                console.log(
                    JSON.stringify({ mode, requests, peak, ...evidence })
                )
                assert.equal(evidence.snapshot.reconnectRequired, true)
                assert.equal(evidence.snapshot.stalled, true)
                assert.notEqual(evidence.snapshot.status, 'error')
                assert.equal(evidence.snapshot.streamingAssistantId, null)
                await page
                    .getByRole('button', { name: 'Reconnect', exact: true })
                    .waitFor()
                if (process.env.SSE_SCREENSHOT_DIR) {
                    await mkdir(process.env.SSE_SCREENSHOT_DIR, {
                        recursive: true
                    })
                    await page.screenshot({
                        path: resolve(
                            process.env.SSE_SCREENSHOT_DIR,
                            `${mode}-${width}-${theme}.png`
                        )
                    })
                }
                assert.equal(
                    await page.evaluate(
                        () => document.documentElement.scrollWidth <= innerWidth
                    ),
                    true
                )
                const count = evidence.events.length
                await page.clock.runFor(60 * 60_000)
                assert.equal(
                    (await read(page)).events.length,
                    count,
                    'automatic work has stopped'
                )
                assert.ok(peak <= 1, 'only one transport subscriber is owned')
                await context.setOffline(false)
                if (mode === 'client-offline' && width === 390) {
                    await page
                        .getByRole('button', {
                            name: 'Reload page',
                            exact: true
                        })
                        .click()
                    await page.waitForLoadState('load')
                    await page.waitForFunction(
                        () => '__chatSseFixture' in window
                    )
                    assert.equal(loads, 2)
                    assert.equal(mutations, 0)
                    return
                }
                pageRecovered = true
                await page
                    .getByRole('button', { name: 'Reconnect', exact: true })
                    .click()
                await until(
                async () => (await read(page)).resolvedPages === 1
                )
                assert.equal(
                    (await read(page)).snapshot.reconnectRequired,
                    false
                )
                const recoveredRequests = requests
            await page.clock.runFor(60 * 60_000)
            assert.equal(requests, recoveredRequests)
            assert.equal((await read(page)).snapshot.reconnectRequired, false)
                assert.equal(
                    mutations,
                    0,
                    'recovery never sends or replays a user turn'
                )
                assert.equal(loads, 1)
            } finally {
                await browser.close()
                for (const stream of streams) stream.destroy()
                server.closeAllConnections()
                await new Promise<void>((resolve) =>
                    server.close(() => resolve())
                )
                api.closeAllConnections()
                await new Promise<void>((resolve) => api.close(() => resolve()))
            }
        }
    )
}
