import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ServiceSupervisor } from '../src/daemon/services'

// The services a pod host's daemon keeps up (ADR-0035 §6). These run real
// processes: a tiny HTTP server stands in for a framework's gateway.

const freePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            server.close(() => resolve(port))
        })
    })

const gateway = (port: number) => ({
    name: 'fixture-gateway',
    command: [
        process.execPath,
        '-e',
        `require('node:http').createServer((q, s) => s.end(process.env.FIXTURE_REPLY)).listen(${port}, '127.0.0.1')`
    ],
    dir: tmpdir(),
    // The sealed test runner's NODE_OPTIONS loads a guard that needs its MF_
    // policy variables, which a service never inherits from its daemon.
    env: { FIXTURE_REPLY: 'fixture-ok', NODE_OPTIONS: '' },
    port,
    healthPath: '/healthz'
})

const until = async (check: () => Promise<boolean>, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time')
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}

const gone = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return false
    } catch {
        return true
    }
}

test('a service is kept up from its spec, and outlives the daemon that started it', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-services-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const port = await freePort()
    let clock = Date.now()
    const lines: string[] = []
    const first = new ServiceSupervisor({
        dir,
        log: (line) => lines.push(line),
        now: () => clock
    })
    await first.upsert(gateway(port))

    // The env carries a framework's credentials: it is kept apart, 0600.
    const spec = JSON.parse(await readFile(join(dir, 'fixture-gateway.json'), 'utf8'))
    assert.equal('env' in spec.spec, false)
    assert.equal((await stat(join(dir, 'fixture-gateway.env'))).mode & 0o777, 0o600)
    assert.equal(spec.desired, 'stopped', 'an upsert alone starts nothing')

    const started = await first.start('fixture-gateway')
    assert.equal(started.state, 'running')
    const pid = started.pid!
    t.after(() => {
        try {
            process.kill(-pid, 'SIGKILL')
        } catch {}
    })
    await until(async () => (await first.list())[0]?.healthy === true)

    // A crash is restarted by the loop, after the backoff.
    process.kill(pid, 'SIGKILL')
    await until(async () => gone(pid))
    await first.reconcile()
    assert.equal((await first.list())[0].state, 'restarting', 'still in its backoff')
    clock += 5_000
    await first.reconcile()
    const [restarted] = await first.list()
    assert.equal(restarted.state, 'running')
    assert.equal(restarted.restarts, 1)
    assert.notEqual(restarted.pid, pid)
    const livePid = restarted.pid!
    t.after(() => {
        try {
            process.kill(-livePid, 'SIGKILL')
        } catch {}
    })
    await until(async () => (await first.list())[0]?.healthy === true)

    // A new daemon (a self-update) adopts the running process instead of
    // starting a second one.
    first.stopLoop()
    const second = new ServiceSupervisor({ dir, log: (line) => lines.push(line) })
    await second.resume()
    second.stopLoop()
    const [adopted] = await second.list()
    assert.equal(adopted.pid, livePid)
    assert.ok(lines.some((line) => line.includes(`adopted pid ${livePid}`)))

    const stopped = await second.stop('fixture-gateway')
    assert.equal(stopped.state, 'stopped')
    await until(async () => gone(livePid))
    await second.reconcile()
    assert.equal((await second.list())[0].state, 'stopped', 'a stopped service stays down')

    await second.remove('fixture-gateway')
    assert.deepEqual(await second.list(), [])
})

test('a service name and spec are checked before anything is written', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-services-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const supervisor = new ServiceSupervisor({ dir, log: () => {} })
    await assert.rejects(
        supervisor.upsert({ ...gateway(1), name: '../escape' }),
        /invalid service name/
    )
    await assert.rejects(
        supervisor.upsert({ ...gateway(1), dir: 'relative' }),
        /must be absolute/
    )
    await assert.rejects(supervisor.start('missing'), /no such service/)
    assert.deepEqual(await supervisor.list(), [])
})
