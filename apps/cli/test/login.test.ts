import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { loadConfig, resolveConfigPath, saveConfig } from '../src/config'
import {
    formatCliAuthEndpointHint,
    parseCallbackRequestUrl,
    registerLogin,
    resolveLoginMode
} from '../src/commands/login'
import { registerSetup } from '../src/commands/setup'

test('resolveLoginMode selects browser, headless, token, and auth-code modes', () => {
    assert.equal(resolveLoginMode({}, true), 'browser')
    assert.equal(resolveLoginMode({ launchBrowser: false }, true), 'headless')
    assert.equal(resolveLoginMode({ token: 'nca_x' }, false), 'token')
    assert.equal(
        resolveLoginMode({ authCode: 'mf_auth_x' }, false),
        'auth-code'
    )
})

test('resolveLoginMode rejects non-interactive headless login without auth code', () => {
    assert.throws(
        () => resolveLoginMode({ launchBrowser: false }, false),
        /interactive terminal/
    )
})

// Commander derives `launchBrowser: false` from `--no-launch-browser`; it never
// sets `noLaunchBrowser`. Reading the wrong field silently downgraded the flag
// to a no-op and stranded SSH users on the loopback-callback flow, so these
// assert the parsed shape from the real command registration rather than a
// hand-written options literal.
test('mf login --no-launch-browser reaches resolveLoginMode as headless', () => {
    const program = new Command()
    registerLogin(program)
    const login = program.commands.find((c) => c.name() === 'login')
    assert.ok(login, 'login command is registered')
    login.parseOptions(['--no-launch-browser'])
    assert.equal(login.opts().launchBrowser, false)
    assert.equal(resolveLoginMode(login.opts(), true), 'headless')
})

test('mf login without the flag still resolves to browser mode', () => {
    const program = new Command()
    registerLogin(program)
    const login = program.commands.find((c) => c.name() === 'login')
    assert.ok(login)
    login.parseOptions([])
    assert.equal(login.opts().launchBrowser, true)
    assert.equal(resolveLoginMode(login.opts(), true), 'browser')
})

const parseSetupOptions = (argv: string[]): Record<string, unknown> => {
    const program = new Command()
    registerSetup(program)
    const setup = program.commands.find((c) => c.name() === 'setup')
    assert.ok(setup, 'setup command is registered')
    setup.parseOptions(argv)
    return setup.opts()
}

test('mf setup exposes --no-launch-browser for SSH sessions', () => {
    assert.equal(parseSetupOptions(['--no-launch-browser']).launchBrowser, false)
    assert.equal(parseSetupOptions([]).launchBrowser, true)
})

test('parseCallbackRequestUrl extracts auth code and reports callback errors', () => {
    assert.deepEqual(parseCallbackRequestUrl('/callback?code=mf_auth_abc'), {
        authCode: 'mf_auth_abc'
    })
    assert.deepEqual(parseCallbackRequestUrl('/callback?error=denied'), {
        error: 'denied'
    })
    assert.deepEqual(parseCallbackRequestUrl('/other?code=x'), {
        error: 'unknown callback path'
    })
})

test('formatCliAuthEndpointHint includes the configured API URL and local helper', () => {
    const message = formatCliAuthEndpointHint(
        'https://api.manyfold.ai/api/',
        '/auth/cli/start'
    )
    assert.match(message, /https:\/\/api\.manyfold\.ai\/api\/auth\/cli\/start/)
    assert.match(message, /just cli login/)
})

test('saveConfig writes private config directory and file permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-config-'))
    const previous = process.env.MF_CONFIG_DIR
    process.env.MF_CONFIG_DIR = dir
    try {
        await saveConfig({ apiUrl: 'https://api.test', token: 'nca_token' })
        assert.equal(
            resolveConfigPath(),
            join(dir, 'profiles', 'default', 'config.json')
        )
        assert.deepEqual(await loadConfig(), {
            apiUrl: 'https://api.test',
            token: 'nca_token'
        })
        assert.equal(
            (await stat(join(dir, 'profiles', 'default'))).mode & 0o777,
            0o700
        )
        assert.equal((await stat(resolveConfigPath())).mode & 0o777, 0o600)
    } finally {
        if (previous === undefined) delete process.env.MF_CONFIG_DIR
        else process.env.MF_CONFIG_DIR = previous
        await rm(dir, { recursive: true, force: true })
    }
})
