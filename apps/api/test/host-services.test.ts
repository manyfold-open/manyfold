import assert from 'node:assert/strict'
import test from 'node:test'
import { DAEMON_FEATURE_SERVICES } from '@manyfold/shared'
import { HostServices } from '../src/modules/agent-runtimes/provisioning/host-services'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'
import { BootstrapError } from '../src/modules/agents/bootstrap/framework-bootstrap'
import {
    serviceFrameworkRecipe,
    type ServiceHost
} from '../src/modules/agents/bootstrap/service-frameworks'
import { runtimeRow, spritesHostRow } from './helpers/runtime-context-fixture'

// A hosted machine's service frameworks run under its own daemon, a
// sandbox's and a cloud computer's alike (ADR-0035 §6): the API names the
// service, the host's daemon keeps it up, and on a sandbox the provider routes
// the public URL to the port the framework serves.

const SANDBOX = spritesHostRow({ id: 'sbx_1', userId: 'usr_1', homeDir: '/home/sprite' })
const HOST = { id: SANDBOX.id, userId: SANDBOX.userId }

interface Listed {
    name: string
    state: string
    healthy?: boolean | null
    lastExit?: string | null
}

const rig = (opts: { online?: boolean; listed?: Listed[] } = {}) => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
    const sessions: Array<Record<string, unknown>> = []
    const published: Array<number | null> = []
    const patches: Array<Record<string, unknown>> = []
    const events: Array<[string, unknown]> = []
    let listed: Listed[] = opts.listed ?? []
    const access = {
        withHost: async (
            args: Record<string, unknown>,
            work: (session: Record<string, unknown>) => Promise<unknown>
        ) => {
            sessions.push(args)
            if (opts.online === false)
                throw new HostDaemonOfflineError(args.host as never, 'runner_unavailable')
            return work({
                host: args.host,
                daemonId: (args.host as { id: string }).id,
                exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
                rpc: async (call: { method: string; payload: Record<string, unknown> }) => {
                    calls.push(call)
                    if (call.method === 'service.list') return { services: listed }
                    if (call.method === 'service.upsert') {
                        const name = (call.payload.spec as { name: string }).name
                        if (!listed.some((s) => s.name === name))
                            listed = [...listed, { name, state: 'stopped' }]
                    }
                    if (call.method === 'service.start')
                        listed = listed.map((s) =>
                            s.name === call.payload.name
                                ? { ...s, state: 'running', healthy: true }
                                : s
                        )
                    return {}
                }
            })
        }
    }
    const services = new HostServices(
        { findById: async () => SANDBOX } as never,
        access as never,
        {
            for: () => ({
                publishPort: async (_call: unknown, port: number | null) => {
                    published.push(port)
                }
            })
        } as never,
        { providerForHost: async () => ({ id: 'rtp_1', kind: 'sprites' }) } as never,
        {
            applyServiceReportPatch: async (_id: string, patch: Record<string, unknown>) => {
                patches.push(patch)
            }
        } as never,
        { get: () => 'https://api.example.test' } as never,
        { emit: (event: string, payload: unknown) => events.push([event, payload]) } as never
    )
    return {
        services,
        calls,
        sessions,
        published,
        patches,
        events,
        list: (next: Listed[]) => {
            listed = next
        },
        methods: () => calls.map((c) => `${c.method}${c.payload.name ? ` ${c.payload.name}` : ''}`)
    }
}

// The admission is what brings a daemon without services to one with them:
// a sandbox's is handed to its supervised loop, an older CLI updated.
test('services go to the host daemon, admitted with the services feature', async () => {
    const r = rig({ listed: [{ name: 'openclaw', state: 'running' }] })
    await r.services.restart(HOST, 'openclaw')
    assert.deepEqual(r.methods(), ['service.stop openclaw', 'service.start openclaw'])
    assert.deepEqual(r.sessions[0].requiredFeatures, [DAEMON_FEATURE_SERVICES])
    assert.equal(r.sessions[0].placement, 'sprites')

    const offline = rig({ online: false })
    await assert.rejects(offline.services.start(HOST, 'openclaw'), /sandbox sbx_1 has no connected daemon/)
})

test('a service is ready when it answers its health path, not when it runs', async () => {
    const r = rig({ listed: [{ name: 'hermes', state: 'running', healthy: true }] })
    await r.services.waitHealthy(HOST, 'hermes', 5_000)

    r.list([{ name: 'hermes', state: 'restarting', healthy: false, lastExit: 'exit 1' }])
    await assert.rejects(
        r.services.waitHealthy(HOST, 'hermes', 1),
        /did not become healthy \(restarting, last exit: exit 1\)/
    )
})

const HOME: ServiceHost = { home: '/home/sprite', suspends: true }

const recorder = () => {
    const scripts: Array<{ script: string; env?: Record<string, string> }> = []
    return {
        scripts,
        runner: {
            run: async (script: string, _timeoutMs: number, env?: Record<string, string>) => {
                scripts.push({ script, env })
                return { exitCode: 0, stdout: '', stderr: '' }
            },
            warn: () => {}
        }
    }
}

const configureArgs = (overrides: Record<string, unknown> = {}) => ({
    host: HOME,
    runtimeId: 'art_1',
    credentials: {},
    envText: null,
    controlUiEnabled: true,
    dashboardEnabled: false,
    apiBaseUrl: null,
    ...overrides
})

// Seen on local [2026-09-29]: a sprite bootstrap wrote openclaw.json and
// hermes's config.yaml 644, provider key included. Every host now gets the
// owner-only, base64-carried write the pods had.
test('the openclaw service writes its config owner-only under the host home and serves /healthz', async () => {
    const recipe = serviceFrameworkRecipe('openclaw')!
    const r = recorder()
    const setup = await recipe.configure(
        r.runner as never,
        configureArgs({
            credentials: {
                modelProvider: 'anthropic',
                baseUrl: 'https://models.example.test',
                apiKey: 'k-test',
                primaryModelName: 'model-x',
                gatewayToken: 'gw-kept'
            },
            envText: 'EXTRA=1',
            controlUiEnabled: false
        })
    )
    assert.deepEqual(setup.generatedCredentials, { gatewayToken: 'gw-kept' })
    assert.deepEqual(setup.spec.command, ['openclaw', 'gateway'])
    assert.equal(setup.spec.dir, '/home/sprite/.openclaw')
    assert.equal(setup.spec.healthPath, '/healthz')
    assert.equal(setup.spec.env.EXTRA, '1')
    assert.equal(setup.spec.env.OPENCLAW_CONFIG_PATH, '/home/sprite/.openclaw/openclaw.json')
    assert.equal(setup.publicPort, 18789)
    assert.deepEqual(setup.companions, [])
    assert.match(r.scripts[0].script, /umask 077/)
    assert.equal(r.scripts[0].script.includes('k-test'), false)
    assert.equal(recipe.sandbox.mountPath('/home/sprite'), '/home/sprite/.openclaw/workspace')
})

test('the hermes service keeps its API server key across setups', async () => {
    const recipe = serviceFrameworkRecipe('hermes')!
    const r = recorder()
    const creds = { primaryModelProvider: 'anthropic', primaryModelApiKey: 'k-test', primaryModelName: 'model-x' }
    const first = await recipe.configure(r.runner as never, configureArgs({ credentials: creds }))
    const key = first.generatedCredentials.apiServerKey
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.deepEqual(first.spec.command, ['/home/sprite/.hermes/hermes-agent/venv/bin/hermes', 'gateway'])
    assert.equal(first.spec.healthPath, '/v1/health')
    assert.equal(first.publicPort, 8642)
    assert.match(r.scripts[0].script, /umask 077/)
    assert.equal(r.scripts[0].script.includes('k-test'), false)

    const again = await recipe.configure(
        r.runner as never,
        configureArgs({ credentials: { ...creds, apiServerKey: key } })
    )
    assert.equal(again.generatedCredentials.apiServerKey, key)
    assert.equal(serviceFrameworkRecipe('claude-code'), undefined)
})

// The dashboard serves out of hermes's own checkout behind a front proxy that
// takes over the public port: /v1 to the gateway, the UI's HTML only to a
// tokened visit.
test('the hermes dashboard runs as two companions behind the public port', async () => {
    const recipe = serviceFrameworkRecipe('hermes')!
    const r = recorder()
    await assert.rejects(
        recipe.configure(r.runner as never, configureArgs({ dashboardEnabled: true })),
        (err: unknown) => err instanceof BootstrapError && /dashboardToken/.test(err.message)
    )
    const setup = await recipe.configure(
        r.runner as never,
        configureArgs({ dashboardEnabled: true, credentials: { dashboardToken: 'dash-1' } })
    )
    assert.equal(setup.publicPort, 18642)
    assert.deepEqual(setup.companions.map((c) => c.name), ['hermes-dashboard', 'hermes-proxy'])
    const [dashboard, proxy] = setup.companions
    assert.deepEqual(dashboard.command.slice(1), ['dashboard', '--no-open', '--skip-build', '--host', '127.0.0.1', '--port', '9119'])
    assert.equal(dashboard.env.API_SERVER_ENABLED, 'false')
    assert.equal(dashboard.env.HERMES_DASHBOARD_SESSION_TOKEN, 'dash-1')
    assert.deepEqual(proxy.command, ['node', '/home/sprite/.hermes/mf-front-proxy.mjs'])
    assert.equal(proxy.port, 18642)
    assert.equal(proxy.healthPath, '/v1/health')
    assert.equal(proxy.env.MF_DASHBOARD_TOKEN, 'dash-1')
    // The web UI is built for the checkout, and the proxy script lands in
    // the home through the step env, not the script text.
    assert.ok(r.scripts.some((s) => s.script.includes('npm run build')))
    const proxyStep = r.scripts.find((s) => s.env?.MF_HERMES_PROXY_B64)!
    assert.ok(proxyStep.script.includes('/home/sprite/.hermes/mf-front-proxy.mjs'))
    assert.equal(proxyStep.script.includes('createServer'), false)
})

test('applying a setup runs the main service healthy first, then its companions, then publishes', async () => {
    const recipe = serviceFrameworkRecipe('hermes')!
    const r = rig({ listed: [{ name: 'hermes', state: 'running', healthy: true }] })
    const setup = await recipe.configure(
        recorder().runner as never,
        configureArgs({ dashboardEnabled: true, credentials: { dashboardToken: 'dash-1' } })
    )
    await r.services.apply(HOST, recipe, setup, { restart: true })
    assert.deepEqual(
        r.methods().filter((m) => !m.startsWith('service.list')),
        [
            'service.upsert',
            'service.stop hermes',
            'service.start hermes',
            'service.upsert',
            'service.stop hermes-dashboard',
            'service.start hermes-dashboard',
            'service.upsert',
            'service.stop hermes-proxy',
            'service.start hermes-proxy'
        ]
    )
    assert.deepEqual(r.published, [18642])

    // Switched off, the companions go and the gateway takes the port back.
    const plain = await recipe.configure(recorder().runner as never, configureArgs())
    r.calls.length = 0
    await r.services.apply(HOST, recipe, plain, { restart: true })
    assert.deepEqual(
        r.methods().filter((m) => m.startsWith('service.delete')),
        ['service.delete hermes-dashboard', 'service.delete hermes-proxy']
    )
    assert.deepEqual(r.published, [18642, 8642])
})

test('a woken runtime starts only what a stop left stopped, and reports ready once healthy', async () => {
    const runtime = runtimeRow({ id: 'art_1', framework: 'hermes', hostId: 'sbx_1' })
    const r = rig({
        listed: [
            { name: 'hermes', state: 'stopped' },
            { name: 'something-else', state: 'stopped' }
        ]
    })
    assert.equal(await r.services.ensureRunning(runtime, SANDBOX), true)
    assert.deepEqual(r.methods().filter((m) => m.startsWith('service.start')), ['service.start hermes'])
    assert.deepEqual(r.patches[0].serviceStatus, 'starting')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(r.patches.at(-1)!.serviceStatus, 'ready')
    assert.deepEqual(r.events, [['runtime.service.ready', { runtimeId: 'art_1', framework: 'hermes' }]])

    const running = rig({ listed: [{ name: 'hermes', state: 'running', healthy: true }] })
    assert.equal(await running.services.ensureRunning(runtime, SANDBOX), false)
    assert.deepEqual(running.patches, [])
})

// A sandbox stop must never wake the machine it is putting to sleep.
test('a stop takes the companions down first, never wakes the machine, and records stopped', async () => {
    const runtime = runtimeRow({ id: 'art_1', framework: 'hermes', hostId: 'sbx_1' })
    const r = rig({
        listed: [
            { name: 'hermes', state: 'running' },
            { name: 'hermes-dashboard', state: 'running' },
            { name: 'hermes-proxy', state: 'running' }
        ]
    })
    await r.services.stopRuntime(runtime, SANDBOX)
    assert.equal(r.sessions[0].wake, false)
    assert.deepEqual(
        r.methods().filter((m) => m.startsWith('service.stop')),
        ['service.stop hermes-proxy', 'service.stop hermes-dashboard', 'service.stop hermes']
    )
    assert.equal(r.patches[0].serviceStatus, 'stopped')
})

// Seen on local [2026-09-29]: deleting a service runtime left its sprite
// service running. Its services and the public route go with it now.
test('a removed runtime takes its services and the public route with it', async () => {
    const runtime = runtimeRow({ id: 'art_1', framework: 'openclaw', hostId: 'sbx_1' })
    const r = rig({ listed: [{ name: 'openclaw', state: 'running' }] })
    await r.services.removeRuntime(runtime, SANDBOX)
    assert.deepEqual(r.methods().filter((m) => m.startsWith('service.delete')), ['service.delete openclaw'])
    assert.deepEqual(r.published, [null])
})

// An implicit npm latest that will not install is retried unpinned: the
// machine has no earlier install of the framework to fall back on.
test('an implicit latest npm install that fails is retried unpinned, and the version left unknown', async () => {
    const recipe = serviceFrameworkRecipe('openclaw')!
    const asked: Array<string | null | undefined> = []
    const fake = {
        ...recipe,
        install: async (_runner: unknown, request: { frameworkVersion?: string | null }) => {
            asked.push(request.frameworkVersion)
            if (request.frameworkVersion)
                throw new BootstrapError('openclaw-install-version', 'npm exploded')
            return '2026.9.1'
        }
    }
    const services = Object.create(HostServices.prototype) as {
        log: { warn: (m: string) => void }
        install(...args: unknown[]): Promise<string | null>
    }
    services.log = { warn: () => {} }
    const version = await services.install(fake, recorder().runner, HOME, {
        frameworkVersion: '2026.9.2',
        frameworkVersionSource: 'latest'
    })
    assert.deepEqual(asked, ['2026.9.2', null])
    assert.equal(version, null)

    asked.length = 0
    await assert.rejects(
        services.install(fake, recorder().runner, HOME, {
            frameworkVersion: '2026.9.2',
            frameworkVersionSource: 'explicit'
        }),
        /npm exploded/
    )
    assert.deepEqual(asked, ['2026.9.2'], 'an asked-for version fails loud')
})
