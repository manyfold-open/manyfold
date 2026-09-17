import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { before } from 'node:test'
import { chromium } from 'playwright'
import { build } from 'vite'
import type {
    AdminChatSessionSummary,
    AdminChatSessionTurn
} from '@manyfold/shared'

const root = resolve(import.meta.dirname, '../../..')
const origin = 'http://admin-outcome.test'
const assets = new Map<string, { contentType: string; body: string | Buffer }>()
let entry = ''
let styles = ''
before(async () => {
    const output = await build({
        configFile: false,
        envDir: false,
        root: resolve(root, 'apps/admin'),
        logLevel: 'silent',
        define: { 'import.meta.env.VITE_API_URL': JSON.stringify('/api') },
        resolve: {
            alias: {
                '@': resolve(root, 'apps/admin/src'),
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
                input: resolve(
                    import.meta.dirname,
                    'chat-session-outcome-fixture.tsx'
                ),
                output: { inlineDynamicImports: true }
            }
        }
    })
    assert.ok(!('on' in output))
    for (const item of (Array.isArray(output) ? output : [output]).flatMap(
        (bundle) => bundle.output
    )) {
        const path = '/' + item.fileName
        if (item.type === 'chunk') {
            if (item.isEntry) entry = path
            assets.set(path, {
                contentType: 'text/javascript',
                body: item.code
            })
        } else {
            const css = path.endsWith('.css')
            if (css) styles += `<link rel="stylesheet" href="${path}">`
            assets.set(path, {
                contentType: css ? 'text/css' : 'application/octet-stream',
                body:
                    typeof item.source === 'string'
                        ? item.source
                        : Buffer.from(item.source)
            })
        }
    }
    assert.ok(entry)
})

const at = '2026-09-01T10:00:00.000Z'
const summary = (id: string, failed = false): AdminChatSessionSummary => ({
    id,
    title: failed ? 'Failed fixture' : 'Cancelled fixture',
    userId: 'fixture-user',
    userEmail: 'fixture@example.invalid',
    userDisplayName: null,
    agentId: 'fixture-agent',
    agentName: 'Fixture agent',
    agentFramework: 'codex',
    agentRuntime: 'daemon',
    channel: null,
    status: failed ? 'failed' : 'idle',
    inflightMessageId: null,
    lastTurnState: failed ? 'failed' : 'cancelled',
    lastError: failed
        ? {
              code: 'runtime_unavailable',
              message: 'Fixture unavailable',
              retryable: true
          }
        : null,
    messageCount: 2,
    lastMessageAt: at,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    frameworkSessionRef: null,
    createdAt: at,
    updatedAt: at
})
const turn = (
    id: string,
    withExecution: boolean,
    failed = false
): AdminChatSessionTurn => ({
    messageId: `message-${id}`,
    createdAt: at,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    firstTokenMs: null,
    totalMs: null,
    outcome: failed ? 'failed' : 'cancelled',
    error: summary(id, failed).lastError,
    execution: withExecution
        ? {
              state: failed ? 'failed' : 'cancelled',
              runtime: 'daemon',
              ownerId: 'fixture-owner',
              spriteName: null,
              adoptCount: 0,
              leaseExpiresAt: at,
              updatedAt: at
          }
        : null,
    compactedStreamRows: 0,
    streamCompactedAt: null
})

for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
]) {
    test(`Admin cancellation stays neutral in list, detail and transcript at ${viewport.width}px`, async () => {
        const browser = await chromium.launch({ headless: true })
        const page = await browser.newPage({ viewport })
        const unexpected: string[] = []
        const errors: string[] = []
        const calls: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        const cancelled = summary('cancelled')
        const failed = summary('failed', true)
        await page.route('**/*', async (route) => {
            const url = new URL(route.request().url())
            if (url.origin !== origin) {
                unexpected.push(url.origin)
                return route.abort()
            }
            if (!url.pathname.startsWith('/api/'))
                return route.fulfill(
                    assets.get(url.pathname) ?? {
                        contentType: 'text/html',
                        body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles}</head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`
                    }
                )
            calls.push(url.pathname + url.search)
            const id = url.pathname.split('/')[4]
            const isFailed = id === 'failed'
            const fixtureTurn = turn(id, id !== 'cancelled', isFailed)
            let body: unknown
            if (url.pathname === '/api/auth/config')
                body = { configured: false }
            else if (url.pathname === '/api/admin/chat-sessions')
                body = {
                    items:
                        url.searchParams.get('hasError') === 'true'
                            ? [failed]
                            : [cancelled, failed],
                    nextCursor: null
                }
            else if (url.pathname.endsWith('/turns'))
                body = {
                    items: [
                        {
                            turn: fixtureTurn,
                            input: [
                                {
                                    id: 'prompt',
                                    role: 'user',
                                    contentBlocks: [
                                        { type: 'text', text: 'Fixture prompt' }
                                    ],
                                    createdAt: at
                                }
                            ],
                            result: {
                                id: fixtureTurn.messageId,
                                role: 'assistant',
                                contentBlocks: [],
                                createdAt: at
                            }
                        }
                    ],
                    nextBefore: null
                }
            else if (url.pathname.endsWith('/events'))
                body = {
                    items: [
                        {
                            id: '1',
                            messageId: fixtureTurn.messageId,
                            seq: 1,
                            eventType: 'error',
                            payloadJson: {
                                error: {
                                    code: isFailed
                                        ? 'runtime_unavailable'
                                        : 'cancelled_by_user'
                                }
                            },
                            runnerSeq: null,
                            createdAt: at
                        }
                    ],
                    nextCursor: null
                }
            else if (/^\/api\/admin\/chat-sessions\/[^/]+$/.test(url.pathname))
                body = {
                    session: summary(id, isFailed),
                    turns: [fixtureTurn],
                    eventCounts: { error: 1 }
                }
            else {
                unexpected.push(url.pathname)
                return route.abort()
            }
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify(body)
            })
        })
        try {
            await page.goto(`${origin}/chat-sessions`)
            await page
                .getByRole('link', { name: 'Cancelled fixture', exact: true })
                .waitFor()
            const cancelledRow = page
                .getByRole('row')
                .filter({ hasText: 'Cancelled fixture' })
            assert.equal(
                await cancelledRow.getByText('idle', { exact: true }).count(),
                1
            )
            assert.equal(
                await cancelledRow
                    .locator('span.border')
                    .getByText('cancelled', { exact: true })
                    .count(),
                1
            )
            await page.getByRole('button', { name: 'Has errors', exact: true }).click()
            await page.waitForFunction(
                () => !document.body.textContent?.includes('Cancelled fixture')
            )
            assert.equal(
                await page
                    .getByRole('link', { name: 'Failed fixture', exact: true })
                    .count(),
                1
            )
            assert.ok(calls.some((path) => path.includes('hasError=true')))
            for (const id of ['cancelled', 'legacy']) {
                await page.goto(`${origin}/chat-sessions/${id}`)
                await page
                    .getByText('Fixture prompt', { exact: true })
                    .waitFor()
                const badges = page.locator('span.border').filter({ hasText: /^cancelled$/ })
                assert.equal(
                    await badges.count(),
                    2,
                    'turn table and transcript both show the outcome'
                )
                for (const badge of await badges.all()) {
                    assert.match(
                        (await badge.getAttribute('class')) ?? '',
                        /bg-white/
                    )
                    assert.doesNotMatch(
                        (await badge.getAttribute('class')) ?? '',
                        /accent-ruby/
                    )
                }
                assert.equal(
                    await page.getByText('failed', { exact: true }).count(),
                    0
                )
                assert.equal(
                    await page.getByText('idle', { exact: true }).count(),
                    1
                )
                assert.ok(
                    (await page.getByText(/cancelled_by_user/).count()) > 0,
                    'raw wire remains inspectable'
                )
                await page
                    .getByRole('button', { name: 'Refresh', exact: true })
                    .click()
                await page
                    .getByText('Fixture prompt', { exact: true })
                    .waitFor()
                if (process.env.ADMIN_OUTCOME_SCREENSHOT_DIR) {
                    await mkdir(process.env.ADMIN_OUTCOME_SCREENSHOT_DIR, {
                        recursive: true
                    })
                    await page.screenshot({
                        path: resolve(
                            process.env.ADMIN_OUTCOME_SCREENSHOT_DIR,
                            `${id}-${viewport.width}.png`
                        ),
                        fullPage: true
                    })
                }
            }
            await page.goto(`${origin}/chat-sessions/failed`)
            await page.getByText('Fixture prompt', { exact: true }).waitFor()
            assert.ok(
                (await page.getByText('failed', { exact: true }).count()) >= 3
            )
            assert.ok(
                (await page.getByText(/Fixture unavailable/).count()) >= 1
            )
        } finally {
            await browser.close()
        }
        assert.deepEqual(errors, [])
        assert.deepEqual(unexpected, [])
    })
}
