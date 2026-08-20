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
import { buildUnshadowActivationShell } from '../src/modules/framework-versions/framework-version-registry'

// The image's nvm activation shim prepends node's own bin dir to PATH from
// inside a `#!/usr/bin/env node` binary's startup, so an image-baked CLI of the
// same name there beats the activation for the CLI and for every tool child it
// spawns (#611 AC-1). These exercise the neutralisation in real bash against a
// fake node/npm so the discovery step is driven, not stubbed out.
const fragment = buildUnshadowActivationShell('gemini')

const TOOLCHAIN = ['node', 'npm', 'npx', 'corepack']

interface Sandbox {
    home: string
    nodeBin: string
    npmPrefix: string
}

const withSandbox = (fn: (box: Sandbox) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'mf-unshadow-'))
    try {
        const home = join(root, 'home')
        const nodeBin = join(root, 'nvm/versions/node/v22.20.0/bin')
        const npmPrefix = join(root, 'nvm/versions/node/v22.20.0')
        const fakeBin = join(root, 'fake-bin')
        mkdirSync(join(home, '.local/bin'), { recursive: true })
        mkdirSync(nodeBin, { recursive: true })
        mkdirSync(fakeBin, { recursive: true })
        for (const name of TOOLCHAIN)
            writeFileSync(join(nodeBin, name), `image ${name}\n`, {
                mode: 0o755
            })
        // `node -p ...` and `npm prefix -g` are the discovery step; a fake that
        // ignores its arguments keeps the test off the runner's real toolchain.
        writeFileSync(
            join(fakeBin, 'node'),
            '#!/bin/sh\nprintf "%s\\n" "$MF_TEST_NODE_BIN"\n',
            { mode: 0o755 }
        )
        writeFileSync(
            join(fakeBin, 'npm'),
            '#!/bin/sh\nprintf "%s\\n" "$MF_TEST_NPM_PREFIX"\n',
            { mode: 0o755 }
        )
        fn({ home, nodeBin, npmPrefix })
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

const run = (
    box: Sandbox,
    over: { nodeBin?: string; npmPrefix?: string } = {}
): void => {
    const fakeBin = join(box.home, '..', 'fake-bin')
    execFileSync(
        'bash',
        ['--noprofile', '--norc', '-c', ['set -eu', fragment].join('\n')],
        {
            encoding: 'utf8',
            env: {
                PATH: `${fakeBin}:/usr/bin:/bin`,
                HOME: box.home,
                MF_TEST_NODE_BIN: over.nodeBin ?? box.nodeBin,
                MF_TEST_NPM_PREFIX: over.npmPrefix ?? box.npmPrefix
            }
        }
    )
}

test('an image-baked CLI in node bin dir is moved out of the way', () => {
    withSandbox((box) => {
        writeFileSync(join(box.nodeBin, 'gemini'), 'image 0.53.0\n', {
            mode: 0o755
        })
        run(box)
        assert.equal(existsSync(join(box.nodeBin, 'gemini')), false)
        assert.equal(
            readFileSync(join(box.nodeBin, 'gemini.mf-shadowed'), 'utf8'),
            'image 0.53.0\n'
        )
    })
})

// Everything node itself needs stays exactly where npm expects it; the step
// only ever names the one binary the install just activated.
test('the node toolchain is never touched', () => {
    withSandbox((box) => {
        writeFileSync(join(box.nodeBin, 'gemini'), 'image 0.53.0\n')
        run(box)
        for (const name of TOOLCHAIN) {
            assert.equal(
                readFileSync(join(box.nodeBin, name), 'utf8'),
                `image ${name}\n`
            )
            assert.equal(
                existsSync(join(box.nodeBin, `${name}.mf-shadowed`)),
                false
            )
        }
    })
})

// Fresh images ship a nvm prefix holding only the toolchain, which is the only
// reason they pass today — the step has to be a clean no-op there.
test('an absent entry is a no-op, and a repeat run is too', () => {
    withSandbox((box) => {
        run(box)
        assert.equal(existsSync(join(box.nodeBin, 'gemini.mf-shadowed')), false)
        writeFileSync(join(box.nodeBin, 'gemini'), 'image 0.53.0\n')
        run(box)
        run(box)
        assert.equal(
            readFileSync(join(box.nodeBin, 'gemini.mf-shadowed'), 'utf8'),
            'image 0.53.0\n'
        )
        assert.equal(existsSync(join(box.nodeBin, 'gemini')), false)
    })
})

// The activation dir is the one place the name must survive: on an image whose
// node lives in ~/.local/bin the step would otherwise delete the binary the
// install just committed.
test('the activation dir is never displaced', () => {
    withSandbox((box) => {
        const activation = join(box.home, '.local/bin')
        writeFileSync(join(activation, 'gemini'), 'activated 0.54.4\n')
        run(box, { nodeBin: activation, npmPrefix: box.home })
        assert.equal(
            readFileSync(join(activation, 'gemini'), 'utf8'),
            'activated 0.54.4\n'
        )
    })
})

// nvm puts both in the same place, but a non-nvm image can configure a global
// prefix elsewhere and bake the CLI there instead.
test('a global npm prefix outside node bin dir is covered too', () => {
    withSandbox((box) => {
        const other = join(box.home, '..', 'npm-global')
        mkdirSync(join(other, 'bin'), { recursive: true })
        writeFileSync(join(other, 'bin/gemini'), 'image 0.53.0\n')
        run(box, { npmPrefix: other })
        assert.equal(existsSync(join(other, 'bin/gemini')), false)
        assert.ok(existsSync(join(other, 'bin/gemini.mf-shadowed')))
    })
})

// An image without a resolvable node is not one this step has an opinion
// about; it must exit 0 and change nothing rather than fail the upgrade.
test('a missing node or npm leaves the step a silent no-op', () => {
    const bash = execFileSync('sh', ['-c', 'command -v bash'], {
        encoding: 'utf8'
    }).trim()
    withSandbox((box) => {
        writeFileSync(join(box.nodeBin, 'gemini'), 'image 0.53.0\n')
        execFileSync(
            bash,
            ['--noprofile', '--norc', '-c', ['set -eu', fragment].join('\n')],
            {
                encoding: 'utf8',
                env: { PATH: join(box.home, 'empty'), HOME: box.home }
            }
        )
        assert.ok(existsSync(join(box.nodeBin, 'gemini')))
    })
})

test('the generated fragment is valid POSIX sh and bash', () => {
    for (const shell of ['bash', 'sh'])
        execFileSync(shell, ['-n'], { input: fragment })
})
