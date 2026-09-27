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
    realpathSync,
    rmSync,
    symlinkSync,
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
    const workspace = join(root, 'workspace')
    const native = join(home, '.gemini', 'antigravity-cli')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(native, 'brain', 'conv-1'), { recursive: true })
    mkdirSync(join(native, 'conversations'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    // The machine's own sign-in mode: no modelProvider, the user's prefs.
    writeFileSync(join(native, 'settings.json'), '{"colorScheme":"dark"}')
    writeFileSync(join(native, 'keybindings.json'), '{}')
    writeFileSync(join(bin, 'agy'), FAKE_AGY)
    chmodSync(join(bin, 'agy'), 0o755)
    return { root, home, bin, workspace, native }
}

const run = (
    l: ReturnType<typeof lab>,
    env: Record<string, string>,
    agyArgs: string[] = ['--output-format', 'stream-json']
) =>
    spawnSync('bash', ['-c', AGY_PLATFORM_VIEW_SCRIPT, 'agy', ...agyArgs], {
        cwd: l.workspace,
        env: { HOME: l.home, PATH: `${l.bin}:/usr/bin:/bin`, ...env },
        input: 'the prompt',
        encoding: 'utf8'
    })

// API-key mode, and the folder agy runs in as trusted (bash reports the
// physical path, as agy then sees it).
const viewSettings = (dir: string) =>
    JSON.stringify({
        modelProvider: 'gemini',
        trustedWorkspaces: [realpathSync(dir)]
    })

const viewOf = (l: ReturnType<typeof lab>, id = 'art_1') =>
    join(l.home, '.manyfold', 'antigravity-cli', id, 'app')

test('custom provider models get isolated native agy registrations without touching sign-in', () => {
    const l = lab()
    try {
        const runs = ['google/gemini-3.8-flash', 'gemini-3.6-flash-medium'].map(
            (model) =>
                antigravityPlatformExec({
                    agyArgs: [],
                    runtimeId: 'art_1',
                    apiKey: 'fixture-key',
                    managedHost: true,
                    model,
                    providerModel: model
                })
        )
        assert.notEqual(runs[0].env.MF_AGY_VIEW, runs[1].env.MF_AGY_VIEW)
        for (const [index, exec] of runs.entries()) {
            assert.equal(run(l, exec.env, exec.cmd.slice(4)).status, 0)
            const settings = JSON.parse(
                readFileSync(
                    join(viewOf(l, exec.env.MF_AGY_VIEW), 'settings.json'),
                    'utf8'
                )
            )
            assert.equal(settings.modelProvider, 'gemini')
            assert.equal(
                settings.customModelsConfig.customModels[
                    'manyfold-provider-model'
                ].modelName,
                index === 0
                    ? 'google/gemini-3.8-flash'
                    : 'gemini-3.6-flash-medium'
            )
            assert.deepEqual(exec.cmd.slice(-2), [
                '--model',
                'manyfold-provider-model'
            ])
            const prepare = antigravityPlatformViewPrepare(exec.env)
            assert.equal(
                prepare.env.MF_AGY_CUSTOM_MODELS_JSON,
                exec.env.MF_AGY_CUSTOM_MODELS_JSON
            )
        }
        assert.equal(
            readFileSync(join(l.native, 'settings.json'), 'utf8'),
            '{"colorScheme":"dark"}'
        )
        assert.ok(
            existsSync(
                join(viewOf(l, runs[0].env.MF_AGY_VIEW), 'settings.json')
            )
        )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

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

test('the view owns only its settings: API-key mode and the folder agy runs in', () => {
    const l = lab()
    try {
        run(l, { MF_AGY_VIEW: 'art_1' })
        const view = viewOf(l)
        assert.equal(
            readFileSync(join(view, 'settings.json'), 'utf8'),
            viewSettings(l.workspace)
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
            viewSettings(l.workspace)
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

test('a trusted folder is written as JSON, and one that is not plain text is left to agy', () => {
    const l = lab()
    try {
        const odd = join(l.root, 'it\'s "odd" \\ here')
        mkdirSync(odd)
        const quoted = spawnSync(
            'bash',
            ['-c', AGY_PLATFORM_VIEW_SCRIPT, 'agy'],
            {
                cwd: odd,
                env: {
                    HOME: l.home,
                    PATH: `${l.bin}:/usr/bin:/bin`,
                    MF_AGY_VIEW: 'art_1'
                },
                input: '',
                encoding: 'utf8'
            }
        )
        assert.equal(quoted.status, 0, quoted.stderr)
        const settings = JSON.parse(
            readFileSync(join(viewOf(l), 'settings.json'), 'utf8')
        ) as { modelProvider: string; trustedWorkspaces: string[] }
        assert.equal(settings.modelProvider, 'gemini')
        assert.deepEqual(settings.trustedWorkspaces, [realpathSync(odd)])

        const control = join(l.root, 'line\nbreak')
        mkdirSync(control)
        const plain = spawnSync(
            'bash',
            ['-c', AGY_PLATFORM_VIEW_SCRIPT, 'agy'],
            {
                cwd: control,
                env: {
                    HOME: l.home,
                    PATH: `${l.bin}:/usr/bin:/bin`,
                    MF_AGY_VIEW: 'art_1'
                },
                input: '',
                encoding: 'utf8'
            }
        )
        assert.equal(plain.status, 0, plain.stderr)
        assert.equal(
            readFileSync(join(viewOf(l), 'settings.json'), 'utf8'),
            '{"modelProvider":"gemini"}'
        )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('settings that turned into a link are a file of the view’s own again', () => {
    const l = lab()
    try {
        run(l, { MF_AGY_VIEW: 'art_1' })
        const view = viewOf(l)
        writeFileSync(
            join(l.native, 'settings.json'),
            viewSettings(l.workspace)
        )
        rmSync(join(view, 'settings.json'))
        symlinkSync(
            join(l.native, 'settings.json'),
            join(view, 'settings.json')
        )
        run(l, { MF_AGY_VIEW: 'art_1' })
        assert.equal(
            lstatSync(join(view, 'settings.json')).isSymbolicLink(),
            false
        )
        assert.equal(
            readFileSync(join(view, 'settings.json'), 'utf8'),
            viewSettings(l.workspace)
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
            cwd: l.workspace,
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
            viewSettings(l.workspace)
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
