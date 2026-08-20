import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManagedPathScript, MANAGED_PATH_BLOCK } from '../src/exec-env'

const script = buildManagedPathScript()

const withTempHome = (fn: (home: string) => void): void => {
    const home = mkdtempSync(join(tmpdir(), 'mf-path-'))
    try {
        fn(home)
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
}

// /etc/profile.d is not writable from a test runner, which is also a sprite
// shape we must survive: the home-file writes are the channel that always
// exists, so everything below exercises that channel.
const runShell = (home: string, lines: string[]): string =>
    execFileSync(
        'bash',
        ['--noprofile', '--norc', '-c', ['set -eu', ...lines].join('\n')],
        { encoding: 'utf8', env: { ...process.env, HOME: home } }
    ).trimEnd()

const countBlocks = (text: string): number =>
    text.split('# mf-path-start').length - 1

test('the managed block puts the activation dir at the front of PATH', () => {
    withTempHome((home) => {
        const out = runShell(home, [
            'PATH=/image/node/bin:/usr/bin',
            'export PATH',
            MANAGED_PATH_BLOCK,
            'printf "%s\\n" "$PATH"'
        ])
        assert.equal(out, `${home}/.local/bin:/image/node/bin:/usr/bin`)
    })
})

// profile.d, ~/.bashrc and the exec wrapper all run this block on a single
// login+interactive shell. A blind prepend would grow PATH once per source.
test('the managed block is a no-op once the activation dir is first', () => {
    withTempHome((home) => {
        const out = runShell(home, [
            'PATH=/image/node/bin:/usr/bin',
            'export PATH',
            MANAGED_PATH_BLOCK,
            MANAGED_PATH_BLOCK,
            MANAGED_PATH_BLOCK,
            'printf "%s\\n" "$PATH"'
        ])
        assert.equal(out, `${home}/.local/bin:/image/node/bin:/usr/bin`)
    })
})

test('the managed block re-takes the front after something else prepends', () => {
    withTempHome((home) => {
        const out = runShell(home, [
            'PATH=/usr/bin',
            'export PATH',
            MANAGED_PATH_BLOCK,
            'PATH=/image/node/bin:$PATH',
            MANAGED_PATH_BLOCK,
            'printf "%s\\n" "$PATH"'
        ])
        assert.equal(out.split(':')[0], `${home}/.local/bin`)
    })
})

// The whole #611 mechanism: /etc/profile sources profile.d in glob order, so a
// fragment named `mf.sh` runs before the image's node fragment and loses. The
// managed fragment has to sort after anything the image is plausibly named.
test('the profile.d fragment sorts after image-owned fragments', () => {
    const match = script.match(/\/etc\/profile\.d\/([^\s]+\.sh)/)
    assert.ok(match, 'no profile.d fragment is installed')
    const name = match[1]
    for (const imageFragment of ['nvm.sh', 'node.sh', 'npm.sh', 'sprite.sh'])
        assert.ok(
            name > imageFragment,
            `${name} sorts before ${imageFragment}, so the image would win`
        )
})

test('the script appends the block after image content and never duplicates it', () => {
    withTempHome((home) => {
        writeFileSync(join(home, '.bashrc'), '# image bashrc\n')
        runShell(home, [script])
        runShell(home, [script])
        const bashrc = readFileSync(join(home, '.bashrc'), 'utf8')
        assert.equal(countBlocks(bashrc), 1)
        assert.ok(
            bashrc.indexOf('# image bashrc') < bashrc.indexOf('# mf-path-start')
        )
        assert.equal(
            countBlocks(readFileSync(join(home, '.profile'), 'utf8')),
            1
        )
    })
})

// bash reads only the FIRST of ~/.bash_profile / ~/.bash_login / ~/.profile on
// login, so an image that ships ~/.bash_profile makes the ~/.profile write dead
// code — and creating one would be worse, since it would stop the image's own
// ~/.profile from being read at all.
test('the script refreshes existing login files and creates none', () => {
    withTempHome((home) => {
        writeFileSync(
            join(home, '.bash_profile'),
            'export PATH="$HOME/image-bin:$PATH"\n'
        )
        runShell(home, [script])
        const loginFile = readFileSync(join(home, '.bash_profile'), 'utf8')
        assert.equal(countBlocks(loginFile), 1)
        assert.ok(
            loginFile.indexOf('image-bin') <
                loginFile.indexOf('# mf-path-start')
        )
        assert.equal(existsSync(join(home, '.bash_login')), false)
    })
    withTempHome((home) => {
        runShell(home, [script])
        assert.equal(existsSync(join(home, '.bash_profile')), false)
        assert.equal(existsSync(join(home, '.bash_login')), false)
        assert.equal(existsSync(join(home, '.zshrc')), false)
    })
})

// The reported symptom, reproduced end to end at the profile layer: an image
// login profile that puts its own global bin first, a denylisted 0.53.0 there,
// and the Manyfold activation symlink in ~/.local/bin. Before the fix the login
// shell resolves 0.53.0 while the platform reports 0.54.4 (#611, #594).
test('a login shell resolves the activated binary, not the image-baked one', () => {
    withTempHome((home) => {
        mkdirSync(join(home, '.local/bin'), { recursive: true })
        mkdirSync(join(home, 'image-bin'), { recursive: true })
        writeFileSync(
            join(home, '.local/bin/gemini'),
            '#!/bin/sh\necho 0.54.4\n',
            { mode: 0o755 }
        )
        writeFileSync(
            join(home, 'image-bin/gemini'),
            '#!/bin/sh\necho 0.53.0\n',
            { mode: 0o755 }
        )
        writeFileSync(
            join(home, '.bash_profile'),
            'export PATH="$HOME/image-bin:$PATH"\n'
        )
        runShell(home, [script])
        const version = runShell(home, [
            'PATH=/usr/bin:/bin',
            'export PATH',
            '. "$HOME/.bash_profile"',
            'gemini'
        ])
        assert.equal(version, '0.54.4')
    })
})
