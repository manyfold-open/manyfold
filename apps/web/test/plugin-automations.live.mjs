import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { chromium } from 'playwright'

const api = process.env.MF_PLUGIN_TEST_API_URL
const agentId = process.env.MF_PLUGIN_TEST_AGENT_ID
if (!api || !agentId)
    throw new Error('Set MF_PLUGIN_TEST_API_URL and MF_PLUGIN_TEST_AGENT_ID')
assert.ok(
    ['localhost', '127.0.0.1'].includes(new URL(api).hostname),
    'live test only targets a local dev stack'
)
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.e2e-runs/plugin-automations')
await mkdir(evidence, { recursive: true })
const config = await mkdtemp(join(tmpdir(), 'mf-plugin-live-'))
let sessionToken
const request = async (
    path,
    body,
    method = body === undefined ? 'GET' : 'POST'
) => {
    const response = await fetch(api + path, {
        method,
        headers: {
            ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            ...(sessionToken ? { authorization: 'Bearer ' + sessionToken } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok)
        throw new Error(method + ' ' + path + ': HTTP ' + response.status)
    return response.status === 204 ? null : response.json()
}
sessionToken = (
    await request('/auth/login', {
        email: process.env.MF_PLUGIN_TEST_EMAIL ?? 'admin@example.com',
        password: process.env.MF_PLUGIN_TEST_PASSWORD ?? 'manyfold-local-dev'
    })
).token
const grant = await request('/me/api-tokens', {
    name: 'plugin-live-test',
    scopes: ['api.full'],
    expiresInDays: 1
})
const cliEnv = {
    ...process.env,
    MF_CONFIG_DIR: config,
    MF_PROFILE: 'plugin-test'
}
for (const key of ['MF_API_TOKEN', 'MF_TOKEN', 'MF_AGENT_ID', 'MF_API_URL'])
    delete cliEnv[key]
const cli = (args, stdin) =>
    new Promise((resolveResult, reject) => {
        const child = spawn(
            process.execPath,
            [
                resolve(root, 'apps/cli/dist/index.js'),
                '--profile',
                'plugin-test',
                '--api-url',
                api,
                ...args,
                '--json'
            ],
            { env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'] }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (data) => {
            stdout += data
        })
        child.stderr.on('data', (data) => {
            stderr += data
        })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code !== 0)
                return reject(new Error('mf ' + args[0] + ' failed: ' + stderr))
            try {
                resolveResult(JSON.parse(stdout))
            } catch (error) {
                reject(error)
            }
        })
        child.stdin.end(stdin)
    })
const until = async (condition, timeout = 15_000) => {
    const deadline = Date.now() + timeout
    while (!(await condition())) {
        if (Date.now() > deadline)
            throw new Error('live browser condition timed out')
        await wait(100)
    }
}
let browser
let automation
try {
    browser = await chromium.launch({ headless: true })
    await cli(['login', '--token', '-'], grant.token)
    const listLink = await cli(['ui', 'resolve', 'automation'])
    const web = new URL(listLink.url).origin
    assert.ok(['localhost', '127.0.0.1'].includes(new URL(web).hostname))
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 }
    })
    await context.addInitScript(
        ({ token }) => {
            localStorage.setItem('mf_session', token)
            localStorage.setItem('nca.locale', 'en')
            const originalFetch = window.fetch.bind(window)
            const controllers = new Set()
            window.disconnectResourceStream = () => {
                for (const controller of controllers) controller.abort()
            }
            window.fetch = (input, init = {}) => {
                const url = typeof input === 'string' ? input : input.url
                if (!url?.includes('/agents/sprite-status/stream'))
                    return originalFetch(input, init)
                const controller = new AbortController()
                controllers.add(controller)
                controller.signal.addEventListener('abort', () =>
                    controllers.delete(controller)
                )
                return originalFetch(input, {
                    ...init,
                    signal: init.signal
                        ? AbortSignal.any([init.signal, controller.signal])
                        : controller.signal
                })
            }
        },
        { token: sessionToken }
    )
    const page = await context.newPage()
    const second = await context.newPage()
    let resourceConnections = 0
    second.on('response', (response) => {
        if (response.url().includes('/agents/sprite-status/stream'))
            resourceConnections++
    })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    second.on('pageerror', (error) => errors.push(error.message))
    let documents = 0
    page.on('request', (req) => {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame())
            documents++
    })
    await page.goto(listLink.url)
    await second.goto(listLink.url)
    await page
        .getByRole('heading', { name: 'Automations', exact: true })
        .waitFor()
    await second
        .getByRole('heading', { name: 'Automations', exact: true })
        .waitFor()
    const suffix = Date.now().toString(36)
    const initialTitle = 'Plugin live ' + suffix
    const createdAt = Date.now()
    automation = await cli([
        'automations',
        'create',
        '--agent-id',
        agentId,
        '--title',
        initialTitle,
        '--prompt',
        'Reply with exactly MANYFOLDPLUGINRUNOK. Do not use tools.',
        '--schedule-preset',
        'daily',
        '--rrule',
        'FREQ=DAILY;BYHOUR=23;BYMINUTE=59;BYSECOND=0',
        '--timezone',
        'UTC',
        ...(process.env.MF_PLUGIN_TEST_MODEL
            ? ['--model', process.env.MF_PLUGIN_TEST_MODEL]
            : [])
    ])
    await page
        .getByText(initialTitle, { exact: true })
        .waitFor({ timeout: 10_000 })
    await second
        .getByText(initialTitle, { exact: true })
        .waitFor({ timeout: 10_000 })
    const createVisibleMs = Date.now() - createdAt
    assert.equal(
        documents,
        1,
        'CLI creation did not navigate or reload the page'
    )
    const title = 'Plugin verified ' + suffix
    await cli([
        'automations',
        'update',
        automation.id,
        '--title',
        title,
        '--status',
        'paused'
    ])
    await page.getByText(title, { exact: true }).waitFor({ timeout: 10_000 })
    await second.getByText(title, { exact: true }).waitFor({ timeout: 10_000 })
    const detailLink = await cli(['ui', 'resolve', 'automation', automation.id])
    await page.goto(detailLink.url)
    const titleInput = page.getByRole('textbox', { name: 'Title', exact: true })
    await until(
        async () => (await titleInput.inputValue().catch(() => '')) === title
    )
    await titleInput.fill('Unsaved user draft')
    await cli([
        'automations',
        'update',
        automation.id,
        '--title',
        title + ' external'
    ])
    await page
        .getByText(title + ' external', { exact: true })
        .waitFor({ timeout: 10_000 })
    assert.equal(
        await titleInput.inputValue(),
        'Unsaved user draft',
        'external changes preserve unsaved input'
    )
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await until(
        async () => (await titleInput.inputValue()) === title + ' external'
    )
    const detailDocuments = documents
    const run = await cli(['automations', 'run', automation.id])
    console.log(
        JSON.stringify({
            phase: 'run-submitted',
            automationId: automation.id,
            runId: run.id,
            createVisibleMs
        })
    )
    let completed
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
        const detail = await cli(['automations', 'get', automation.id])
        completed = detail.runs.find((entry) => entry.id === run.id)
        if (completed && completed.status !== 'running') break
        await wait(1500)
    }
    if (completed?.status === 'failed') {
        await page
            .getByText('Failed', { exact: true })
            .first()
            .waitFor({ timeout: 10_000 })
        await page.screenshot({
            path: join(evidence, 'failed-run.png'),
            fullPage: true
        })
    }
    assert.equal(
        completed?.status,
        'succeeded',
        completed?.errorMessage ?? 'run did not finish'
    )
    assert.match(completed.resultPreview ?? '', /MANYFOLDPLUGINRUNOK/)
    await page
        .getByText('MANYFOLDPLUGINRUNOK', { exact: true })
        .first()
        .waitFor({ timeout: 10_000 })
    assert.equal(
        documents,
        detailDocuments,
        'run completion did not reload the detail page'
    )
    await page.screenshot({
        path: join(evidence, 'desktop.png'),
        fullPage: true
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
        path: join(evidence, 'mobile.png'),
        fullPage: true
    })
    assert.equal(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
        ),
        true
    )
    const runLink = await cli([
        'ui',
        'resolve',
        'automation',
        automation.id,
        '--run-id',
        run.id
    ])
    assert.equal(
        new URL(runLink.url).searchParams.get('sessionId'),
        completed.chatSessionId
    )
    await page.goto(runLink.url)
    await page
        .getByText('MANYFOLDPLUGINRUNOK', { exact: true })
        .first()
        .waitFor({ timeout: 30_000 })
    await page.screenshot({
        path: join(evidence, 'conversation.png'),
        fullPage: true
    })
    await context.setOffline(true)
    const connectionsBefore = resourceConnections
    await second.evaluate(() => window.disconnectResourceStream())
    await cli([
        'automations',
        'update',
        automation.id,
        '--title',
        title + ' reconnected'
    ])
    await context.setOffline(false)
    await second.bringToFront()
    await until(async () => resourceConnections > connectionsBefore)
    await second
        .getByText(title + ' reconnected', { exact: true })
        .waitFor({ timeout: 20_000 })
    await cli(['automations', 'delete', automation.id, '--yes'])
    await until(
        async () =>
            (await second
                .getByText(title + ' reconnected', { exact: true })
                .count()) === 0
    )
    assert.deepEqual(errors, [])
    const result = {
        ok: true,
        agentId,
        automationId: automation.id,
        runId: run.id,
        createVisibleMs,
        runStatus: completed.status,
        resultPreview: completed.resultPreview,
        checks: [
            'create',
            'update',
            'two-tabs',
            'unsaved-draft',
            'real-run',
            'run-link',
            'desktop-mobile',
            'reconnect',
            'delete'
        ],
        screenshots: evidence
    }
    await writeFile(
        join(evidence, 'result.json'),
        JSON.stringify(result, null, 2)
    )
    console.log(JSON.stringify(result))
} catch (error) {
    const page = browser?.contexts()[0]?.pages()[0]
    await page
        ?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
        .catch(() => {})
    console.error(error)
    throw error
} finally {
    if (automation)
        await cli(['automations', 'delete', automation.id, '--yes']).catch(
            () => {}
        )
    await request(
        '/me/api-tokens/' + grant.summary.id,
        undefined,
        'DELETE'
    ).catch((error) => console.error('Test token cleanup: ' + error.message))
    await browser?.close()
    await rm(config, { recursive: true, force: true })
}
