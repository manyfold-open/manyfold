import assert from 'node:assert/strict'
import test from 'node:test'
import { SpritesError, type ServiceObject } from '@manyfold/sprites'
import { SpritesProvider } from '../src/modules/hosts/providers/sprites.provider'

// A sprite's own service supervisor is what starts the daemon again after
// the sprite's environment restarts, and a service holding an http_port is
// what routes its public URL. Measured on a real sprite: a PUT on an existing
// service keeps its old definition, and a delete kills everything the service
// runs, so a definition is only recreated when it changed.

const host = {
    id: 'sbx_1',
    kind: 'hosted',
    generation: 3,
    providerRef: { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sp-1' }
}
const provider = { id: 'rtp_1', kind: 'sprites', name: 'org' }

const LOOP = {
    name: 'mf-daemon',
    command: ['bash', '-lc', 'while :; do mf daemon start; done'],
    env: { MF_PROFILE: 'spriterunner', MF_DAEMON_SUPERVISOR: 'container' }
}

const stored = (
    name: string,
    def: Partial<ServiceObject>,
    status = 'running'
): ServiceObject =>
    ({
        name,
        cmd: 'bash',
        args: [],
        needs: [],
        ...def,
        state: { name, status }
    }) as ServiceObject

const build = (opts: { services?: ServiceObject[]; url?: string } = {}) => {
    const services = new Map((opts.services ?? []).map((s) => [s.name, s]))
    const calls: string[] = []
    const refs: unknown[] = []
    const client = {
        getService: async (_sprite: string, name: string) => {
            const found = services.get(name)
            if (!found) throw new SpritesError('not_found', `no service ${name}`, 404)
            return found
        },
        deleteService: async (_sprite: string, name: string) => {
            calls.push(`delete ${name}`)
            services.delete(name)
        },
        upsertService: async (_sprite: string, name: string, def: Partial<ServiceObject>) => {
            calls.push(`put ${name}`)
            if (!services.has(name)) services.set(name, stored(name, def, 'stopped'))
            return services.get(name)
        },
        startService: async (_sprite: string, name: string) => {
            calls.push(`start ${name}`)
            return services.get(name)
        },
        updateSprite: async (_sprite: string, patch: unknown) => {
            calls.push(`update ${JSON.stringify(patch)}`)
        },
        getSprite: async () => ({ id: 'sp-1', name: 'sbx-1', status: 'running', url: opts.url })
    }
    const adapter = new SpritesProvider(
        { register: () => {} } as never,
        {
            findById: async () => host,
            setProviderRef: async (_id: string, ref: unknown) => {
                refs.push(ref)
            }
        } as never,
        {
            spritesClientForProvider: () => client,
            spritesLoggerFor: () => ({ debug() {}, info() {}, warn() {}, error() {} })
        } as never
    )
    return { adapter, calls, refs, services }
}

const call = { host: host as never, provider: provider as never, generation: 3 }

test('a daemon with no service gets one, started', async () => {
    const h = build()
    await h.adapter.superviseDaemon(call, LOOP)
    assert.deepEqual(h.calls, ['put mf-daemon', 'start mf-daemon'])
    const def = h.services.get('mf-daemon')!
    assert.equal(def.cmd, 'bash')
    assert.deepEqual(def.args, ['-lc', LOOP.command[2]])
    assert.deepEqual(def.env, LOOP.env)
})

// A delete would take down the daemon and every framework service under it.
test('an unchanged, running daemon service is left alone', async () => {
    const h = build({
        services: [stored('mf-daemon', { args: ['-lc', LOOP.command[2]], env: { ...LOOP.env } })]
    })
    await h.adapter.superviseDaemon(call, LOOP)
    assert.deepEqual(h.calls, [])
})

test('an unchanged daemon service that is not running is started', async () => {
    const h = build({
        services: [stored('mf-daemon', { args: ['-lc', LOOP.command[2]], env: { ...LOOP.env } }, 'failed')]
    })
    await h.adapter.superviseDaemon(call, LOOP)
    assert.deepEqual(h.calls, ['start mf-daemon'])
})

test('a changed definition is deleted and put again, since a PUT keeps the old one', async () => {
    const h = build({
        services: [stored('mf-daemon', { args: ['-lc', 'exec mf daemon start'], env: { ...LOOP.env } })]
    })
    await h.adapter.superviseDaemon(call, LOOP)
    assert.deepEqual(h.calls, ['delete mf-daemon', 'put mf-daemon', 'start mf-daemon'])
})

test('a stale generation is refused before any service call', async () => {
    const h = build()
    await assert.rejects(h.adapter.superviseDaemon({ ...call, generation: 2 }, LOOP), /stale/)
    assert.deepEqual(h.calls, [])
})

test('publishing a port puts the stub, opens the URL and records the URL the sprite reports', async () => {
    const h = build({ url: 'https://sbx-1-bqqlb.sprites.app' })
    await h.adapter.publishPort(call, 8642)
    assert.deepEqual(h.calls, [
        'put mf-port',
        'start mf-port',
        'update {"url_settings":{"auth":"public"}}'
    ])
    const stub = h.services.get('mf-port')!
    assert.equal(stub.cmd, 'sleep')
    assert.deepEqual(stub.args, ['infinity'])
    assert.equal(stub.http_port, 8642)
    assert.deepEqual(h.refs, [
        { kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sp-1', url: 'https://sbx-1-bqqlb.sprites.app' }
    ])
})

// One http_port holder per sprite, and a PUT keeps the old port: a move (the
// hermes dashboard's proxy taking the route) is a delete and a PUT.
test('moving the published port recreates the stub', async () => {
    const h = build({
        services: [stored('mf-port', { cmd: 'sleep', args: ['infinity'], http_port: 8642 })],
        url: 'https://sbx-1-bqqlb.sprites.app'
    })
    await h.adapter.publishPort(call, 18642)
    assert.deepEqual(h.calls.slice(0, 3), ['delete mf-port', 'put mf-port', 'start mf-port'])
    assert.equal(h.services.get('mf-port')!.http_port, 18642)
})

test('withdrawing the port deletes the stub, and a missing one is fine', async () => {
    const h = build({
        services: [stored('mf-port', { cmd: 'sleep', args: ['infinity'], http_port: 8642 })]
    })
    await h.adapter.publishPort(call, null)
    await h.adapter.publishPort(call, null)
    assert.deepEqual(h.calls, ['delete mf-port', 'delete mf-port'])
})

// The hostname carries the organisation's suffix: https://<name>.sprites.app
// answers 500 (measured on local [2026-09-29]).
test('the public URL is the one the sprite reported, never derived from its name', () => {
    const h = build()
    const url = (ref: Record<string, unknown>) =>
        h.adapter.publicUrl({
            host: { ...host, providerRef: ref } as never,
            provider: provider as never,
            framework: 'hermes',
            port: 8642
        })
    assert.equal(url({ kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sp-1' }), null)
    assert.equal(
        url({ kind: 'sprites', spriteName: 'sbx-1', spriteId: 'sp-1', url: 'https://sbx-1-bqqlb.sprites.app' }),
        'https://sbx-1-bqqlb.sprites.app'
    )
})

const userServices = (
    client: Record<string, unknown>
): SpritesProvider =>
    new SpritesProvider(
        { register: () => {} } as never,
        {} as never,
        {
            spritesClientForProvider: () => client,
            spritesLoggerFor: () => ({ debug() {}, info() {}, warn() {}, error() {} })
        } as never
    )

const userCall = { host: host as never, provider: provider as never }

// Measured on local [2026-09-28]: the listing answers a bare array.
test('the service listing reads a bare array and the typed envelope alike', async () => {
    const bare = userServices({
        listServices: async () => [stored('http.server', { cmd: 'python3', args: ['-m', 'http.server'], http_port: 8000 })]
    })
    const wrapped = userServices({
        listServices: async () => ({ services: [stored('idle', {}, 'stopped')] })
    })

    assert.deepEqual(await bare.listServices(userCall), [
        {
            name: 'http.server',
            command: 'python3 -m http.server',
            httpPort: 8000,
            status: 'running',
            pid: null,
            startedAt: null,
            error: null
        }
    ])
    assert.deepEqual(
        (await wrapped.listServices(userCall)).map((s) => [s.name, s.status]),
        [['idle', 'stopped']]
    )
})

test('removing or stopping a service already gone is done', async () => {
    const gone = async () => {
        throw new SpritesError('not_found', 'gone', 404)
    }
    const adapter = userServices({ deleteService: gone, stopService: gone })

    await adapter.removeService(userCall, 'gone')
    assert.equal(await adapter.stopService(userCall, 'gone'), true)
})

// WHY: the supervisor refuses to stop a service another one `needs` and says
// so only through the state it answers with.
test('a stop the supervisor refused reads as not stopped', async () => {
    const adapter = userServices({
        stopService: async (_sprite: string, name: string) =>
            stored(name, {}, name === 'needed' ? 'running' : 'stopped')
    })

    assert.equal(await adapter.stopService(userCall, 'needed'), false)
    assert.equal(await adapter.stopService(userCall, 'free'), true)
})

// A sprite made before the policy went wide open may still deny everything by
// default; a github download on it needs the domains allowed.
test('egress repairs a deny-by-default policy with the missing domains', async () => {
    let written: { rules: Array<{ domain: string; action: string }> } | null = null
    const adapter = userServices({
        getNetworkPolicy: async () => ({
            rules: [
                { domain: '*', action: 'deny' },
                { domain: 'github.com', action: 'allow' }
            ]
        }),
        setNetworkPolicy: async (_sprite: string, policy: typeof written) => {
            written = policy
        }
    })

    await adapter.allowEgress(userCall, ['github.com', 'codeload.github.com'])

    assert.deepEqual(written, {
        rules: [
            { domain: '*', action: 'deny' },
            { domain: 'github.com', action: 'allow' },
            { domain: 'codeload.github.com', action: 'allow' }
        ]
    })
})

test('egress leaves an open policy alone', async () => {
    let wrote = false
    const adapter = userServices({
        getNetworkPolicy: async () => ({ rules: [] }),
        setNetworkPolicy: async () => {
            wrote = true
        }
    })

    await adapter.allowEgress(userCall, ['codeload.github.com'])

    assert.equal(wrote, false)
})
