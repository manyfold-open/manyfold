import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readlinkSync,
    rmSync,
    utimesSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    buildNpmLatestInstallShell,
    buildNpmUpgradeShell,
    frameworkVersionDescriptor
} from '../src/modules/framework-versions/framework-version-registry'

// These run the real install shell against a fake npm. The shell is written
// for the hosted machines (GNU coreutils: `mv -T`), so it runs on Linux only.
const linuxOnly = { skip: process.platform !== 'linux' }

// Stands in for `npm install -g --prefix <dir> <pkg>@<spec>`: the manifest
// first, then FAKE_NPM_SLEEP seconds, then the rest of the package and its
// bin, creating directories again as npm's extraction does, so a staging dir
// deleted under it comes back without what it had already written.
const FAKE_NPM = `#!/bin/sh
case "$1" in
  install)
    shift
    prefix=""; spec=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --prefix) prefix="$2"; shift 2 ;;
        -g|--allow-scripts=*) shift ;;
        *) spec="$1"; shift ;;
      esac
    done
    pkg="\${spec%@*}"
    dir="$prefix/lib/node_modules/$pkg"
    mkdir -p "$dir"
    [ -n "\${FAKE_NPM_NO_MANIFEST:-}" ] || printf '{"name":"%s","version":"%s"}\\n' "$pkg" "$FAKE_NPM_VERSION" > "$dir/package.json"
    sleep "\${FAKE_NPM_SLEEP:-0}"
    mkdir -p "$dir/dist" "$prefix/bin"
    i=0
    while [ $i -lt 20 ]; do echo x > "$dir/dist/f$i.js"; i=$((i + 1)); done
    printf '#!/bin/sh\\necho %s\\n' "$FAKE_NPM_VERSION" > "$dir/cli.js"
    chmod +x "$dir/cli.js"
    ln -sf "$dir/cli.js" "$prefix/bin/openclaw"
    ;;
  root)
    while [ $# -gt 0 ]; do
      case "$1" in --prefix) echo "$2/lib/node_modules"; exit 0 ;; *) shift ;; esac
    done
    ;;
esac
`

interface Box {
    dir: string
    home: string
    bin: string
    root: string
}

const withBox = async (fn: (box: Box) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-install-race-'))
    const box = {
        dir,
        home: join(dir, 'home'),
        bin: join(dir, 'bin'),
        root: join(dir, 'home', '.local', 'lib', 'manyfold', 'openclaw')
    }
    mkdirSync(box.home)
    mkdirSync(box.bin)
    writeFileSync(join(box.bin, 'npm'), FAKE_NPM)
    chmodSync(join(box.bin, 'npm'), 0o755)
    try {
        await fn(box)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

const install = (
    box: Box,
    shell: string,
    env: Record<string, string>
): Promise<{ code: number; stderr: string }> =>
    new Promise((resolve) => {
        const child = spawn('bash', ['--noprofile', '--norc', '-s'], {
            env: {
                ...process.env,
                HOME: box.home,
                PATH: `${box.bin}:${process.env.PATH}`,
                ...env
            }
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => {
            stderr += chunk
        })
        child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
        child.stdin.end(shell)
    })

const stagingDirs = (box: Box): string[] =>
    existsSync(box.root)
        ? readdirSync(box.root).filter((name) => /^install\.[^.]+$/.test(name))
        : []

const waitFor = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 250 && !check(); i += 1)
        await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(check(), 'condition not reached')
}

// The directory PATH resolves `openclaw` into: <staging>/bin/openclaw.
const linkedPackage = (box: Box): string =>
    join(
        readlinkSync(join(box.home, '.local', 'bin', 'openclaw')).replace(
            /\/bin\/openclaw$/,
            ''
        ),
        'lib',
        'node_modules',
        'openclaw'
    )

const openclaw = frameworkVersionDescriptor('openclaw')

// Seen on staging [2026-10-07]: an unpinned retry ran beside a pinned
// openclaw install. The first to finish deleted the other's staging dir mid-
// extract, the other recreated its directories and went on PATH without its
// manifest or half its files, and the gateway could not start.
test('an install that starts while another extracts never leaves PATH on a broken package', linuxOnly, async () => {
    await withBox(async (box) => {
        const slow = install(box, buildNpmLatestInstallShell(openclaw), {
            FAKE_NPM_VERSION: '2026.9.8',
            FAKE_NPM_SLEEP: '2'
        })
        await waitFor(() => stagingDirs(box).length === 1)
        const fast = install(box, buildNpmUpgradeShell(openclaw, '2026.9.8'), {
            FAKE_NPM_VERSION: '2026.9.8',
            FAKE_NPM_SLEEP: '0'
        })
        const [first, second] = await Promise.all([slow, fast])
        assert.equal(first.code, 0, first.stderr)
        assert.equal(second.code, 0, second.stderr)
        const pkg = linkedPackage(box)
        assert.ok(existsSync(join(pkg, 'package.json')), 'the package on PATH has its manifest')
        assert.equal(readdirSync(join(pkg, 'dist')).length, 20, 'and all of its files')
    })
})

test('a package that comes out of npm without its manifest never reaches PATH', linuxOnly, async () => {
    await withBox(async (box) => {
        const result = await install(box, buildNpmLatestInstallShell(openclaw), {
            FAKE_NPM_VERSION: '2026.9.8',
            FAKE_NPM_NO_MANIFEST: '1'
        })
        assert.equal(result.code, 1)
        assert.match(result.stderr, /no readable manifest/)
        assert.equal(existsSync(join(box.home, '.local', 'bin', 'openclaw')), false)
        assert.deepEqual(stagingDirs(box), [], 'the failed staging dir is removed')
    })
})

test('an install removes the installs it superseded, never one young enough to be running', linuxOnly, async () => {
    await withBox(async (box) => {
        mkdirSync(join(box.root, 'install.oldAAAA'), { recursive: true })
        mkdirSync(join(box.root, 'install.newBBBB'), { recursive: true })
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
        utimesSync(join(box.root, 'install.oldAAAA'), twoHoursAgo, twoHoursAgo)

        const result = await install(box, buildNpmUpgradeShell(openclaw, '2026.9.8'), {
            FAKE_NPM_VERSION: '2026.9.8'
        })

        assert.equal(result.code, 0, result.stderr)
        const left = stagingDirs(box)
        assert.equal(left.includes('install.oldAAAA'), false, 'a stale install is removed')
        assert.equal(left.includes('install.newBBBB'), true, 'a young one may still be extracting')
        assert.ok(existsSync(join(linkedPackage(box), 'package.json')))
    })
})
