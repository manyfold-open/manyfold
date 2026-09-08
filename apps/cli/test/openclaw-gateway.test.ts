import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

// BYOD openclaw gateway discovery (ADR-0027, O6): read the host's own openclaw
// config, learn the resident gateway's loopback port, probe it, report
// reachability on the heartbeat — never start it, never read the token.
//
// The config path is resolved from OPENCLAW_HOME, so each case redirects it to
// a scratch dir written before the dynamic import reads process.env.

const scratch = mkdtempSync(join(tmpdir(), 'mf-oc-gw-'))
const writeConfig = (home: string, config: unknown): void => {
    mkdirSync(join(home, '.openclaw'), { recursive: true })
    writeFileSync(
        join(home, '.openclaw', 'openclaw.json'),
        JSON.stringify(config)
    )
}

const listen = (): Promise<{ server: Server; port: number }> =>
    new Promise((resolve) => {
        const server = createServer((_req, res) => {
            res.writeHead(200)
            res.end('ok')
        })
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number }
            resolve({ server, port: addr.port })
        })
    })

const { discoverOpenclawGateway } = await import(
    '../src/daemon/openclaw-gateway'
)

const withHome = async (home: string, fn: () => Promise<void>): Promise<void> => {
    const prior = process.env.OPENCLAW_HOME
    process.env.OPENCLAW_HOME = home
    try {
        await fn()
    } finally {
        if (prior === undefined) delete process.env.OPENCLAW_HOME
        else process.env.OPENCLAW_HOME = prior
    }
}

test('no openclaw config → the framework simply omits the gateway field', async () => {
    const home = join(scratch, 'no-config')
    mkdirSync(home, { recursive: true })
    await withHome(home, async () => {
        assert.equal(await discoverOpenclawGateway(), undefined)
    })
})

test('unparsable config → undefined, never a throw', async () => {
    const home = join(scratch, 'bad-json')
    mkdirSync(join(home, '.openclaw'), { recursive: true })
    writeFileSync(join(home, '.openclaw', 'openclaw.json'), '{ not json')
    await withHome(home, async () => {
        assert.equal(await discoverOpenclawGateway(), undefined)
    })
})

test('a reachable local gateway is probed and reported (no token)', async () => {
    const { server, port } = await listen()
    const home = join(scratch, 'reachable')
    writeConfig(home, {
        gateway: { mode: 'local', port, auth: { mode: 'token', token: 'secret' } }
    })
    try {
        await withHome(home, async () => {
            const gateway = await discoverOpenclawGateway()
            assert.ok(gateway)
            assert.equal(gateway.port, port)
            assert.equal(gateway.reachable, true)
            assert.ok(typeof gateway.checkedAt === 'string')
            // The token is never reported.
            assert.ok(!JSON.stringify(gateway).includes('secret'))
        })
    } finally {
        server.close()
    }
})

test('a configured but down gateway reports reachable:false', async () => {
    // Bind a port, then free it so the connect refuses deterministically.
    const { server, port } = await listen()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const home = join(scratch, 'down')
    writeConfig(home, { gateway: { mode: 'local', port } })
    await withHome(home, async () => {
        const gateway = await discoverOpenclawGateway()
        assert.ok(gateway)
        assert.equal(gateway.port, port)
        assert.equal(gateway.reachable, false)
    })
})

test('a remote gateway is not ours to probe → port null, reachable null', async () => {
    const home = join(scratch, 'remote')
    writeConfig(home, {
        gateway: {
            mode: 'remote',
            port: 18789,
            remote: { url: 'wss://gw.example.com', token: 't' }
        }
    })
    await withHome(home, async () => {
        const gateway = await discoverOpenclawGateway()
        assert.deepEqual(gateway, {
            port: null,
            reachable: null,
            checkedAt: gateway?.checkedAt as string
        })
    })
})

test('a config with no gateway port → port null', async () => {
    const home = join(scratch, 'no-port')
    writeConfig(home, { gateway: { mode: 'local' } })
    await withHome(home, async () => {
        const gateway = await discoverOpenclawGateway()
        assert.equal(gateway?.port, null)
        assert.equal(gateway?.reachable, null)
    })
})
