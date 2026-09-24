import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    PI_PLATFORM_VIEW_SCRIPT,
    buildPiModelsJson,
    piAgentDirSetupScript,
    piPlatformDirect,
    piPlatformExec,
    piPlatformViewPrepare
} from '../src/modules/agents/credentials/pi-agent-dir'

// A stand-in `pi` that reports what the real one would see: its argv, the
// agent dir it was pointed at, whether the view's own variables leaked into
// it, and the prompt on stdin.
const FAKE_PI = `#!/bin/sh
{
    echo "argv=$*"
    echo "agentDir=$PI_CODING_AGENT_DIR"
    echo "viewVar=\${MF_PI_VIEW:-unset} modelsVar=\${MF_PI_MODELS_JSON:-unset}"
    echo "stdin=$(cat)"
} > "$HOME/pi-saw.txt"
exit "\${FAKE_PI_EXIT:-0}"
`

const lab = () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-pi-view-'))
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    const native = join(home, '.pi', 'agent')
    mkdirSync(join(native, 'skills', 'one'), { recursive: true })
    mkdirSync(join(native, 'sessions'), { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(native, 'settings.json'), '{"quietStartup":true}')
    writeFileSync(join(native, 'trust.json'), '{}')
    writeFileSync(join(native, '.hidden'), 'x')
    // What must never reach a platform turn: the machine's own sign-in, a
    // legacy OAuth file and a models.json that names a key of its own.
    writeFileSync(join(native, 'auth.json'), '{"anthropic":{"type":"oauth"}}')
    writeFileSync(join(native, 'oauth.json'), '{"anthropic":{}}')
    writeFileSync(
        join(native, 'models.json'),
        '{"providers":{"anthropic":{"apiKey":"MACHINE_KEY"}}}'
    )
    writeFileSync(join(bin, 'pi'), FAKE_PI)
    chmodSync(join(bin, 'pi'), 0o755)
    return { root, home, bin, native }
}

const run = (
    l: ReturnType<typeof lab>,
    env: Record<string, string>,
    piArgs: string[] = ['--mode', 'json', '--session-id', 'ref-1']
) => {
    const result = spawnSync(
        'bash',
        ['-c', PI_PLATFORM_VIEW_SCRIPT, 'pi', ...piArgs],
        {
            env: {
                HOME: l.home,
                PATH: `${l.bin}:/usr/bin:/bin`,
                ...env
            },
            input: 'the prompt',
            encoding: 'utf8'
        }
    )
    const saw = existsSync(join(l.home, 'pi-saw.txt'))
        ? readFileSync(join(l.home, 'pi-saw.txt'), 'utf8')
        : ''
    return { ...result, saw }
}

const viewOf = (l: ReturnType<typeof lab>, id = 'art_test') =>
    join(l.home, '.manyfold', 'pi', id, 'agent')

test('a platform exec runs pi on a view that keeps the machine config and drops its credentials', () => {
    const l = lab()
    try {
        const models = buildPiModelsJson('anthropic', 'https://gw.example')!
        const out = run(l, {
            MF_PI_VIEW: 'art_test',
            MF_PI_MODELS_JSON: models
        })
        assert.equal(out.status, 0, out.stderr)
        const view = viewOf(l)
        // pi got the same argv and stdin, pointed at the view, and none of the
        // view's own variables.
        assert.match(out.saw, /^argv=--mode json --session-id ref-1$/m)
        assert.match(out.saw, new RegExp(`^agentDir=${view}$`, 'm'))
        assert.match(out.saw, /^viewVar=unset modelsVar=unset$/m)
        assert.match(out.saw, /^stdin=the prompt$/m)
        // Everything but the credential files is the machine's own entry.
        for (const name of [
            'settings.json',
            'trust.json',
            'skills',
            'sessions',
            '.hidden'
        ])
            assert.equal(
                readlinkSync(join(view, name)),
                join(l.native, name),
                name
            )
        assert.equal(existsSync(join(view, 'oauth.json')), false)
        // auth.json is empty and real; models.json is the gateway override.
        assert.equal(lstatSync(join(view, 'auth.json')).isSymbolicLink(), false)
        assert.equal(readFileSync(join(view, 'auth.json'), 'utf8'), '{}')
        assert.equal(lstatSync(join(view, 'auth.json')).mode & 0o777, 0o600)
        assert.equal(readFileSync(join(view, 'models.json'), 'utf8'), models)
        // The machine's own files are untouched.
        assert.match(readFileSync(join(l.native, 'auth.json'), 'utf8'), /oauth/)
        assert.match(
            readFileSync(join(l.native, 'models.json'), 'utf8'),
            /MACHINE_KEY/
        )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('the view is rebuilt at every start: no stale entry, sign-in or override survives', () => {
    const l = lab()
    try {
        const models = buildPiModelsJson('openai', 'https://gw.example/v1')!
        assert.equal(
            run(l, { MF_PI_VIEW: 'art_test', MF_PI_MODELS_JSON: models })
                .status,
            0
        )
        const view = viewOf(l)
        // Between two turns: a TUI signed in through the view, pi left a log
        // and a lock behind, and the machine dropped one of its entries.
        writeFileSync(join(view, 'auth.json'), '{"openai":{"type":"oauth"}}')
        writeFileSync(join(view, 'pi-debug.log'), 'log')
        mkdirSync(join(view, 'auth.json.lock'))
        rmSync(join(l.native, 'trust.json'))
        writeFileSync(join(l.native, 'keybindings.json'), '{}')

        const out = run(l, { MF_PI_VIEW: 'art_test' })
        assert.equal(out.status, 0, out.stderr)
        assert.equal(readFileSync(join(view, 'auth.json'), 'utf8'), '{}')
        assert.equal(existsSync(join(view, 'models.json')), false)
        assert.equal(existsSync(join(view, 'pi-debug.log')), false)
        // Gone from the machine, so gone from the view — but still the path a
        // trust decision made through the view is written to.
        assert.equal(existsSync(join(view, 'trust.json')), false)
        assert.equal(
            readlinkSync(join(view, 'trust.json')),
            join(l.native, 'trust.json')
        )
        assert.equal(
            readlinkSync(join(view, 'keybindings.json')),
            join(l.native, 'keybindings.json')
        )
        // A live pi holds its locks; the rebuild never takes one away.
        assert.equal(existsSync(join(view, 'auth.json.lock')), true)
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

// herdr runs pi by name, so for a herdr pane the view is built on its own:
// asked to prepare only, the script prints the view and stops short of pi.
// Its path then turns the resume into the plain `pi …` herdr starts.
test('a prepare-only run builds the view, prints it and never starts pi', () => {
    const l = lab()
    try {
        const models = buildPiModelsJson('anthropic', 'https://gw.example')!
        const exec = piPlatformExec({
            piArgs: ['--session-id', 'ref-1', '--approve'],
            runtimeId: 'art_test',
            provider: 'anthropic',
            apiKey: 'sk-bound',
            baseUrl: 'https://gw.example'
        })
        const prepare = piPlatformViewPrepare(exec.env)
        // Nothing secret goes into the prepare.
        assert.equal(prepare.env.ANTHROPIC_API_KEY, undefined)
        const out = spawnSync(prepare.cmd[0], prepare.cmd.slice(1), {
            env: {
                HOME: l.home,
                PATH: `${l.bin}:/usr/bin:/bin`,
                ...prepare.env
            },
            encoding: 'utf8'
        })
        assert.equal(out.status, 0, out.stderr)
        const view = viewOf(l)
        assert.equal(out.stdout, `${view}\n`)
        assert.equal(existsSync(join(l.home, 'pi-saw.txt')), false)
        assert.equal(readFileSync(join(view, 'auth.json'), 'utf8'), '{}')
        assert.equal(readFileSync(join(view, 'models.json'), 'utf8'), models)

        const direct = piPlatformDirect(
            { command: exec.cmd, env: exec.env },
            out.stdout.trim()
        )
        assert.deepEqual(direct.command, [
            'pi',
            '--session-id',
            'ref-1',
            '--approve'
        ])
        assert.equal(direct.env.PI_CODING_AGENT_DIR, view)
        assert.equal(direct.env.ANTHROPIC_API_KEY, 'sk-bound')
        assert.equal(direct.env.PI_OFFLINE, '1')
        assert.equal(direct.env.MF_PI_VIEW, undefined)
        assert.equal(direct.env.MF_PI_MODELS_JSON, undefined)
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

// A bare sandbox has no settings.json yet. A TUI that changes a setting
// through the view must change the machine's, or the next start clears it.
test('a first settings or trust write through the view lands in the machine dir', () => {
    const l = lab()
    try {
        rmSync(join(l.native, 'settings.json'))
        rmSync(join(l.native, 'trust.json'))
        assert.equal(run(l, { MF_PI_VIEW: 'art_test' }).status, 0)
        const view = viewOf(l)
        writeFileSync(join(view, 'settings.json'), '{"theme":"light"}')
        writeFileSync(join(view, 'trust.json'), '{"/w":true}')
        assert.equal(
            readFileSync(join(l.native, 'settings.json'), 'utf8'),
            '{"theme":"light"}'
        )
        assert.equal(
            readFileSync(join(l.native, 'trust.json'), 'utf8'),
            '{"/w":true}'
        )
        assert.equal(run(l, { MF_PI_VIEW: 'art_test' }).status, 0)
        assert.equal(
            readlinkSync(join(view, 'settings.json')),
            join(l.native, 'settings.json')
        )
        assert.equal(
            readFileSync(join(view, 'settings.json'), 'utf8'),
            '{"theme":"light"}'
        )
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('the view follows a relocated agent dir, keeps pi exit codes and refuses a bad view id', () => {
    const l = lab()
    try {
        const custom = join(l.home, 'custom-pi')
        mkdirSync(custom)
        writeFileSync(join(custom, 'settings.json'), '{}')
        const out = run(l, {
            MF_PI_VIEW: 'art_test',
            PI_CODING_AGENT_DIR: '~/custom-pi',
            FAKE_PI_EXIT: '3'
        })
        assert.equal(out.status, 3)
        assert.equal(
            readlinkSync(join(viewOf(l), 'settings.json')),
            join(custom, 'settings.json')
        )
        // pi writes transcripts under the relocated dir, where the reader
        // resolves them from the same variable.
        assert.equal(existsSync(join(custom, 'sessions')), true)

        for (const bad of ['', '../x', 'a b'])
            assert.equal(run(l, { MF_PI_VIEW: bad }).status, 64, bad)
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

// Two turns on one runtime can start at the same moment; all of them must
// get pi, even when every one of them finds the same entries to replace.
test('concurrent starts of one runtime all reach pi', async () => {
    const l = lab()
    try {
        const models = buildPiModelsJson('anthropic', 'https://gw.example')!
        const view = viewOf(l)
        mkdirSync(join(view, 'skills'), { recursive: true })
        writeFileSync(join(view, 'trust.json'), 'real file')
        symlinkSync('/nonexistent', join(view, 'settings.json'))
        const codes = await Promise.all(
            Array.from(
                { length: 8 },
                () =>
                    new Promise<number | null>((resolve) => {
                        const child = spawn(
                            'bash',
                            ['-c', PI_PLATFORM_VIEW_SCRIPT, 'pi'],
                            {
                                env: {
                                    HOME: l.home,
                                    PATH: `${l.bin}:/usr/bin:/bin`,
                                    MF_PI_VIEW: 'art_test',
                                    MF_PI_MODELS_JSON: models
                                },
                                stdio: ['pipe', 'ignore', 'ignore']
                            }
                        )
                        child.stdin.end('x')
                        child.on('close', resolve)
                    })
            )
        )
        assert.deepEqual(codes, Array(8).fill(0))
        assert.equal(readFileSync(join(view, 'models.json'), 'utf8'), models)
        for (const name of ['skills', 'trust.json', 'settings.json'])
            assert.equal(
                readlinkSync(join(view, name)),
                join(l.native, name),
                name
            )
        // A link made over one another start just made must not land inside
        // the directory it points at — that is the machine's own.
        assert.equal(existsSync(join(l.native, 'skills', 'skills')), false)
        assert.equal(existsSync(join(l.native, 'sessions', 'sessions')), false)
    } finally {
        rmSync(l.root, { recursive: true, force: true })
    }
})

test('the platform exec runs pi through the view, with the key in env and nothing ahead of it', () => {
    const exec = piPlatformExec({
        piArgs: ['--mode', 'json'],
        runtimeId: 'art_abc',
        provider: 'google',
        apiKey: 'goog-key',
        baseUrl: 'https://gw.example/google'
    })
    assert.deepEqual(exec.cmd, [
        'bash',
        '-c',
        PI_PLATFORM_VIEW_SCRIPT,
        'pi',
        '--mode',
        'json'
    ])
    assert.equal(exec.env.MF_PI_VIEW, 'art_abc')
    assert.equal(exec.env.GEMINI_API_KEY, 'goog-key')
    assert.equal(exec.env.PI_OFFLINE, '1')
    assert.deepEqual(JSON.parse(exec.env.MF_PI_MODELS_JSON), {
        providers: { google: { baseUrl: 'https://gw.example/google/v1beta' } }
    })
    // The official endpoint needs no override; an anthropic key also blanks
    // the tokens pi would read before it.
    assert.deepEqual(
        piPlatformExec({
            piArgs: [],
            runtimeId: 'art_abc',
            provider: 'anthropic',
            apiKey: 'ant-key',
            baseUrl: null
        }).env,
        {
            PI_OFFLINE: '1',
            MF_PI_VIEW: 'art_abc',
            ANTHROPIC_AUTH_TOKEN: '',
            ANTHROPIC_OAUTH_TOKEN: '',
            ANTHROPIC_API_KEY: 'ant-key'
        }
    )
})

test('the sandbox agent dir only ever gets the quiet banner', () => {
    const script = piAgentDirSetupScript()
    assert.match(script, /^set -eu\nmkdir -p "\$HOME\/\.pi\/agent"\n/)
    assert.match(script, /"quietStartup": true/)
    assert.ok(!script.includes('models.json'))
})

// pi runs offline in every exec, so it never fetches fd and ripgrep itself;
// the sandbox setup installs them from the package manager. Run for real in
// bash, with sudo and apt-get stood in for, over three sandboxes: one that
// has both, one whose package lists need an update first, and one where
// sudo is refused.
test('the sandbox setup installs fd and ripgrep once, and never fails over them', () => {
    const sandbox = (opts: {
        rg: boolean
        sudo: 'ok' | 'stale' | 'refused'
    }) => {
        const root = mkdtempSync(join(tmpdir(), 'mf-pi-tools-'))
        const home = join(root, 'home')
        const bin = join(root, 'bin')
        mkdirSync(home, { recursive: true })
        mkdirSync(bin, { recursive: true })
        const log = join(root, 'sudo.log')
        if (opts.rg)
            for (const tool of ['rg', 'fdfind']) {
                writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n')
                chmodSync(join(bin, tool), 0o755)
            }
        // `apt-get install` succeeds only after an update when the lists are
        // stale, and "installs" by dropping the two binaries on PATH.
        writeFileSync(
            join(bin, 'sudo'),
            [
                '#!/bin/sh',
                `echo "$*" >> '${log}'`,
                ...(opts.sudo === 'refused' ? ['exit 1'] : []),
                'case "$*" in',
                `  *"apt-get update"*) touch '${root}/updated'; exit 0 ;;`,
                `  *"apt-get install"*) ${opts.sudo === 'stale' ? `[ -f '${root}/updated' ] || exit 100; ` : ''}for t in rg fdfind; do printf '#!/bin/sh\\nexit 0\\n' > '${bin}'/$t; chmod +x '${bin}'/$t; done ;;`,
                'esac'
            ].join('\n')
        )
        chmodSync(join(bin, 'sudo'), 0o755)
        // Not a login shell: a macOS /etc/profile would put Homebrew's own
        // rg and fd back on PATH.
        const out = spawnSync('bash', ['-c', piAgentDirSetupScript()], {
            env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
            encoding: 'utf8'
        })
        const calls = existsSync(log)
            ? readFileSync(log, 'utf8').trim().split('\n')
            : []
        const settings = readFileSync(
            join(home, '.pi', 'agent', 'settings.json'),
            'utf8'
        )
        rmSync(root, { recursive: true, force: true })
        return { out, calls, settings }
    }

    const ready = sandbox({ rg: true, sudo: 'ok' })
    assert.equal(ready.out.status, 0)
    assert.deepEqual(ready.calls, [])

    const stale = sandbox({ rg: false, sudo: 'stale' })
    assert.equal(stale.out.status, 0, stale.out.stderr)
    assert.equal(stale.calls.length, 3)
    assert.match(
        stale.calls[0],
        /-n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep fd-find/
    )
    assert.match(stale.calls[1], /apt-get update/)
    assert.match(stale.calls[2], /apt-get install/)
    assert.equal(stale.out.stderr, '')

    const refused = sandbox({ rg: false, sudo: 'refused' })
    assert.equal(refused.out.status, 0)
    assert.match(refused.out.stderr, /fd and ripgrep could not be installed/)
    assert.match(refused.settings, /"quietStartup": true/)
})
