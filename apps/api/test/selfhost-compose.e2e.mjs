import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { apiPaths, createObjectId } from '@manyfold/shared'

assert.equal(
    process.env.RUN_SELFHOST_E2E,
    '1',
    'opt in with RUN_SELFHOST_E2E=1; creates and removes an isolated local Docker stack'
)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const directory = await mkdtemp(join(tmpdir(), 'manyfold-selfhost-upgrade-'))
const reportDirectory = process.argv[2]
    ? resolve(process.argv[2])
    : join(directory, 'report')
await mkdir(reportDirectory, { recursive: true })
const project = 'mf-selfhost-' + randomBytes(5).toString('hex')
const images = ['api', 'web', 'admin'].map((app) => project + '-' + app)
const report = { project, cases: [], cleaned: false }
let sequence = 0
const run = (binary, args, { input, env = process.env, log = true } = {}) =>
    new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            cwd: root,
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        })
        const stdout = []
        const stderr = []
        child.stdout.on('data', (chunk) => stdout.push(chunk))
        child.stderr.on('data', (chunk) => stderr.push(chunk))
        child.on('error', reject)
        child.on('close', async (code) => {
            const out = Buffer.concat(stdout).toString()
            const err = Buffer.concat(stderr).toString()
            if (log)
                await writeFile(
                    join(reportDirectory, `command-${++sequence}.log`),
                    out + err
                )
            if (code === 0) resolve(out)
            else
                reject(
                    new Error(
                        `${binary} ${args.slice(0, 3).join(' ')} exited ${code}: ${err.slice(-3000)}`
                    )
                )
        })
        child.stdin.end(input)
    })
const freePort = async () => {
    const server = createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    return port
}
const [apiPort, webPort, adminPort] = [
    await freePort(),
    await freePort(),
    await freePort()
]
assert.equal(new Set([apiPort, webPort, adminPort]).size, 3)
const api = `http://127.0.0.1:${apiPort}/api`
const web = `http://127.0.0.1:${webPort}`
const admin = `http://127.0.0.1:${adminPort}`
const setupToken = randomBytes(24).toString('hex')
const env = {
    ...process.env,
    MF_API_CRYPTO_KEY: randomBytes(32).toString('base64'),
    MF_AUTH_SETUP_TOKEN: setupToken,
    MF_SELFHOST_API_PORT: String(apiPort),
    MF_SELFHOST_WEB_PORT: String(webPort),
    MF_SELFHOST_ADMIN_PORT: String(adminPort),
    MF_SELFHOST_API_URL: api,
    MF_SELFHOST_PUBLIC_API_URL: new URL(api).origin,
    MF_SELFHOST_WEB_URL: web,
    MF_SELFHOST_ADMIN_URL: admin,
    MF_SELFHOST_CORS_ORIGIN: '',
    MF_SELFHOST_DEFAULT_PLAN_ID: 'self_hosted',
    MF_SELFHOST_PG_PASSWORD: randomBytes(24).toString('hex')
}
const composeArgs = (file) => [
    'compose',
    '--env-file',
    '/dev/null',
    '-p',
    project,
    '-f',
    file
]
const compose = (file, args, options) =>
    run('docker', [...composeArgs(file), ...args], options)
const resolveCompose = async (source, variables = env) =>
    JSON.parse(
        await run(
            'docker',
            [
                'compose',
                '--env-file',
                '/dev/null',
                '--project-directory',
                root,
                '-p',
                project,
                '-f',
                source,
                'config',
                '--format',
                'json'
            ],
            { env: variables, log: false }
        )
    )
const candidate = await resolveCompose(
    join(root, 'docker-compose.selfhost.yml')
)
assert.equal(candidate.services.api.environment.CORS_ORIGIN, web + ',' + admin)
const publicOrigins = await resolveCompose(
    join(root, 'docker-compose.selfhost.yml'),
    {
        ...env,
        MF_SELFHOST_WEB_URL: 'https://app.example.test',
        MF_SELFHOST_ADMIN_URL: 'https://admin.example.test'
    }
)
assert.equal(
    publicOrigins.services.api.environment.CORS_ORIGIN,
    'https://app.example.test,https://admin.example.test'
)
const customOrigins = await resolveCompose(
    join(root, 'docker-compose.selfhost.yml'),
    { ...env, MF_SELFHOST_CORS_ORIGIN: 'https://extra.example.test' }
)
assert.equal(
    customOrigins.services.api.environment.CORS_ORIGIN,
    'https://extra.example.test'
)
report.cases.push(
    'Compose resolves local, custom-domain and explicit CORS allowlists'
)

const configureImages = (config) => {
    for (const [index, app] of ['api', 'web', 'admin'].entries())
        config.services[app].image = images[index]
    config.services['api-migrate'].image = images[0]
    for (const service of Object.values(config.services)) {
        if (service.build) service.build.context = root
        for (const port of service.ports ?? []) port.host_ip = '127.0.0.1'
    }
}
configureImages(candidate)
const candidateFile = join(directory, 'candidate.json')
await writeFile(candidateFile, JSON.stringify(candidate), { mode: 0o600 })
const fixtureBytes = Buffer.from(
    'self-host upload survives an API container replacement\n'
)
let browser
let stackStarted = false
const request = async (path, options = {}) => {
    const response = await fetch(api + path, options)
    const text = await response.text()
    assert.ok(
        response.ok,
        `${path}: HTTP ${response.status}: ${text.slice(0, 400)}`
    )
    return text ? JSON.parse(text) : null
}
const waitHealthy = async () => {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
        try {
            if ((await fetch(api + '/health')).ok) return
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('isolated API did not become healthy')
}
const preflight = async (origin, allowed) => {
    const response = await fetch(api + '/auth/me', {
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization'
        }
    })
    assert.equal(
        response.headers.get('access-control-allow-origin'),
        allowed ? origin : null
    )
    if (allowed)
        assert.equal(
            response.headers.get('access-control-allow-credentials'),
            'true'
        )
}
try {
    console.log(
        JSON.stringify({
            project,
            stage: 'building exact candidate images',
            reportDirectory
        })
    )
    for (const service of ['api', 'web', 'admin']) {
        console.log('build ' + service)
        await compose(candidateFile, ['build', service])
    }
    stackStarted = true
    await compose(candidateFile, [
        'up',
        '-d',
        '--no-build',
        '--wait',
        '--wait-timeout',
        '180'
    ])
    await waitHealthy()
    await preflight(web, true)
    await preflight(admin, true)
    await preflight('https://unlisted.example.test', false)
    report.cases.push(
        'real API permits configured Web/Admin and denies an unlisted Origin'
    )
    const session = await request('/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            setupToken,
            adminEmail: 'selfhost-fixture@example.test',
            adminPassword: 'Fixture-' + randomBytes(16).toString('hex'),
            initialAdminEmails: [],
            passwordEnabled: true,
            emailVerificationRequired: false,
            googleEnabled: false,
            oidcEnabled: false,
            netmindEnabled: false
        })
    })
    assert.ok(session.token && session.user.id)
    const headers = { Authorization: 'Bearer ' + session.token }
    const access = await request('/me/runtime-access', { headers })
    assert.equal(access.plan.id, 'self_hosted')
    assert.equal(access.plan.monthlyApiRequestLimit, null)
    assert.equal(access.plan.priceUsdMonthly, undefined)

    // A DB fixture avoids invoking any external Dify service. The actual
    // authenticated upload controller and container storage still execute.
    const agentId = createObjectId('agent')
    const runtimeId = createObjectId('agentRuntime')
    await compose(
        candidateFile,
        [
            'exec',
            '-T',
            'postgres',
            'psql',
            '-U',
            'postgres',
            '-d',
            'manyfold',
            '-v',
            'ON_ERROR_STOP=1',
            '-v',
            'uid=' + session.user.id,
            '-v',
            'rid=' + runtimeId,
            '-v',
            'aid=' + agentId
        ],
        {
            input: `
            INSERT INTO agent_runtimes (id,user_id,name,framework,kind,status)
            VALUES (:'rid',:'uid','Upload fixture','dify','external','stopped');
            INSERT INTO agents (id,user_id,name,framework,runtime,status,runtime_id,internal_id)
            VALUES (:'aid',:'uid','Upload fixture','dify','external','stopped',:'rid','fixture');
        `
        }
    )
    const data = new FormData()
    data.set(
        'file',
        new Blob([fixtureBytes], { type: 'text/plain' }),
        'fixture.txt'
    )
    const upload = await request('/agents/' + agentId + '/chat-uploads', {
        method: 'POST',
        headers,
        body: data
    })
    const probe = async () =>
        JSON.parse(
            await compose(
                candidateFile,
                [
                    'exec',
                    '-T',
                    'api',
                    'node',
                    '-e',
                    `
        require('tsconfig-paths').register({baseUrl:process.cwd()+'/dist',paths:{'@/*':['*']}})
        const {ChatUploadStorageService}=require('./dist/modules/chat/uploads/chat-upload-storage.service')
        const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'))
        const storage=new ChatUploadStorageService({get:key=>process.env[key]})
        ;(async()=>{
            const meta=await storage.stat(input.id,input.userId,input.agentId)
            const chunks=[]
            if(meta)for await(const chunk of await storage.read(input.id,input.userId,input.agentId))chunks.push(chunk)
            console.log(JSON.stringify({meta,bytes:Buffer.concat(chunks).toString('base64')}))
        })().catch(error=>{console.error(error);process.exitCode=1})
    `
                ],
                {
                    input: JSON.stringify({
                        id: upload.id,
                        userId: session.user.id,
                        agentId
                    })
                }
            )
        )
    const before = await probe()
    assert.equal(before.bytes, fixtureBytes.toString('base64'))
    assert.equal(before.meta.name, 'fixture.txt')
    const oldContainer = (
        await compose(candidateFile, ['ps', '-q', 'api'])
    ).trim()
    await compose(candidateFile, [
        'up',
        '-d',
        '--no-build',
        '--no-deps',
        '--force-recreate',
        'api'
    ])
    await waitHealthy()
    assert.notEqual(
        (await compose(candidateFile, ['ps', '-q', 'api'])).trim(),
        oldContainer
    )
    assert.deepEqual(await probe(), before)
    report.cases.push(
        'authenticated upload survives actual API container replacement with identical stat/read bytes and metadata'
    )

    candidate.services.api.environment.CORS_ORIGIN =
        publicOrigins.services.api.environment.CORS_ORIGIN
    await writeFile(candidateFile, JSON.stringify(candidate), { mode: 0o600 })
    await compose(candidateFile, [
        'up',
        '-d',
        '--no-build',
        '--no-deps',
        '--force-recreate',
        'api'
    ])
    await waitHealthy()
    await preflight('https://app.example.test', true)
    await preflight('https://admin.example.test', true)
    await preflight(web, false)
    report.cases.push(
        'real API follows the custom-domain allowlist after configuration change'
    )
    candidate.services.api.environment.CORS_ORIGIN = web + ',' + admin
    await writeFile(candidateFile, JSON.stringify(candidate), { mode: 0o600 })
    await compose(candidateFile, [
        'up',
        '-d',
        '--no-build',
        '--no-deps',
        '--force-recreate',
        'api'
    ])
    await waitHealthy()
    assert.deepEqual(await probe(), before)

    browser = await chromium.launch({ headless: true })
    const corePaths = new Set(
        Object.values(apiPaths).filter((path) => typeof path === 'string')
    )
    const forbidden = []
    const pageErrors = []
    for (const viewport of [
        { width: 1440, height: 1050 },
        { width: 390, height: 844 }
    ]) {
        for (const colorScheme of ['light', 'dark']) {
            const context = await browser.newContext({ viewport, colorScheme })
            try {
                await context.addInitScript((token) => {
                    localStorage.setItem('mf_session', token)
                    localStorage.setItem('nca.web.language', 'en')
                }, session.token)
                const page = await context.newPage()
                page.on('pageerror', (error) => pageErrors.push(error.message))
                page.on('request', (req) => {
                    const url = new URL(req.url())
                    if (
                        url.origin === new URL(api).origin &&
                        !corePaths.has(url.pathname.replace(/^\/api/, ''))
                    )
                        forbidden.push(url.pathname)
                })
                await page.goto(web + '/settings/plan-and-billing')
                await page.waitForURL(web + '/settings/usage')
                const panel = page.getByTestId('selfhost-resource-usage')
                await panel
                    .getByText('Current plan: Self-hosted', { exact: true })
                    .waitFor()
                assert.equal(await panel.locator('dt').count(), 11)
                assert.ok(
                    (await panel
                        .getByText('Unlimited', { exact: false })
                        .count()) > 0
                )
                for (const role of ['link', 'button'])
                    assert.equal(
                        await page
                            .getByRole(role, {
                                name: /Manage billing|Upgrade plan|checkout|Rent a cloud computer/i
                            })
                            .count(),
                        0
                    )
                assert.ok(
                    await page.evaluate(
                        () =>
                            globalThis.document.documentElement.scrollWidth <=
                            globalThis.innerWidth + 1
                    )
                )
                await page.screenshot({
                    path: join(
                        reportDirectory,
                        `usage-${viewport.width}-${colorScheme}.png`
                    ),
                    fullPage: true
                })
                if (viewport.width === 1440 && colorScheme === 'light') {
                    await page.route('**/api/me/runtime-access', (route) =>
                        route.fulfill({
                            status: 503,
                            contentType: 'application/json',
                            body: JSON.stringify({
                                ok: false,
                                error: {
                                    code: 'internal_error',
                                    message: 'fixture retry'
                                }
                            })
                        })
                    )
                    await page.reload()
                    await panel
                        .getByRole('button', { name: 'Retry', exact: true })
                        .waitFor()
                    await page.unroute('**/api/me/runtime-access')
                    await panel
                        .getByRole('button', { name: 'Retry', exact: true })
                        .click()
                    await panel
                        .getByText('Current plan: Self-hosted', { exact: true })
                        .waitFor()
                }
            } finally {
                await context.close()
            }
        }
    }
    assert.deepEqual(forbidden, [])
    assert.deepEqual(pageErrors, [])
    report.cases.push(
        'real self-host UI shows quotas, redirects the old billing URL, retries errors and has no commerce requests/actions or viewport overflow'
    )
    report.pass = true
} finally {
    await browser?.close()
    if (stackStarted) {
        await compose(candidateFile, ['down', '--volumes', '--remove-orphans'])
        const remaining = (
            await run('docker', [
                'ps',
                '-aq',
                '--filter',
                'label=com.docker.compose.project=' + project
            ])
        ).trim()
        assert.equal(remaining, '')
        const volumes = (
            await run('docker', [
                'volume',
                'ls',
                '-q',
                '--filter',
                'label=com.docker.compose.project=' + project
            ])
        ).trim()
        assert.equal(volumes, '')
        report.cleaned = true
    }
    await writeFile(
        join(reportDirectory, 'result.json'),
        JSON.stringify(report, null, 2)
    )
    await rm(candidateFile, { force: true })
}
console.log(JSON.stringify({ ...report, reportDirectory }))
