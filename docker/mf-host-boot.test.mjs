import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const boot = resolve('docker/host/mf-host-boot.sh')

// A stand-in mf: reports its baked-in version, registers by writing the daemon
// config, and as a daemon logs its start and either stays up or crashes.
const fakeMf = (version, { crash = false } = {}) => `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const log = value => fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(value) + '\\n')
if (args.includes('--version')) { console.log('${version}'); process.exit(0) }
if (args.includes('register')) {
    const input = fs.readFileSync(0, 'utf8')
    const attempt = fs.existsSync(process.env.TEST_LOG) ? fs.readFileSync(process.env.TEST_LOG, 'utf8').split('\\n').filter(line => line.includes('"kind":"register"')).length : 0
    log({ kind: 'register', version: '${version}', args, stdinToken: input === 'fixture-token' })
    const failures = JSON.parse(process.env.TEST_REGISTER_FAILURES || '[]')
    if (failures[attempt]) process.exit(failures[attempt])
    const dir = process.env.MF_CONFIG_DIR + '/profiles/' + process.env.MF_PROFILE + '/daemon'
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(dir + '/config.json', '{}')
} else {
    log({ kind: 'start', version: '${version}', supervisor: process.env.MF_DAEMON_SUPERVISOR ?? null, inheritedToken: !!process.env.MF_DAEMON_TOKEN, path: process.env.PATH })
    if (${crash}) process.exit(1)
    const timer = setInterval(() => {}, 1000)
    process.on('SIGTERM', () => { log({ kind: 'stop' }); clearInterval(timer) })
}
`

const fixture = (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mf-host-boot-'))
    const home = join(root, 'home')
    const imageMf = join(root, 'image', 'mf')
    const homeMf = join(home, '.local', 'bin', 'mf')
    const log = join(root, 'events')
    mkdirSync(join(root, 'image'), { recursive: true })
    mkdirSync(home, { recursive: true })
    const children = []
    t.after(async () => {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                try {
                    process.kill(-child.pid, 'SIGKILL')
                } catch {}
            }
            await child.closed
        }
        rmSync(root, { recursive: true, force: true })
    })
    const events = () =>
        existsSync(log)
            ? readFileSync(log, 'utf8')
                  .trim()
                  .split('\n')
                  .filter(Boolean)
                  .map(JSON.parse)
            : []
    const image = (version) =>
        writeFileSync(imageMf, fakeMf(version), { mode: 0o755 })
    const installed = (version, options) => {
        mkdirSync(join(home, '.local', 'bin'), { recursive: true })
        writeFileSync(homeMf, fakeMf(version, options), { mode: 0o755 })
    }
    const launch = (extra = {}) => {
        const child = spawn('sh', [boot], {
            detached: true,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
                ...process.env,
                HOME: home,
                TEST_LOG: log,
                MF_IMAGE_BIN: imageMf,
                MF_API_URL: 'http://127.0.0.1:1/api',
                MF_DAEMON_TOKEN: 'fixture-token',
                MF_DAEMON_HOST_NAME: 'pod-runner:rth_fixture',
                MF_DAEMON_RESTART_DELAY_SECONDS: '0.05',
                ...extra
            }
        })
        child.closed = new Promise((resolve) => child.once('close', resolve))
        child.stderr.setEncoding('utf8')
        child.stderrText = ''
        child.stderr.on('data', (chunk) => {
            child.stderrText += chunk
        })
        children.push(child)
        return child
    }
    return { home, homeMf, image, installed, launch, events }
}

const until = async (predicate) => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
        if (Date.now() > deadline)
            throw new Error('host boot fixture timed out')
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

test('a first boot copies the image mf onto the home volume, registers with the token on stdin and marks the daemon container-supervised', async (t) => {
    const h = fixture(t)
    h.image('3.0.1')
    const child = h.launch()
    await until(() => h.events().some((e) => e.kind === 'start'))
    assert.ok(existsSync(h.homeMf))
    const register = h.events().find((e) => e.kind === 'register')
    assert.equal(register.stdinToken, true)
    assert.ok(!register.args.includes('fixture-token'))
    assert.ok(register.args.includes('pod-runner:rth_fixture'))
    const start = h.events().find((e) => e.kind === 'start')
    assert.equal(start.version, '3.0.1')
    assert.equal(start.supervisor, 'container')
    assert.equal(start.inheritedToken, false)
    assert.ok(start.path.split(':')[0].endsWith('/.local/bin'))
    child.kill('SIGTERM')
    assert.equal(await child.closed, 0)
    assert.ok(h.events().some((e) => e.kind === 'stop'))
})

test('an mf the daemon updated itself to survives a reboot on an older image', async (t) => {
    const h = fixture(t)
    h.image('3.0.1')
    h.installed('4.5.0')
    const child = h.launch()
    await until(() => h.events().some((e) => e.kind === 'start'))
    assert.equal(h.events().find((e) => e.kind === 'start').version, '4.5.0')
    child.kill('SIGTERM')
    await child.closed
})

test('a newer image replaces an older mf on the home volume', async (t) => {
    const h = fixture(t)
    h.image('4.6.0')
    h.installed('4.5.10')
    const child = h.launch()
    await until(() => h.events().some((e) => e.kind === 'start'))
    assert.equal(h.events().find((e) => e.kind === 'start').version, '4.6.0')
    assert.match(child.stderrText, /newer mf than 4\.5\.10/)
    child.kill('SIGTERM')
    await child.closed
})

test('an update that keeps crashing right after it starts goes back to the image mf', async (t) => {
    const h = fixture(t)
    h.image('3.0.1')
    h.installed('9.9.9', { crash: true })
    const child = h.launch()
    await until(
        () =>
            h
                .events()
                .filter((e) => e.kind === 'start' && e.version === '3.0.1')
                .length > 0
    )
    const versions = h
        .events()
        .filter((e) => e.kind === 'start')
        .map((e) => e.version)
    assert.deepEqual(versions.slice(0, 4), ['9.9.9', '9.9.9', '9.9.9', '3.0.1'])
    assert.match(child.stderrText, /exited 3 times/)
    child.kill('SIGTERM')
    await child.closed
})

test('a boot with a registered config and no credential skips registration', async (t) => {
    const h = fixture(t)
    h.image('3.0.1')
    const dir = join(h.home, '.manyfold', 'profiles', 'podrunner', 'daemon')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), '{}')
    const child = h.launch({ MF_DAEMON_TOKEN: '' })
    await until(() => h.events().some((e) => e.kind === 'start'))
    assert.equal(h.events().filter((e) => e.kind === 'register').length, 0)
    child.kill('SIGTERM')
    await child.closed
})

test('a rejected registration stops after one attempt', async (t) => {
    for (const status of [3, 4, 5]) {
        const h = fixture(t)
        h.image('3.0.1')
        const child = h.launch({
            TEST_REGISTER_FAILURES: JSON.stringify([status])
        })
        assert.equal(await child.closed, 1)
        assert.equal(h.events().filter((e) => e.kind === 'register').length, 1)
        assert.match(child.stderrText, /registration rejected/)
    }
})

test('no mf anywhere holds instead of looping', async (t) => {
    const h = fixture(t)
    const child = h.launch()
    assert.equal(await child.closed, 1)
    assert.match(child.stderrText, /no mf at/)
})
