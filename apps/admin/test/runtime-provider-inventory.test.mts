import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { before } from 'node:test'
import { chromium } from 'playwright'
import { build } from 'vite'
import type {
    ProviderMachineList,
    ProviderMachineSummary,
    RuntimeProviderSummary
} from '@manyfold/shared'

// A provider's inventory and one machine on it, against a fake API: the
// account as listed (tiles, the incomplete warning, filters), and the
// type-to-confirm delete held to its keyboard and focus rules.

const root = resolve(import.meta.dirname, '../../..')
const origin = 'http://admin-inventory.test'
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
                    'runtime-provider-inventory-fixture.tsx'
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

const at = '2026-10-19T10:00:00.000Z'
const provider: RuntimeProviderSummary = {
    id: 'rtp_fixture',
    kind: 'sprites',
    name: 'fixture-org',
    status: 'enabled',
    priority: 0,
    region: null,
    config: {},
    lastHealthStatus: 'ok',
    lastHealthMessage: null,
    lastHealthCheckedAt: null,
    hostCount: 1,
    capabilities: {
        inventory: true,
        restartMachine: true,
        upgradeMachine: true
    },
    createdAt: at,
    updatedAt: at
}

const machine = (
    name: string,
    extra: Partial<ProviderMachineSummary> = {}
): ProviderMachineSummary => ({
    name,
    id: `sprite-${name}`,
    status: 'cold',
    power: 'stopped',
    version: '0.0.1-rc44',
    environmentVersion: null,
    labels: [],
    url: null,
    urlAuth: 'sprite',
    urlPrivateAccess: 'admins',
    createdAt: at,
    updatedAt: at,
    lastRunningAt: null,
    host: null,
    ...extra
})

const machines = [
    machine('sbx-tracked', {
        host: {
            id: 'sbx_tracked',
            name: 'research',
            status: 'ready',
            userId: 'usr_fixture',
            ownerEmail: 'owner@fixture.invalid',
            agentsCount: 1,
            providerId: 'rtp_fixture',
            providerName: 'fixture-org'
        }
    }),
    machine('sbx-orphan', { status: 'running', power: 'running' }),
    machine('handmade-box')
]

const listing: ProviderMachineList = {
    providerId: 'rtp_fixture',
    sharedWith: [{ id: 'rtp_twin', name: 'fixture-twin' }],
    complete: false,
    listedAt: at,
    capacity: {
        running: 1,
        suspended: 0,
        stopped: 2,
        runningLimit: 20,
        suspendedLimit: 20
    },
    machines
}

for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
]) {
    test(`an inventory lists the account and a delete asks for the machine's name at ${viewport.width}px`, async () => {
        const browser = await chromium.launch({ headless: true })
        const page = await browser.newPage({ viewport })
        const unexpected: string[] = []
        const errors: string[] = []
        const deletes: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('**/*', async (route) => {
            const request = route.request()
            const url = new URL(request.url())
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
            const base = '/api/admin/runtime-providers/rtp_fixture'
            const path = url.pathname
            if (request.method() === 'DELETE') {
                deletes.push(path)
                // Refused once, so the dialog has to keep the reason in view.
                if (deletes.length === 1)
                    return route.fulfill({
                        status: 409,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            ok: false,
                            error: {
                                code: 'PROVIDER_MACHINE_ACTION_REFUSED',
                                message: 'fixture refusal'
                            }
                        })
                    })
                return route.fulfill({ status: 204, body: '' })
            }
            let body: unknown
            if (path === '/api/auth/config') body = { configured: false }
            else if (path === base) body = provider
            else if (path === `${base}/machines`) body = listing
            else if (path.endsWith('/actions')) body = []
            else if (path.startsWith(`${base}/machines/`)) {
                const name = decodeURIComponent(path.split('/').pop() ?? '')
                body = machines.find((m) => m.name === name)
            }
            if (body === undefined) {
                unexpected.push(`${request.method()} ${path}`)
                return route.abort()
            }
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify(body)
            })
        })
        try {
            await page.goto(
                `${origin}/infrastructure/runtime-providers/rtp_fixture/inventory`
            )
            await page.getByRole('table').waitFor()
            assert.equal(
                await page.locator('tbody tr').count(),
                3,
                'every machine is listed'
            )
            assert.equal(
                await page
                    .getByText('1 tracked · 2 untracked', { exact: true })
                    .count(),
                1,
                'the tile splits tracked from untracked'
            )
            assert.equal(
                await page.getByText(/stopped listing before the end/).count(),
                1,
                'a cut-short listing says so'
            )
            assert.equal(
                await page.getByText(/fixture-twin/).count(),
                1,
                'the other row on the account is named'
            )

            await page.getByLabel('Tracking').selectOption('untracked')
            assert.equal(
                await page.locator('tbody tr').count(),
                2,
                'untracked filter'
            )
            await page.getByLabel('Tracking').selectOption('all')
            await page.getByLabel('Search').fill('owner@fixture')
            assert.equal(
                await page.locator('tbody tr').count(),
                1,
                'search by owner'
            )
            await page.getByLabel('Search').fill('')

            // A sandbox with agents on it cannot be deleted from here.
            await page
                .getByRole('link', { name: 'sbx-tracked', exact: true })
                .click()
            // The heading comes from the URL; this section waits for the data.
            await page
                .getByText('In this deployment', { exact: true })
                .waitFor()
            assert.equal(
                await page
                    .getByRole('button', { name: 'Delete', exact: true })
                    .isDisabled(),
                true
            )
            await page.goBack()
            await page.getByRole('table').waitFor()

            await page
                .getByRole('link', { name: 'sbx-orphan', exact: true })
                .click()
            await page
                .getByText('In this deployment', { exact: true })
                .waitFor()
            assert.equal(
                await page
                    .getByText(/ran in the last 24 hours/)
                    .filter({ visible: true })
                    .count(),
                1,
                'a running untracked machine is flagged'
            )

            const trigger = page.getByRole('button', {
                name: 'Delete',
                exact: true
            })
            await trigger.click()
            const dialog = page.getByRole('dialog', {
                name: 'Delete sbx-orphan?'
            })
            await dialog.waitFor()
            assert.equal(
                await page.evaluate(() => document.activeElement?.tagName),
                'INPUT'
            )
            await page.keyboard.type('sbx-orpha')
            await page.keyboard.press('Enter')
            assert.equal(
                deletes.length,
                0,
                'a name that does not match sends nothing'
            )
            assert.equal(
                await dialog
                    .getByRole('button', { name: 'Delete', exact: true })
                    .isDisabled(),
                true
            )
            for (let i = 0; i < 8; i++)
                await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab')
            assert.equal(
                await page.evaluate(
                    () => !!document.activeElement?.closest('dialog')
                ),
                true,
                'focus stays inside the dialog'
            )
            await page.mouse.click(5, 5)
            assert.equal(
                await dialog.isVisible(),
                true,
                'the backdrop does not dismiss it'
            )
            await page.keyboard.press('Escape')
            await dialog.waitFor({ state: 'hidden' })
            assert.equal(
                await page.evaluate(() => document.activeElement?.textContent),
                'Delete',
                'focus returns to what opened it'
            )

            await trigger.click()
            await dialog.waitFor()
            await page.keyboard.type('sbx-orphan')
            await page.keyboard.press('Enter')
            await dialog.getByRole('alert').waitFor()
            assert.match(
                await dialog.getByRole('alert').innerText(),
                /fixture refusal/
            )
            assert.equal(deletes.length, 1)

            await page.keyboard.press('Enter')
            await page.waitForURL(/\/inventory$/)
            assert.deepEqual(deletes, [
                '/api/admin/runtime-providers/rtp_fixture/machines/sbx-orphan',
                '/api/admin/runtime-providers/rtp_fixture/machines/sbx-orphan'
            ])
            assert.equal(
                await page.evaluate(
                    () =>
                        document.documentElement.scrollWidth > window.innerWidth
                ),
                false,
                'the page itself never scrolls sideways'
            )
            if (process.env.ADMIN_INVENTORY_SCREENSHOT_DIR) {
                await mkdir(process.env.ADMIN_INVENTORY_SCREENSHOT_DIR, {
                    recursive: true
                })
                await page.screenshot({
                    path: resolve(
                        process.env.ADMIN_INVENTORY_SCREENSHOT_DIR,
                        `inventory-${viewport.width}.png`
                    ),
                    fullPage: true
                })
            }
        } finally {
            await browser.close()
        }
        assert.deepEqual(errors, [])
        assert.deepEqual(unexpected, [])
    })
}
