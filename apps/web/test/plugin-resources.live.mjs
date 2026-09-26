/* global window, document, innerWidth */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { frameworkMcpSupport } from '@manyfold/shared'

const api = process.env.MF_PLUGIN_TEST_API_URL
const web = process.env.MF_PLUGIN_TEST_WEB_URL
const agentId = process.env.MF_PLUGIN_TEST_AGENT_ID
if (!api || !web || !agentId)
    throw new Error(
        'Set MF_PLUGIN_TEST_API_URL, MF_PLUGIN_TEST_WEB_URL, and MF_PLUGIN_TEST_AGENT_ID'
    )
for (const url of [api, web])
    assert.ok(
        ['localhost', '127.0.0.1'].includes(new URL(url).hostname),
        'local dev stacks only'
    )
const evidence = resolve(
    import.meta.dirname,
    '../../../.e2e-runs/plugin-resources'
)
await mkdir(evidence, { recursive: true })
const config = await mkdtemp(join(tmpdir(), 'mf-resources-live-'))
let token
const request = async (
    path,
    body,
    method = body === undefined ? 'GET' : 'POST'
) => {
    const response = await fetch(api + path, {
        method,
        headers: {
            ...(token ? { authorization: 'Bearer ' + token } : {}),
            ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok)
        throw new Error(method + ' ' + path + ': HTTP ' + response.status)
    return response.status === 204 ? null : response.json()
}
token = (
    await request('/auth/login', {
        email: process.env.MF_PLUGIN_TEST_EMAIL ?? 'admin@example.com',
        password: process.env.MF_PLUGIN_TEST_PASSWORD ?? 'manyfold-local-dev'
    })
).token
const grant = await request('/me/api-tokens', {
    name: 'resource-live-test',
    scopes: ['api.full'],
    expiresInDays: 1
})
const env = {
    ...process.env,
    MF_CONFIG_DIR: config,
    MF_PROFILE: 'resource-test'
}
for (const key of ['MF_API_TOKEN', 'MF_TOKEN', 'MF_AGENT_ID', 'MF_API_URL'])
    delete env[key]
const cli = (args, stdin) =>
    new Promise((resolveResult, reject) => {
        const child = spawn(
            process.env.MF_PLUGIN_TEST_CLI ?? 'mf',
            ['--profile', 'resource-test', '--api-url', api, ...args, '--json'],
            { env, stdio: ['pipe', 'pipe', 'pipe'] }
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
let browser
let channel
let skill
let install
let originalAgent
const suffix = Date.now().toString(36)
const filename = 'mf-resource-' + suffix + '.txt'
const checks = []
try {
    await cli(['login', '--token', '-'], grant.token)
    const targetAgent = await request('/agents/' + agentId)
    if (!['claude-code', 'codex'].includes(targetAgent.framework))
        throw new Error(
            'The resource test requires a disposable Claude Code or Codex agent'
        )
    originalAgent = targetAgent
    const mcpSupport = frameworkMcpSupport(originalAgent.framework)
    const mcpFixture = (name) =>
        mcpSupport.format === 'toml'
            ? `[mcp_servers.${name}]\ncommand = "true"\n`
            : JSON.stringify({ [name]: { command: 'true' } })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 }
    })
    await context.addInitScript(
        ({ token }) => {
            localStorage.setItem('mf_session', token)
            localStorage.setItem('nca.locale', 'en')
            const fetch = window.fetch.bind(window)
            let streamController
            window.disconnectResourceStream = () => streamController?.abort()
            window.fetch = (input, init = {}) => {
                const url = typeof input === 'string' ? input : input.url
                if (!url?.includes('/agents/sprite-status/stream'))
                    return fetch(input, init)
                streamController = new AbortController()
                return fetch(input, {
                    ...init,
                    signal: init.signal
                        ? AbortSignal.any([
                              init.signal,
                              streamController.signal
                          ])
                        : streamController.signal
                })
            }
        },
        { token }
    )
    const page = await context.newPage()
    const second = await context.newPage()
    const errors = []
    for (const tab of [page, second])
        tab.on('pageerror', (error) => errors.push(error.message))
    let documents = 0
    page.on('request', (request) => {
        if (
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame()
        )
            documents++
    })
    const visible = async (tab, text) =>
        tab
            .getByText(text, { exact: true })
            .filter({ visible: true })
            .first()
            .waitFor({ timeout: 15_000 })
    await page.goto(new URL('/settings/channels', web).toString())
    await second.goto(new URL('/settings/channels', web).toString())
    await page
        .getByRole('heading', { name: 'Channels', exact: true })
        .first()
        .waitFor()
    channel = await cli([
        'channels',
        'create',
        '--agent-id',
        agentId,
        '--provider',
        'fake',
        '--label',
        'Live channel ' + suffix,
        '--config',
        '{}'
    ])
    await visible(page, channel.label)
    await visible(second, channel.label)
    assert.equal(documents, 1)
    await page.goto(new URL('/settings/channels/' + channel.id, web).toString())
    await cli([
        'channels',
        'update',
        channel.id,
        '--label',
        'Renamed channel ' + suffix,
        '--status',
        'paused'
    ])
    await visible(page, 'Renamed channel ' + suffix)
    await visible(second, 'Renamed channel ' + suffix)
    await page.screenshot({
        path: join(evidence, 'channels-desktop.png'),
        fullPage: true
    })
    checks.push('channel-create-update-two-tabs')
    await page.goto(new URL('/skills/library', web).toString())
    skill = await cli([
        'skills',
        'library',
        'create',
        '--name',
        'live-' + suffix,
        '--content',
        '---\nname: live-' +
            suffix +
            '\ndescription: Resource synchronization test\n---\n\nA temporary local test skill.'
    ])
    await visible(page, skill.name)
    await cli([
        'skills',
        'library',
        'update',
        skill.id,
        '--description',
        'Updated library ' + suffix
    ])
    await visible(page, 'Updated library ' + suffix)
    checks.push('library-create-update')
    await page.goto(
        new URL('/agents/' + agentId + '/settings/skills', web).toString()
    )
    install = await cli([
        'skills',
        'install',
        '--agent-id',
        agentId,
        '--skill-id',
        skill.id
    ])
    await visible(page, skill.name)
    checks.push('skill-install')
    await page.goto(
        new URL('/agents/' + agentId + '/settings/overview', web).toString()
    )
    await cli(['agents', 'update', agentId, '--name', 'Live agent ' + suffix])
    await visible(page, 'Live agent ' + suffix)
    checks.push('agent-update')
    await page.goto(
        new URL('/agents/' + agentId + '/settings/mcp', web).toString()
    )
    await page
        .getByRole('button', { name: 'Edit', exact: true })
        .first()
        .click()
    const editor = page.locator('textarea').first()
    const draft = mcpFixture('unsaved-local-draft')
    await editor.fill(draft)
    const scope = mcpSupport.scopes[0].id
    const remoteMcp = {
        ...originalAgent.extras?.mcp,
        [scope]: mcpFixture('remote-tool')
    }
    await request('/agents/' + agentId, { mcp: remoteMcp }, 'PATCH')
    await visible(page, 'Live agent ' + suffix)
    await page.waitForTimeout(700)
    assert.equal(await editor.inputValue(), draft)
    checks.push('mcp-draft-preserved')
    await page.goto(new URL('/agents/' + agentId + '/chat', web).toString())
    await page
        .getByRole('button', { name: 'More actions', exact: true })
        .first()
        .click()
    await page.getByRole('menuitem', { name: 'Files', exact: true }).click()
    await cli([
        'files',
        'write',
        agentId,
        filename,
        '--content',
        'RESOURCE-FIRST-' + suffix
    ])
    const fileRow = page.locator('[data-item-path="' + filename + '"]')
    await fileRow.waitFor({ timeout: 15_000 })
    await fileRow.click()
    await page
        .getByText('RESOURCE-FIRST-' + suffix, { exact: false })
        .first()
        .waitFor({ timeout: 20_000 })
    await cli([
        'files',
        'write',
        agentId,
        filename,
        '--content',
        'RESOURCE-SECOND-' + suffix
    ])
    await page
        .getByText('RESOURCE-SECOND-' + suffix, { exact: false })
        .first()
        .waitFor({ timeout: 20_000 })
    checks.push('file-create-and-open-preview-update')
    await page.screenshot({
        path: join(evidence, 'files-desktop.png'),
        fullPage: true
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
        path: join(evidence, 'files-mobile.png'),
        fullPage: true
    })
    assert.equal(
        await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
        ),
        true
    )
    await context.setOffline(true)
    await second.evaluate(() => window.disconnectResourceStream())
    await cli([
        'channels',
        'update',
        channel.id,
        '--label',
        'Reconnected channel ' + suffix
    ])
    await context.setOffline(false)
    await visible(second, 'Reconnected channel ' + suffix)
    checks.push('settings-stream-reconnect')
    await cli(['channels', 'delete', channel.id])
    channel = null
    await second
        .getByText('Reconnected channel ' + suffix, { exact: true })
        .first()
        .waitFor({ state: 'detached', timeout: 15_000 })
    checks.push('channel-delete')
    assert.deepEqual(errors, [])
    await writeFile(
        join(evidence, 'result.json'),
        JSON.stringify({ ok: true, checks }, null, 2)
    )
    console.log(JSON.stringify({ ok: true, checks, evidence }))
} catch (error) {
    await browser
        ?.contexts()[0]
        ?.pages()[0]
        ?.screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
        .catch(() => {})
    throw error
} finally {
    if (originalAgent)
        await request(
            '/agents/' + agentId,
            { name: originalAgent.name, mcp: originalAgent.extras?.mcp ?? {} },
            'PATCH'
        ).catch((error) => console.error('Agent restore: ' + error.message))
    await cli(['files', 'rm', agentId, filename, '--yes']).catch(() => {})
    if (install)
        await cli(['skills', 'delete', install.id, '--yes']).catch(() => {})
    if (skill)
        await cli([
            'skills',
            'library',
            'delete',
            skill.id,
            '--force',
            '--yes'
        ]).catch(() => {})
    if (channel)
        await cli(['channels', 'delete', channel.id]).catch((error) =>
            console.error('Channel cleanup: ' + error.message)
        )
    await request(
        '/me/api-tokens/' + grant.summary.id,
        undefined,
        'DELETE'
    ).catch((error) => console.error('Token cleanup: ' + error.message))
    await browser?.close()
    await rm(config, { recursive: true, force: true })
}
