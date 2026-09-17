import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { before } from 'node:test'
import { chromium, type Page } from 'playwright'
import { build } from 'vite'
import type { SdkAgent } from '@manyfold/sdk'
import type { AgentStorageUsageResponse } from '@manyfold/shared'

const root = resolve(import.meta.dirname, '../../..')
const origin = 'http://settings.test'
const assets = new Map<string, { contentType: string; body: string | Buffer }>()
let entry = ''
let styles = ''
before(async () => {
    const output = await build({
        configFile: false,
        envDir: false,
        root: resolve(root, 'apps/web'),
        logLevel: 'silent',
        define: {
            'import.meta.env.VITE_API_URL': JSON.stringify('/api'),
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
                input: resolve(
                    import.meta.dirname,
                    'agent-settings-fixture.tsx'
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
                contentType: css
                    ? 'text/css'
                    : path.endsWith('.svg')
                      ? 'image/svg+xml'
                      : 'application/octet-stream',
                body:
                    typeof item.source === 'string'
                        ? item.source
                        : Buffer.from(item.source)
            })
        }
    }
    assert.ok(entry)
})

const agent = (id: string, runtime: SdkAgent['runtime']): SdkAgent =>
    ({
        id,
        name: `${id} agent`,
        framework: 'codex',
        runtime,
        runtimeId: runtime === 'external' ? null : `runtime-${id}`,
        status: 'running',
        createdAt: '2026-09-01T00:00:00.000Z',
        workspacePath: '/workspace',
        channels: [],
        enabledTools: []
    }) as unknown as SdkAgent

const model = (id: string) => ({
    agentId: id,
    framework: 'codex',
    source: 'platform',
    availableSources: ['platform', 'runtime-local'],
    provider: 'openai',
    providerBaseUrl: null,
    providerModelsStatus: 'ready',
    providerModelsSource: 'test',
    providerModels: ['gpt-5'],
    runtimeLocal: null,
    runtimeAuth: { profileId: null, profile: null, bindingVersion: 0 },
    config: {
        framework: 'codex',
        model: `${id}-model`,
        speed: 'standard',
        intelligence: 'high'
    },
    options: [],
    validation: { valid: true }
})
const credentials = {
    framework: 'codex',
    provider: 'openai',
    apiKeyMasked: 'fixture-masked',
    baseUrl: null,
    savedProvider: null,
    extras: {},
    updatedAt: '2026-09-01T00:00:00Z'
}
const storageUsage = (
    agentId: string,
    totalBytes: number
): AgentStorageUsageResponse => ({
    scope: 'agent-paths',
    unit: 'bytes',
    agentId,
    checkedAt: '2026-09-01T00:00:00Z',
    asleep: false,
    items: [],
    totalBytes,
    cachedSandbox: null
})

const barrier = () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
        release = resolve
    })
    return { wait, release }
}
const renderSettled = async (page: Page) => {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve())
                )
            )
    )
}

const fixture = async (agents: Record<string, SdkAgent>) => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const calls: Array<{ path: string; method: string }> = []
    const blocked: string[] = []
    const errors: string[] = []
    const holds = new Map<string, ReturnType<typeof barrier>>()
    const responses = new Map<string, { status?: number; body: unknown }>()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.origin !== origin) {
            blocked.push(url.origin)
            return route.abort()
        }
        if (!url.pathname.startsWith('/api/')) {
            const asset = assets.get(url.pathname)
            return route.fulfill(
                asset ?? {
                    contentType: 'text/html',
                    body: `<!doctype html><html lang="en" data-theme="light"><head>${styles}</head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`
                }
            )
        }
        const path = url.pathname + url.search
        calls.push({ path, method: request.method() })
        const configured = responses.get(path)
        await holds.get(path)?.wait
        const id = url.pathname.split('/')[3]
        let body: unknown = configured?.body
        if (!configured) {
            if (path === '/api/auth/config') body = { configured: false }
            else if (url.pathname === `/api/agents/${id}`) body = agents[id]
            else if (path.endsWith('/model-config')) body = model(id)
            else if (path.endsWith('/credentials')) body = credentials
            else if (path.endsWith('/storage-usage'))
                body = storageUsage(id, 1024)
            else if (
                path === '/api/channels' ||
                path.startsWith('/api/backups')
            )
                body = []
            else if (path.includes('/a2a/')) body = { enabled: false }
            else if (path.includes('/skills')) body = []
            else body = {}
        }
        await route.fulfill({
            status: configured?.status ?? 200,
            contentType: 'application/json',
            body: JSON.stringify(body)
        })
    })
    const special = () =>
        calls.filter((call) =>
            /\/(?:model-config|credentials|storage-usage|backups|restores)(?:[/?]|$)/.test(
                call.path
            )
        )
    return {
        page,
        calls,
        holds,
        responses,
        special,
        close: async () => {
            for (const hold of holds.values()) hold.release()
            await browser.close()
            assert.deepEqual(errors, [])
            assert.deepEqual(blocked, [])
        }
    }
}

for (const path of [
    '/agents/external/settings/model',
    '/agents/external/settings/storage',
    '/agents/external?tab=model-provider',
    '/agents/external?tab=backups',
    '/agents/external?tab=model-provider&configureModel=1'
]) {
    test(`unsupported request boundary before and after agent resolution: ${path}`, async () => {
        const f = await fixture({ external: agent('external', 'external') })
        try {
            const hold = barrier()
            f.holds.set('/api/agents/external', hold)
            await f.page.goto(origin + path)
            await f.page.waitForFunction(() =>
                Boolean(document.querySelector('[aria-busy="true"]'))
            )
            await renderSettled(f.page)
            assert.deepEqual(f.special(), [], 'capability is still unknown')
            hold.release()
            await f.page.locator('.workbench-note').waitFor()
            await renderSettled(f.page)
            assert.deepEqual(
                f.special(),
                [],
                'unsupported capability stays query-free'
            )
            assert.equal(await f.page.getByRole('dialog').count(), 0)
        } finally {
            await f.close()
        }
    })
}

for (const runtime of ['daemon', 'sprites'] as const) {
    for (const section of ['overview', 'model', 'storage']) {
        test(`${runtime} ${section} loads only its supported dependencies`, async () => {
            const f = await fixture({ supported: agent('supported', runtime) })
            try {
                await f.page.goto(
                    `${origin}/agents/supported/settings/${section}`
                )
                await f.page.locator('.settings-sidebar').first().waitFor()
                await renderSettled(f.page)
                const paths = f.special().map((call) => call.path)
                for (const suffix of ['/model-config', '/credentials'])
                    assert.equal(
                        paths.some((path) => path.endsWith(suffix)),
                        section !== 'storage'
                    )
                assert.equal(
                    paths.some((path) => path.endsWith('/storage-usage')),
                    section !== 'model'
                )
                assert.equal(
                    paths.some((path) => path.startsWith('/api/backups')),
                    section === 'storage'
                )
            } finally {
                await f.close()
            }
        })
    }
}

test('A to B navigation waits for B capability', async () => {
    const f = await fixture({
        a: agent('a', 'daemon'),
        b: agent('b', 'external')
    })
    try {
        await f.page.goto(origin + '/agents/a/settings/storage')
        await f.page.locator('.settings-sidebar').first().waitFor()
        const hold = barrier()
        f.holds.set('/api/agents/b', hold)
        f.calls.length = 0
        await f.page.evaluate(() =>
            window.settingsNavigate('/agents/b/settings/storage')
        )
        await renderSettled(f.page)
        assert.deepEqual(
            f.special(),
            [],
            'A capability must not authorize requests for B'
        )
        assert.equal(
            await f.page
                .getByRole('button', { name: 'Create backup', exact: true })
                .count(),
            0
        )
        hold.release()
        await f.page.locator('.workbench-note').waitFor()
        await renderSettled(f.page)
        assert.deepEqual(f.special(), [])
    } finally {
        await f.close()
    }
})

test('late A model and credential responses cannot replace B state', async () => {
    const f = await fixture({
        a: agent('a', 'daemon'),
        b: agent('b', 'sprites')
    })
    try {
        const hold = barrier()
        f.holds.set('/api/agents/a/model-config', hold)
        f.holds.set('/api/agents/a/credentials', hold)
        await f.page.goto(origin + '/agents/a/settings/model')
        await f.page.locator('.settings-sidebar').first().waitFor()
        await f.page.evaluate(() =>
            window.settingsNavigate('/agents/b/settings/model')
        )
        await f.page.getByText('b-model', { exact: false }).first().waitFor()
        hold.release()
        await renderSettled(f.page)
        assert.equal(
            await f.page.getByText('a-model', { exact: false }).count(),
            0
        )
        assert.ok(await f.page.getByText('b-model', { exact: false }).count())
    } finally {
        await f.close()
    }
})

test('quick section changes discard older storage responses and preserve refresh error retry', async () => {
    const f = await fixture({ a: agent('a', 'daemon') })
    try {
        const hold = barrier()
        f.holds.set('/api/agents/a/storage-usage', hold)
        f.responses.set('/api/agents/a/storage-usage', {
            body: storageUsage('a', 1024)
        })
        await f.page.goto(origin + '/agents/a/settings/storage')
        await f.page.locator('.settings-sidebar').first().waitFor()
        await renderSettled(f.page)
        await f.page.evaluate(() =>
            window.settingsNavigate('/agents/a/settings/model')
        )
        await f.page.getByText('a-model', { exact: false }).first().waitFor()
        f.holds.delete('/api/agents/a/storage-usage')
        f.responses.set('/api/agents/a/storage-usage', {
            status: 503,
            body: { error: { message: 'measurement fixture failed' } }
        })
        await f.page.evaluate(() =>
            window.settingsNavigate('/agents/a/settings/storage')
        )
        await f.page
            .getByText('measurement fixture failed', { exact: false })
            .waitFor()
        hold.release()
        await renderSettled(f.page)
        assert.equal(
            await f.page.getByText('1.0 KiB', { exact: true }).count(),
            0
        )
        f.responses.set('/api/agents/a/storage-usage', {
            body: storageUsage('a', 2048)
        })
        await f.page
            .getByRole('button', { name: 'Refresh', exact: true })
            .click()
        await f.page.getByText('2.0 KiB', { exact: true }).waitFor()
        assert.equal(
            await f.page
                .getByText('measurement fixture failed', { exact: false })
                .count(),
            0
        )
    } finally {
        await f.close()
    }
})

const backup = (id: string, status = 'succeeded') => ({
    id,
    status,
    sourceAgentId: 'a',
    sourceAgentName: 'a agent',
    framework: 'codex',
    runtimeKind: 'daemon',
    archiveBytes: 1024,
    workspaceBytes: 2048,
    fileCount: 1,
    errorMessage: null,
    createdAt: '2026-09-01T00:00:00Z'
})

test('leaving Storage while confirmation is pending blocks the mutation', async () => {
    const f = await fixture({ a: agent('a', 'daemon') })
    try {
        f.responses.set('/api/backups?agentId=a', {
            body: [backup('original')]
        })
        await f.page.goto(origin + '/agents/a/settings/storage')
        await f.page
            .getByRole('button', { name: 'Restore backup', exact: true })
            .click()
        await f.page.getByRole('dialog').waitFor()
        await f.page.evaluate(() =>
            window.settingsNavigate('/agents/a/settings/model')
        )
        await f.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Restore', exact: true })
            .click()
        await renderSettled(f.page)
        assert.deepEqual(
            f.calls.filter(
                (call) => call.method !== 'GET' && call.path.includes('backups')
            ),
            []
        )
    } finally {
        await f.close()
    }
})

test('accepted A restore completes its safety snapshot sequence for A after navigating to unsupported B', async () => {
    const f = await fixture({
        a: agent('a', 'daemon'),
        b: agent('b', 'external')
    })
    try {
        await f.page.clock.install()
        f.responses.set('/api/backups?agentId=a', {
            body: [backup('original')]
        })
        const hold = barrier()
        f.holds.set('/api/agents/a/backups', hold)
        f.responses.set('/api/agents/a/backups', {
            body: { backup: backup('safety', 'running') }
        })
        f.responses.set('/api/agents/a/restores', {
            body: { id: 'restore-a', status: 'succeeded' }
        })
        await f.page.goto(origin + '/agents/a/settings/storage')
        await f.page
            .getByRole('button', { name: 'Restore backup', exact: true })
            .click()
        const created = f.page.waitForRequest((request) =>
            request.url().endsWith('/api/agents/a/backups')
        )
        await f.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Restore', exact: true })
            .click()
        await created
        await f.page.evaluate(() =>
            window.settingsNavigate('/agents/b/settings/storage')
        )
        await f.page.locator('.workbench-note').waitFor()
        f.responses.set('/api/backups?agentId=a', {
            body: [backup('original'), backup('safety')]
        })
        const snapshotResponse = f.page.waitForResponse((response) =>
            response.url().endsWith('/api/agents/a/backups')
        )
        hold.release()
        await snapshotResponse
        assert.equal(
            f.calls.some((call) => call.path.includes('/restores')),
            false
        )
        const restored = f.page.waitForResponse((response) =>
            response.url().endsWith('/api/agents/a/restores')
        )
        await f.page.clock.runFor(2500)
        await restored
        assert.deepEqual(
            f
                .special()
                .filter(
                    (call) =>
                        call.path.includes('/b/') ||
                        call.path.includes('agentId=b')
                ),
            []
        )
        assert.equal(
            f.calls.filter((call) => call.path === '/api/agents/a/restores')
                .length,
            1
        )
        assert.equal(await f.page.getByRole('dialog').count(), 0)
    } finally {
        await f.close()
    }
})

for (const [alias, section] of [
    ['model-provider', 'model'],
    ['backups', 'storage'],
    ['configuration', 'overview'],
    ['runtime', 'overview']
]) {
    test(`supported permanent alias ${alias} remains ${section}`, async () => {
        const f = await fixture({ a: agent('a', 'sprites') })
        try {
            await f.page.goto(`${origin}/agents/a?tab=${alias}`)
            await f.page.waitForURL(`${origin}/agents/a/settings/${section}`)
            await f.page.locator('.settings-sidebar').first().waitFor()
            await renderSettled(f.page)
            assert.ok(f.special().length > 0)
        } finally {
            await f.close()
        }
    })
}

test('mobile rail navigation preserves the same request boundary', async () => {
    const f = await fixture({
        a: agent('a', 'daemon'),
        b: agent('b', 'external')
    })
    try {
        await f.page.setViewportSize({ width: 390, height: 844 })
        await f.page.goto(origin + '/agents/a/settings/overview')
        await f.page.getByText('1.0 KiB', { exact: false }).first().waitFor()
        await renderSettled(f.page)
        f.calls.length = 0
        await f.page.locator('.settings-mobile-menu-btn').click()
        await f.page
            .getByRole('button', { name: 'Storage & backups', exact: true })
            .click()
        await f.page
            .getByRole('button', { name: 'Create backup', exact: true })
            .waitFor()
        await renderSettled(f.page)
        assert.ok(
            f.special().some((call) => call.path.startsWith('/api/backups'))
        )
        assert.equal(
            f.special().some((call) => call.path.endsWith('/credentials')),
            false
        )
        await f.page.evaluate(() =>
            window.settingsNavigate('/agents/b/settings/model')
        )
        await f.page.locator('.workbench-note').waitFor()
        f.calls.length = 0
        await f.page.locator('.settings-mobile-menu-btn').click()
        assert.equal(
            await f.page
                .getByRole('button', { name: 'Model', exact: true })
                .count(),
            0
        )
        await f.page
            .getByRole('button', { name: 'Overview', exact: true })
            .click()
        await renderSettled(f.page)
        assert.deepEqual(f.special(), [])
    } finally {
        await f.close()
    }
})

test('desktop and mobile retain existing precondition and supported overview layout', async () => {
    const directory = process.env.SETTINGS_SCREENSHOT_DIR
    if (!directory) return
    await mkdir(directory, { recursive: true })
    const f = await fixture({
        external: agent('external', 'external'),
        supported: agent('supported', 'daemon')
    })
    try {
        for (const [name, width, height] of [
            ['desktop', 1365, 900],
            ['mobile', 390, 844]
        ] as const) {
            await f.page.setViewportSize({ width, height })
            for (const theme of ['light', 'dark']) {
                for (const [id, section] of [
                    ['external', 'model'],
                    ['supported', 'overview']
                ]) {
                    await f.page.goto(
                        `${origin}/agents/${id}/settings/${section}`
                    )
                    await f.page.locator('.settings-shell').waitFor()
                    await renderSettled(f.page)
                    await f.page.evaluate(
                        (value) =>
                            (document.documentElement.dataset.theme = value),
                        theme
                    )
                    await f.page.screenshot({
                        path: resolve(directory, `${name}-${theme}-${id}.png`),
                        fullPage: true
                    })
                    assert.ok(
                        await f.page.evaluate(
                            () =>
                                document.documentElement.scrollWidth <=
                                innerWidth
                        )
                    )
                }
            }
        }
    } finally {
        await f.close()
    }
})
