import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '../../..')
const baseline = process.env.NETMIND_DIALOG_BASELINE
if (baseline) assert.match(baseline, /^[a-f0-9]{40}$/)

test(
    'closed NetMind dialog does not fetch its form; loading, failure, close and token callback stay local to the dialog',
    { timeout: 90_000 },
    async () => {
        const output = await build({
            configFile: false,
            envDir: false,
            root: resolve(root, 'apps/web'),
            logLevel: 'silent',
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
                        'packages/i18n/src/index.ts'
                    )
                }
            },
            plugins: [
                {
                    name: 'owned-netmind-dialog',
                    enforce: 'pre',
                    resolveId(id) {
                        if (id === 'virtual:dialog') return '\0' + id
                    },
                    load(id) {
                        if (
                            baseline &&
                            id ===
                                resolve(
                                    root,
                                    'apps/web/src/components/NetmindSignInDialog.tsx'
                                )
                        )
                            return execFileSync(
                                'git',
                                [
                                    'show',
                                    baseline +
                                        ':apps/web/src/components/NetmindSignInDialog.tsx'
                                ],
                                { cwd: root, encoding: 'utf8' }
                            )
                        if (id !== '\0virtual:dialog') return
                        return `
                    import React, { useState } from 'react'
                    import { createRoot } from 'react-dom/client'
                    import { I18nProvider } from '@/lib/i18n'
                    import { NetmindSignInDialog } from '@/components/NetmindSignInDialog'
                    import { setNetmindConfig } from '@/lib/netmindAuth/config'
                    import '@/styles.css'
                    setNetmindConfig({ authApi: location.origin + '/netmind', sysCode: 'owned-fixture', accountsUrl: '', registerUrl: '', keyProvision: false })
                    window.__receivedTokens = []
                    const Fixture = () => {
                        const [open, setOpen] = useState(false)
                        return React.createElement(I18nProvider, null,
                            React.createElement('h1', null, 'Owned page'),
                            React.createElement('button', { onClick: () => setOpen(true) }, 'Open sign in'),
                            open && React.createElement(NetmindSignInDialog, {
                                title: 'Owned sign in', submitLabel: 'Submit owned login',
                                onClose: () => setOpen(false),
                                onToken: token => { window.__receivedTokens.push(token); setOpen(false) }
                            }))
                    }
                    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
                `
                    }
                }
            ],
            build: {
                write: false,
                minify: false,
                sourcemap: false,
                rollupOptions: { input: 'virtual:dialog' }
            }
        })
        assert.ok(!('on' in output))
        const assets = (Array.isArray(output) ? output : [output]).flatMap(
            (item) => item.output
        )
        const entry = assets.find(
            (item) => item.type === 'chunk' && item.isEntry
        )
        assert.ok(entry?.type === 'chunk')
        const form = assets.find(
            (item) =>
                item.type === 'chunk' &&
                Object.keys(item.modules).some((id) =>
                    id.endsWith('/NetmindSignIn.tsx')
                )
        )
        assert.ok(
            form?.type === 'chunk' && form.fileName !== entry.fileName,
            'the form must remain outside the initial entry'
        )
        let loginCalls = 0
        const server = createServer(async (req, res) => {
            if (req.url === '/netmind/user/emailLogin') {
                let body = ''
                for await (const chunk of req) body += chunk
                assert.equal(req.method, 'POST')
                assert.doesNotMatch(body, /owned-password-123/)
                loginCalls++
                res.setHeader('content-type', 'application/json')
                res.end(
                    JSON.stringify({
                        success: true,
                        data: { loginToken: 'owned-callback-token' }
                    })
                )
                return
            }
            const file = assets.find((item) => '/' + item.fileName === req.url)
            if (file) {
                res.setHeader(
                    'content-type',
                    file.type === 'chunk'
                        ? 'text/javascript'
                        : file.fileName.endsWith('.css')
                          ? 'text/css'
                          : 'application/octet-stream'
                )
                res.end(file.type === 'chunk' ? file.code : file.source)
            } else {
                res.setHeader('content-type', 'text/html')
                res.end(
                    `<!doctype html><div id="root"></div>${assets
                        .filter((item) => item.fileName.endsWith('.css'))
                        .map(
                            (item) =>
                                `<link rel="stylesheet" href="/${item.fileName}">`
                        )
                        .join(
                            ''
                        )}<script type="module" src="/${entry.fileName}"></script>`
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
        try {
            const context = await browser.newContext()
            const page = await context.newPage()
            let release!: () => void
            const held = new Promise<void>((resolve) => {
                release = resolve
            })
            let formRequests = 0
            await page.route('**/*', async (route) => {
                const url = new URL(route.request().url())
                if (url.origin !== origin) return route.abort()
                if (url.pathname === '/' + form.fileName) {
                    formRequests++
                    await held
                }
                return route.continue()
            })
            try {
                await page.goto(origin)
                await page
                    .getByRole('button', { name: 'Open sign in' })
                    .waitFor()
                assert.equal(formRequests, 0)
                await page.getByRole('button', { name: 'Open sign in' }).click()
                await page.getByRole('status').waitFor()
                assert.equal(formRequests, 1)
                assert.equal(
                    await page
                        .getByRole('heading', { name: 'Owned page' })
                        .count(),
                    1
                )
                await page
                    .getByRole('button', { name: 'Close', exact: true })
                    .focus()
                await page.keyboard.press('Escape')
                await page.getByRole('dialog').waitFor({ state: 'detached' })
                release()
                await page.getByRole('button', { name: 'Open sign in' }).click()
                const dialog = page.getByRole('dialog')
                await dialog
                    .locator('input[type="email"]')
                    .fill('owned@example.invalid')
                await dialog
                    .locator('input[type="password"]')
                    .fill('owned-password-123')
                await dialog
                    .getByRole('button', { name: 'Submit owned login' })
                    .click()
                await dialog.waitFor({ state: 'detached' })
                assert.equal(loginCalls, 1)
                assert.deepEqual(
                    await page.evaluate(
                        () =>
                            (
                                window as unknown as {
                                    __receivedTokens: string[]
                                }
                            ).__receivedTokens
                    ),
                    ['owned-callback-token']
                )
            } finally {
                release()
                await context.close()
            }

            const broken = await browser.newContext()
            await broken.addInitScript(() =>
                sessionStorage.setItem(
                    'mf:preload-error-reloaded-at',
                    String(Date.now())
                )
            )
            let failForm = true
            await broken.route('**/*', async (route) => {
                const url = new URL(route.request().url())
                if (url.origin !== origin) return route.abort()
                if (failForm && url.pathname === '/' + form.fileName)
                    return route.abort('failed')
                return route.continue()
            })
            const failedPage = await broken.newPage()
            await failedPage.goto(origin)
            await failedPage
                .getByRole('button', { name: 'Open sign in' })
                .click()
            await failedPage.getByRole('dialog').getByRole('alert').waitFor()
            failForm = false
            await Promise.all([
                failedPage.waitForEvent('load'),
                failedPage
                    .getByRole('button', { name: 'Reload page', exact: true })
                    .click()
            ])
            await failedPage
                .getByRole('button', { name: 'Open sign in' })
                .click()
            await failedPage
                .getByRole('dialog')
                .getByRole('textbox')
                .first()
                .waitFor()
            assert.equal(
                await failedPage
                    .getByRole('heading', { name: 'Owned page' })
                    .count(),
                1
            )
            await failedPage
                .getByRole('button', { name: 'Close', exact: true })
                .click()
            await failedPage.getByRole('dialog').waitFor({ state: 'detached' })
        } finally {
            await browser.close()
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            )
        }
    }
)
