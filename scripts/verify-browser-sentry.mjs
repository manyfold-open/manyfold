import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify, parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import { buildSentryBrowserFixture } from '../apps/web/test/browser-sentry-fixture.ts'

const exec = promisify(execFile)
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const navigationOps = [
    'redirect',
    'cache',
    'DNS',
    'TLS/SSL',
    'connect',
    'request',
    'response',
    'domContentLoadedEvent',
    'loadEvent'
].map((name) => `browser.${name}`)

export const verifyBrowserSentry = async ({
    surface,
    overlayRoot,
    queryParams = ['key'],
    capture = 'history',
    removedParams = [],
    initialStorage = {},
    baselineRef
} = {}) => {
    assert.ok(surface === 'web' || surface === 'admin')
    assert.ok(queryParams.length > 0)
    if (baselineRef) assert.match(baselineRef, /^[a-f0-9]{40}$/)
    const directory = await mkdtemp(join(tmpdir(), 'manyfold-browser-sentry-'))
    let server
    let browser
    const payloads = []
    const wire = []
    const receiverErrors = []
    try {
        await exec(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-keyout',
                join(directory, 'key.pem'),
                '-out',
                join(directory, 'cert.pem'),
                '-days',
                '1',
                '-subj',
                '/CN=localhost'
            ],
            { maxBuffer: 1024 * 1024 }
        )
        let bundle = ''
        server = createServer(
            {
                key: await readFile(join(directory, 'key.pem')),
                cert: await readFile(join(directory, 'cert.pem'))
            },
            (request, response) => {
                const url = new URL(request.url, 'https://localhost')
                if (url.pathname === '/__privacy_redirect') {
                    response.writeHead(302, {
                        location: '/__privacy_fixture' + url.search,
                        connection: 'close'
                    })
                    response.end()
                } else if (url.pathname === '/__privacy_fixture') {
                    response.setHeader(
                        'content-type',
                        'text/html; charset=utf-8'
                    )
                    response.end(
                        '<!doctype html><html><head><title>Browser privacy fixture</title></head><body><main>Privacy fixture</main><script type="module" src="/entry.js"></script></body></html>'
                    )
                } else if (url.pathname === '/entry.js') {
                    response.setHeader(
                        'content-type',
                        'text/javascript; charset=utf-8'
                    )
                    response.end(bundle)
                } else if (
                    url.pathname === '/api/1/envelope/' &&
                    request.method === 'POST'
                ) {
                    const chunks = []
                    request.on('data', (chunk) => chunks.push(chunk))
                    request.on('end', () => {
                        try {
                            const bytes = Buffer.concat(chunks)
                            const body = (
                                request.headers['content-encoding'] === 'gzip'
                                    ? gunzipSync(bytes)
                                    : bytes
                            ).toString('utf8')
                            wire.push(body)
                            // The fixture emits JSON-only envelope items, each on one line.
                            const lines = body.trim().split('\n')
                            JSON.parse(lines[0])
                            for (
                                let index = 1;
                                index < lines.length;
                                index += 2
                            )
                                payloads.push({
                                    type: JSON.parse(lines[index]).type,
                                    event: JSON.parse(lines[index + 1])
                                })
                        } catch (error) {
                            receiverErrors.push(error)
                        }
                        response.setHeader('content-type', 'application/json')
                        response.end('{}')
                    })
                } else {
                    response.writeHead(404)
                    response.end()
                }
            }
        )
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const origin = `https://localhost:${server.address().port}`
        const sourceOverrides = {}
        if (baselineRef)
            for (const file of ['sentry.tsx', 'sentryScrub.ts']) {
                const path = `apps/${surface}/src/lib/${file}`
                sourceOverrides[resolve(coreRoot, path)] = (
                    await exec(
                        'git',
                        ['-C', coreRoot, 'show', `${baselineRef}:${path}`],
                        { maxBuffer: 1024 * 1024 }
                    )
                ).stdout
            }
        bundle = await buildSentryBrowserFixture({
            coreRoot,
            surface,
            dsn: `https://public@localhost:${server.address().port}/1`,
            overlayRoot,
            queryParam: queryParams[0],
            capture,
            sourceOverrides
        })
        browser = await chromium.launch({ headless: true })
        const context = await browser.newContext({ ignoreHTTPSErrors: true })
        await context.addInitScript((storage) => {
            for (const [key, value] of Object.entries(storage))
                globalThis.localStorage.setItem(key, value)
        }, initialStorage)
        const unexpectedRequests = []
        await context.route('**/*', (route) => {
            if (new URL(route.request().url()).origin === origin)
                return route.continue()
            unexpectedRequests.push(new URL(route.request().url()).origin)
            return route.abort()
        })
        const page = await context.newPage()
        const pageErrors = []
        page.on('pageerror', (error) => pageErrors.push(error.message))
        const marker = 'PRIVATE_NAV_' + randomUUID()
        const target = new URL('/__privacy_redirect', origin)
        for (const param of queryParams) target.searchParams.set(param, marker)
        target.searchParams.set('utm_source', 'privacy-fixture')
        await page.goto(target.href, { waitUntil: 'load', timeout: 45000 })
        await page.waitForFunction(
            () => typeof globalThis.__privacyFinish === 'function',
            undefined,
            { timeout: 10000 }
        )
        await page.waitForFunction(
            () =>
                globalThis.performance.getEntriesByType('navigation')[0]
                    ?.loadEventEnd > 0,
            undefined,
            { timeout: 10000 }
        )
        assert.equal(
            await page.evaluate(() => globalThis.__privacyFinish()),
            true
        )
        const snapshot = await page.evaluate(() => globalThis.__privacySnapshot)
        const transaction = payloads.find(
            (item) =>
                item.type === 'transaction' &&
                item.event.contexts?.trace?.op === 'pageload'
        )?.event
        const error = payloads.find(
            (item) =>
                item.type === 'event' &&
                item.event.exception?.values?.some(
                    (value) => value.value === 'Browser privacy fixture'
                )
        )?.event
        const spans = transaction?.spans ?? []
        const phases = [
            ...new Set(
                spans
                    .map((span) => span.op)
                    .filter((op) => op?.startsWith('browser.'))
            )
        ].sort()
        const summary = {
            surface,
            sdkVersion: snapshot.sdkVersion,
            navigationRetainsMarker: snapshot.navigationName.includes(marker),
            primaryRemovedFromLocation: !new URL(
                snapshot.location
            ).searchParams.has(queryParams[0]),
            receivedEnvelopes: wire.length,
            navigationPhases: phases,
            callbacks: snapshot.callbacks,
            wireContainsMarker: wire.some((body) => body.includes(marker)),
            pageErrors,
            unexpectedRequests
        }
        console.log(JSON.stringify(summary))
        assert.deepEqual(receiverErrors, [])
        assert.deepEqual(pageErrors, [])
        assert.deepEqual(unexpectedRequests, [])
        assert.equal(summary.navigationRetainsMarker, true)
        assert.equal(summary.primaryRemovedFromLocation, true)
        assert.ok(transaction, 'no pageload transaction reached the receiver')
        assert.ok(error, 'no error event reached the receiver')
        assert.equal(
            summary.wireContainsMarker,
            false,
            'private navigation token survived serialized envelopes'
        )
        assert.ok(snapshot.callbacks.span >= navigationOps.length)
        assert.ok(snapshot.callbacks.event > 0)
        assert.ok(snapshot.callbacks.transaction > 0)
        assert.equal(snapshot.callbacks.spanLeak, false)
        assert.equal(snapshot.callbacks.finalLeak, false)
        for (const param of removedParams)
            assert.ok(
                wire.every((body) => !body.includes(param)),
                'removed query parameter survived serialized envelopes'
            )
        for (const op of navigationOps) {
            const span = spans.find((span) => span.op === op)
            assert.ok(span, `missing real navigation phase ${op}`)
            assert.match(span.description, /utm_source=privacy-fixture/)
            assert.ok(span.timestamp >= span.start_timestamp)
        }
        assert.equal(transaction.transaction, '/__privacy_fixture')
        assert.equal(error.user?.id, 'browser-privacy-fixture')
        assert.match(
            transaction.contexts.trace.data['url.full'],
            /utm_source=privacy-fixture/
        )
        return { summary, snapshot, marker }
    } finally {
        await browser?.close()
        if (server) {
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        }
        await rm(directory, { recursive: true, force: true })
    }
}

if (
    process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
    const { values } = parseArgs({
        options: {
            surface: { type: 'string' },
            'baseline-ref': { type: 'string' }
        }
    })
    for (const surface of values.surface ? [values.surface] : ['web', 'admin'])
        await verifyBrowserSentry({
            surface,
            baselineRef: values['baseline-ref']
        })
}
