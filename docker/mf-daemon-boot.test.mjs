import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const boot = resolve('docker/mf-base/mf-daemon-boot.sh')
const serviceBoot = resolve('docker/mf-base/mf-service-boot.sh')
const fixture = (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mf-runner-boot-'))
    const bin = join(root, 'mf')
    const log = join(root, 'events')
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const log = value => fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(value) + '\\n')
if (args.includes('register')) {
    const input = fs.readFileSync(0, 'utf8')
    const attempt = fs.existsSync(process.env.TEST_LOG) ? fs.readFileSync(process.env.TEST_LOG, 'utf8').split('\\n').filter(line => line.includes('"kind":"register"')).length : 0
    log({ kind: 'register', args, stdinToken: input === 'fixture-token' })
    const failures = JSON.parse(process.env.TEST_REGISTER_FAILURES || '[]')
    if (failures[attempt]) process.exit(failures[attempt])
    const dir = process.env.MF_CONFIG_DIR + '/profiles/podrunner/daemon'
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(dir + '/config.json', '{}')
} else {
    log({ kind: 'start', args, inheritedToken: !!process.env.MF_DAEMON_TOKEN })
    const timer = setInterval(() => {}, 1000)
    process.on('SIGTERM', () => { log({ kind: 'stop' }); clearInterval(timer) })
}
`, { mode: 0o755 })
    writeFileSync(join(root, 'mf-daemon-boot'), readFileSync(boot), { mode: 0o755 })
    const children = []
    t.after(async () => {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                try { process.kill(-child.pid, 'SIGKILL') } catch {}
            }
            await child.closed
        }
        rmSync(root, { recursive: true, force: true })
    })
    const events = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
    const launch = (args = [boot], extra = {}) => {
        const child = spawn('sh', args, {
            detached: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, PATH: root + ':' + process.env.PATH, TEST_LOG: log, MF_BIN: bin,
                MF_CONFIG_DIR: root + '/state', MF_PROFILE: 'podrunner',
                MF_API_URL: 'http://127.0.0.1:1/api', MF_DAEMON_TOKEN: 'fixture-token',
                MF_DAEMON_HOST_NAME: 'pod-runner:art_fixture', MF_DAEMON_WORKSPACE_ROOT: root + '/data',
                MF_DAEMON_RESTART_DELAY_SECONDS: '0.05', ...extra }
        })
        child.closed = new Promise(resolve => child.once('close', resolve))
        child.stderr.resume()
        children.push(child)
        return child
    }
    const fastRetries = () => writeFileSync(join(root, 'sleep'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.TEST_LOG, JSON.stringify({ kind: 'sleep', seconds: Number(process.argv[2]) }) + '\\n')
`, { mode: 0o755 })
    return { root, launch, events, fastRetries }
}

const until = async (predicate) => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('runner fixture timed out')
        await new Promise(resolve => setTimeout(resolve, 20))
    }
}

test('Pod registration declares the existing workspace and keeps credentials off argv and child env', async t => {
    const h = fixture(t)
    const child = h.launch()
    await until(() => h.events().some(e => e.kind === 'start'))
    const [registration, start] = h.events()
    assert.equal(registration.stdinToken, true)
    assert.equal(registration.args.includes('fixture-token'), false)
    assert.equal(registration.args.at(-1), h.root + '/data')
    assert.equal(start.inheritedToken, false)
    child.kill('SIGTERM')
    await child.closed
    assert.ok(h.events().some(e => e.kind === 'stop'))
})

test('a Pod restart reuses its persistent registration without a new token', async t => {
    const h = fixture(t)
    mkdirSync(h.root + '/state/profiles/podrunner/daemon', { recursive: true })
    writeFileSync(h.root + '/state/profiles/podrunner/daemon/config.json', '{}')
    const child = h.launch([boot], { MF_DAEMON_TOKEN: '' })
    await until(() => h.events().some(e => e.kind === 'start'))
    assert.equal(h.events().some(e => e.kind === 'register'), false)
    child.kill('SIGTERM')
    await child.closed
})

test('an unregistered Pod without credentials exits instead of idling without a runner', async t => {
    const h = fixture(t)
    const child = h.launch([boot], { MF_DAEMON_TOKEN: '' })
    assert.equal(await child.closed, 1)
    assert.deepEqual(h.events(), [])
})

test('gateway exit stops and reaps the daemon supervisor', async t => {
    const h = fixture(t)
    const gate = join(h.root, 'gateway-exit')
    const child = h.launch([serviceBoot, 'sh', '-c', 'while [ ! -f "$TEST_GATE" ]; do sleep 0.02; done; exit 7'], { TEST_GATE: gate })
    await until(() => h.events().some(e => e.kind === 'start'))
    writeFileSync(gate, '')
    assert.equal(await child.closed, 7)
    assert.ok(h.events().some(e => e.kind === 'start'))
    assert.ok(h.events().some(e => e.kind === 'stop'))
})

for (const code of [3, 4, 5]) {
    test(`permanent registration failure (exit ${code}) stops after one attempt`, async t => {
        const h = fixture(t)
        h.fastRetries()
        const child = h.launch([boot], { TEST_REGISTER_FAILURES: JSON.stringify([code]) })
        assert.equal(await child.closed, 1)
        assert.equal(h.events().filter(e => e.kind === 'register').length, 1)
        assert.equal(h.events().some(e => e.kind === 'sleep' || e.kind === 'start'), false)
    })
}

test('transient registration failures back off and recover', async t => {
    const h = fixture(t)
    h.fastRetries()
    const child = h.launch([boot], { TEST_REGISTER_FAILURES: '[2,1]' })
    await until(() => h.events().some(e => e.kind === 'start'))
    assert.equal(h.events().filter(e => e.kind === 'register').length, 3)
    assert.deepEqual(h.events().filter(e => e.kind === 'sleep').map(e => e.seconds), [10, 20])
    child.kill('SIGTERM')
    await child.closed
})

test('repeated registration failures exhaust their bounded retry budget', async t => {
    const h = fixture(t)
    h.fastRetries()
    const child = h.launch([boot], { TEST_REGISTER_FAILURES: '[1,1,1,1,1,1]' })
    assert.equal(await child.closed, 1)
    assert.equal(h.events().filter(e => e.kind === 'register').length, 6)
    assert.deepEqual(h.events().filter(e => e.kind === 'sleep').map(e => e.seconds), [10, 20, 40, 80, 120])
    assert.equal(h.events().some(e => e.kind === 'start'), false)
})

test('gateway and its tools inherit agent environment without runner credentials', async t => {
    const h = fixture(t)
    const gateway = join(h.root, 'gateway')
    writeFileSync(gateway, `#!/usr/bin/env node
const fs = require('node:fs')
const keys = ['MF_DAEMON_TOKEN', 'MF_DAEMON_HOST_NAME', 'MF_DAEMON_WORKSPACE_ROOT', 'MF_CONFIG_DIR', 'MF_PROFILE']
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ kind: 'gateway', runnerKeys: keys.filter(k => process.env[k]), agentToken: process.env.MF_API_TOKEN, apiUrl: process.env.MF_API_URL }) + '\\n')
setInterval(() => {}, 1000)
`, { mode: 0o755 })
    const child = h.launch([serviceBoot, gateway], { MF_API_TOKEN: 'agent-token' })
    await until(() => h.events().some(e => e.kind === 'gateway') && h.events().some(e => e.kind === 'start'))
    const event = h.events().find(e => e.kind === 'gateway')
    assert.deepEqual(event.runnerKeys, [])
    assert.equal(event.agentToken, 'agent-token')
    assert.equal(event.apiUrl, 'http://127.0.0.1:1/api')
    child.kill('SIGTERM')
    await child.closed
})

test('shutdown interrupts registration backoff and reaps the sleep process', async t => {
    const h = fixture(t)
    const child = h.launch([boot], { TEST_REGISTER_FAILURES: '[2]' })
    await until(() => h.events().some(e => e.kind === 'register'))
    child.kill('SIGTERM')
    assert.equal(await child.closed, 0)
    assert.equal(h.events().some(e => e.kind === 'start'), false)
})
