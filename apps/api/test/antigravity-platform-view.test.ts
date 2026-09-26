import { OFFICIAL_PROVIDER_BASE_URL } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    AGY_PLATFORM_VIEW_SCRIPT,
    antigravityPlatformExec,
    antigravityPlatformViewPrepare
} from '../src/modules/agents/credentials/antigravity-app-dir'

// A stand-in `agy` that reports what the real one would see: its argv, the
// view variable (which must not reach it) and the prompt on stdin.
const FAKE_AGY = `#!/bin/sh
{
    echo "argv=$*"
    echo "viewVar=\${MF_AGY_VIEW:-unset}"
    echo "stdin=$(cat)"
} > "$HOME/agy-saw.txt"
exit "\${FAKE_AGY_EXIT:-0}"
`

const lab = () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-agy-view-'))
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    const native = join(home, '.gemini', 'antigravity-cli')
    mkdirSync(join(native, 'brain', 'conv-1'), { recursive: true })
    mkdirSync(join(native, 'conversations'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    // The machine's own sign-in mode: no modelProvider, the user's prefs.
    writeFileSync(join(native, 'settings.json'), '{"colorScheme":"dark"}')
    writeFileSync(join(native, 'keybindings.json'), '{}')
    writeFileSync(join(bin, 'agy'), FAKE_AGY)
    chmodSync(join(bin, 'agy'), 0o755)
    return { root, home, bin, native }
}

const run = (
    l: ReturnType<typeof lab>,
    env: Record<string, string>,
    agyArgs: string[] = ['--output-format', 'stream-json']
) =>
    spawnSync('bash', ['-c', AGY_PLATFORM_VIEW_SCRIPT, 'agy', ...agyArgs], {
        env: { HOME: l.home, PATH: `${l.bin}:/usr/bin:/bin`, ...env },
        input: 'the prompt',
        encoding: 'utf8'
    })

const viewOf = (l: ReturnType<typeof lab>, id = 'art_1') =>
    join(l.home, '.manyfold', 'antigravity-cli', id, 'app')

test('agy runs on the view, pointed at it relative to its ~/.gemini', () => {
    const l = lab()
    try {
        const result = run(l, { MF_AGY_VIEW: 'art_1' })
        assert.equal(result.status, 0, result.stderr)
        const saw = readFileSync(join(l.home, 'agy-saw.txt'), 'utf8')
        assert.match(
            saw,
            /^argv=--app_data_dir=\.\.\/\.manyfold\/antigravity-cli\/art_1\/app --output-format stream-json$/m
        )
        assert.match(saw, /^viewVar=unset$/m)
        assert.match(saw, /^stdin=the prompt$/m)
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('the view owns only the settings that turn API-key mode on', () => {
    const l = lab()
    try {
        run(l, { MF_AGY_VIEW: 'art_1' })
        const view = viewOf(l)
        assert.equal(
            readFileSync(join(view, 'settings.json'), 'utf8'),
            '{"modelProvider":"gemini"}'
        )
        assert.equal(
            lstatSync(join(view, 'settings.json')).isSymbolicLink(),
            false
        )
        assert.equal(
            readFileSync(join(l.native, 'settings.json'), 'utf8'),
            '{"colorScheme":"dark"}',
            "the machine's own settings are never touched"
        )
        for (const name of [
            'brain',
            'conversations',
            'cache',
            'presence',
            'keybindings.json'
        ])
            assert.equal(
                readlinkSync(join(view, name)),
                join(l.native, name),
                name
            )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('a rebuild drops what agy wrote into the view and repairs a broken link', () => {
    const l = lab()
    try {
        run(l, { MF_AGY_VIEW: 'art_1' })
        const view = viewOf(l)
        writeFileSync(join(view, 'jetbox_summaries_proto.pb'), 'cache')
        rmSync(join(view, 'brain'))
        mkdirSync(join(view, 'brain'))
        writeFileSync(join(view, 'settings.json'), '{}')
        const again = run(l, { MF_AGY_VIEW: 'art_1' })
        assert.equal(again.status, 0, again.stderr)
        assert.equal(existsSync(join(view, 'jetbox_summaries_proto.pb')), false)
        assert.equal(readlinkSync(join(view, 'brain')), join(l.native, 'brain'))
        assert.equal(
            readFileSync(join(view, 'settings.json'), 'utf8'),
            '{"modelProvider":"gemini"}'
        )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('the machine’s Google sign-in never enters the view', () => {
    const l = lab()
    try {
        writeFileSync(join(l.native, 'antigravity-oauth-token'), 'machine')
        run(l, { MF_AGY_VIEW: 'art_1' })
        const view = viewOf(l)
        assert.equal(existsSync(join(view, 'antigravity-oauth-token')), false)
        // One agy saved in the view itself (a sign-in inside the platform
        // TUI) is gone at the next start.
        writeFileSync(join(view, 'antigravity-oauth-token'), 'view')
        const again = run(l, { MF_AGY_VIEW: 'art_1' })
        assert.equal(again.status, 0, again.stderr)
        assert.equal(existsSync(join(view, 'antigravity-oauth-token')), false)
        assert.equal(
            readFileSync(join(l.native, 'antigravity-oauth-token'), 'utf8'),
            'machine'
        )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('agy’s exit code comes back unchanged', () => {
    const l = lab()
    try {
        assert.equal(
            run(l, { MF_AGY_VIEW: 'art_1', FAKE_AGY_EXIT: '3' }).status,
            3
        )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('a view id that is not a plain token is refused before anything is built', () => {
    const l = lab()
    try {
        const result = run(l, { MF_AGY_VIEW: '../escape' })
        assert.equal(result.status, 64)
        assert.equal(existsSync(join(l.home, '.manyfold')), false)
        assert.equal(existsSync(join(l.home, 'agy-saw.txt')), false)
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('prepare-only builds the view and prints the flag, without running agy', () => {
    const l = lab()
    try {
        const prepare = antigravityPlatformViewPrepare({ MF_AGY_VIEW: 'art_1' })
        const result = spawnSync(prepare.cmd[0], prepare.cmd.slice(1), {
            env: {
                HOME: l.home,
                PATH: `${l.bin}:/usr/bin:/bin`,
                ...prepare.env
            },
            encoding: 'utf8'
        })
        assert.equal(result.status, 0, result.stderr)
        assert.equal(
            result.stdout.trim(),
            '--app_data_dir=../.manyfold/antigravity-cli/art_1/app'
        )
        assert.equal(existsSync(join(l.home, 'agy-saw.txt')), false)
        assert.equal(
            readFileSync(join(viewOf(l), 'settings.json'), 'utf8'),
            '{"modelProvider":"gemini"}'
        )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('the platform exec carries the key, the endpoint and nothing that could outrank them', () => {
    const managed = antigravityPlatformExec({
        agyArgs: ['--model', 'gemini-3.1-pro-low'],
        runtimeId: 'art_1',
        apiKey: 'gk-marker',
        baseUrl: null,
        managedHost: true
    })
    assert.deepEqual(managed.cmd, [
        'bash',
        '-c',
        AGY_PLATFORM_VIEW_SCRIPT,
        'agy',
        '--model',
        'gemini-3.1-pro-low'
    ])
    assert.equal(managed.env.GEMINI_API_KEY, 'gk-marker')
    assert.equal(
        managed.env.GOOGLE_GEMINI_BASE_URL,
        OFFICIAL_PROVIDER_BASE_URL.google
    )
    assert.equal(managed.env.MF_AGY_VIEW, 'art_1')
    assert.equal(managed.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
    for (const name of [
        'GOOGLE_API_KEY',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'AGY_GATEWAY_URL',
        'AGY_ADC_AUTH',
        'JETSKI_APP_DATA_DIR'
    ])
        assert.equal(managed.env[name], '', name)

    const own = antigravityPlatformExec({
        agyArgs: [],
        runtimeId: 'art_2',
        apiKey: 'gk-marker',
        baseUrl: 'https://gw.example/antigravity ',
        managedHost: false
    })
    assert.equal(
        own.env.GOOGLE_GEMINI_BASE_URL,
        'https://gw.example/antigravity'
    )
    assert.equal(own.env.AGY_CLI_DISABLE_AUTO_UPDATE, undefined)
})
