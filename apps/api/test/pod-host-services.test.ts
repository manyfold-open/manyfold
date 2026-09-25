import assert from 'node:assert/strict'
import test from 'node:test'
import { DAEMON_FEATURE_SERVICES } from '@manyfold/shared'
import { PodHostServices } from '../src/modules/agent-runtimes/provisioning/pod-host-services'
import { podServiceRecipe } from '../src/modules/agent-runtimes/provisioning/pod-service-frameworks'

// A cloud computer's service frameworks run under its own daemon (ADR-0035
// §6): the API names the service, the host's daemon keeps it up.

const HOST = { id: 'pdh_1', userId: 'usr_1' }

const servicesWith = (runner: { id: string; clientFeatures: string[] } | null) => {
    const calls: Array<{ daemonId: string; method: string; payload: unknown }> = []
    let listed: unknown[] = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => (runner ? [runner] : []) })
            })
        })
    }
    const registry = {
        rpc: async (req: { daemonId: string; method: string; payload: unknown }) => {
            calls.push(req)
            return req.method === 'service.list' ? { services: listed } : {}
        }
    }
    return {
        services: new PodHostServices(db as never, registry as never),
        calls,
        list: (services: unknown[]) => {
            listed = services
        }
    }
}

test('services go to the host daemon, which has to advertise them', async () => {
    const rig = servicesWith({ id: 'dh_pod', clientFeatures: [DAEMON_FEATURE_SERVICES] })
    await rig.services.restart(HOST, 'openclaw')
    assert.deepEqual(
        rig.calls.map((c) => [c.daemonId, c.method, c.payload]),
        [
            ['dh_pod', 'service.stop', { name: 'openclaw' }],
            ['dh_pod', 'service.start', { name: 'openclaw' }]
        ]
    )

    const old = servicesWith({ id: 'dh_pod', clientFeatures: [] })
    await assert.rejects(old.services.start(HOST, 'openclaw'), (err: { response?: { code?: string } }) =>
        err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    // Callers about to install a service framework ask first.
    await assert.rejects(old.services.ready(HOST), (err: { response?: { code?: string } }) =>
        err.response?.code === 'POD_HOST_DAEMON_TOO_OLD'
    )
    assert.deepEqual(old.calls, [])
    await rig.services.ready(HOST)

    const none = servicesWith(null)
    await assert.rejects(none.services.start(HOST, 'openclaw'), /has no registered daemon/)
})

test('a host whose CLI predates services has it updated first', async () => {
    const reads = [
        [{ id: 'dh_old', clientFeatures: [] }],
        [{ id: 'pdh_1', userId: 'usr_1', kind: 'pod' }]
    ]
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({ limit: async () => reads.shift() ?? [] })
            })
        })
    }
    const ensured: unknown[] = []
    const cli = {
        ensure: async (podHost: { id: string }, runner: { id: string }, need: unknown) => {
            ensured.push([podHost.id, runner.id, need])
            return { id: 'dh_new', clientFeatures: [DAEMON_FEATURE_SERVICES] }
        }
    }
    const calls: unknown[] = []
    const registry = {
        rpc: async (req: { daemonId: string; method: string }) => {
            calls.push([req.daemonId, req.method])
            return {}
        }
    }
    const services = new PodHostServices(db as never, registry as never, cli as never)
    await services.start(HOST, 'openclaw')
    assert.deepEqual(ensured, [['pdh_1', 'dh_old', { feature: DAEMON_FEATURE_SERVICES }]])
    assert.deepEqual(calls, [['dh_new', 'service.start']])
})

test('a service is ready when it answers its health path, not when it runs', async () => {
    const rig = servicesWith({ id: 'dh_pod', clientFeatures: [DAEMON_FEATURE_SERVICES] })
    rig.list([{ name: 'hermes', state: 'running', healthy: true, pid: 7, restarts: 0, lastExit: null, startedAt: null }])
    await rig.services.waitHealthy(HOST, 'hermes', 5_000)

    rig.list([{ name: 'hermes', state: 'restarting', healthy: false, pid: null, restarts: 3, lastExit: 'exit 1', startedAt: null }])
    await assert.rejects(
        rig.services.waitHealthy(HOST, 'hermes', 1),
        /did not become healthy \(restarting, last exit: exit 1\)/
    )
})

test('the openclaw service writes its config owner-only and serves /healthz', async () => {
    const recipe = podServiceRecipe('openclaw')!
    const scripts: string[] = []
    const runner = {
        run: async (script: string) => {
            scripts.push(script)
            return { exitCode: 0, stdout: '', stderr: '' }
        }
    }
    const setup = await recipe.configure(runner as never, {
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
    assert.deepEqual(setup.generatedCredentials, { gatewayToken: 'gw-kept' })
    assert.deepEqual(setup.spec.command, ['openclaw', 'gateway'])
    assert.equal(setup.spec.healthPath, '/healthz')
    assert.equal(setup.spec.env.EXTRA, '1')
    assert.equal(setup.spec.env.OPENCLAW_CONFIG_PATH, `${recipe.home}/openclaw.json`)
    // The config holds the provider key: written under umask 077, as base64
    // so no content can end the script.
    assert.match(scripts[0], /umask 077/)
    assert.equal(scripts[0].includes('k-test'), false)
})

test('the hermes service keeps its API server key across setups', async () => {
    const recipe = podServiceRecipe('hermes')!
    const runner = { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }
    const first = await recipe.configure(runner as never, {
        credentials: { primaryModelProvider: 'anthropic', primaryModelApiKey: 'k-test', primaryModelName: 'model-x' },
        envText: null,
        controlUiEnabled: false
    })
    const key = first.generatedCredentials.apiServerKey
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.equal(first.spec.command[1], 'gateway')
    assert.equal(first.spec.healthPath, '/v1/health')

    const again = await recipe.configure(runner as never, {
        credentials: {
            primaryModelProvider: 'anthropic',
            primaryModelApiKey: 'k-test',
            primaryModelName: 'model-x',
            apiServerKey: key
        },
        envText: null,
        controlUiEnabled: false
    })
    assert.equal(again.generatedCredentials.apiServerKey, key)
    assert.equal(podServiceRecipe('claude-code'), undefined)
})
