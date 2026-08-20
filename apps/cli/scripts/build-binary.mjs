#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process'
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
    createReadStream
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
const distEntry = join(pkgDir, 'dist', 'index.js')
const outDir = join(pkgDir, 'dist-bin')

const TARGETS = {
    'bun-linux-x64': { os: 'linux', arch: 'x64', ext: 'tar.gz', exe: 'mf' },
    'bun-linux-arm64': {
        os: 'linux',
        arch: 'arm64',
        ext: 'tar.gz',
        exe: 'mf'
    },
    'bun-darwin-x64': { os: 'darwin', arch: 'x64', ext: 'tar.gz', exe: 'mf' },
    'bun-darwin-arm64': {
        os: 'darwin',
        arch: 'arm64',
        ext: 'tar.gz',
        exe: 'mf'
    },
    'bun-windows-x64': {
        os: 'windows',
        arch: 'x64',
        ext: 'zip',
        exe: 'mf.exe'
    }
}

const fail = (msg) => {
    console.error(`build-binary: ${msg}`)
    process.exit(1)
}

const target = process.argv[2]
if (!target)
    fail(
        `usage: build-binary.mjs <target>\n  targets: ${Object.keys(TARGETS).join(' ')}`
    )
const cfg = TARGETS[target]
if (!cfg)
    fail(
        `unknown target "${target}"\n  valid: ${Object.keys(TARGETS).join(' ')}`
    )

if (!existsSync(distEntry))
    fail(`missing ${distEntry} — run "pnpm build" first`)

// Bun.Terminal (the daemon pty backend) needs the embedded runtime >= 1.3.5
const MIN_BUN_VERSION = [1, 3, 5]
const bunVersion = execFileSync('bun', ['--version']).toString().trim()
const bunParts = bunVersion.split('.').map((part) => parseInt(part, 10) || 0)
const versionDelta = MIN_BUN_VERSION.reduce(
    (delta, min, i) => (delta !== 0 ? delta : (bunParts[i] ?? 0) - min),
    0
)
if (versionDelta < 0)
    fail(
        `bun ${bunVersion} is too old — need >= ${MIN_BUN_VERSION.join('.')} for Bun.Terminal pty support`
    )

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const version = process.env.MF_CLI_VERSION || pkg.version
const channel = process.env.MF_CLI_CHANNEL || 'stable'

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const exePath = join(outDir, cfg.exe)
console.log(`build-binary: bun --compile target=${target} → ${exePath}`)
execFileSync(
    'bun',
    [
        'build',
        '--compile',
        `--target=${target}`,
        '--minify',
        '--bytecode',
        '--sourcemap',
        `--outfile=${exePath}`,
        distEntry
    ],
    { stdio: 'inherit', cwd: pkgDir }
)
if (!existsSync(exePath)) fail(`bun did not produce ${exePath}`)

const packageAsset = async (binName, assetBase) => {
    const assetName = `${assetBase}.${cfg.ext}`
    const assetPath = join(outDir, assetName)

    if (cfg.ext === 'tar.gz') {
        execFileSync('tar', ['-czf', assetPath, '-C', outDir, binName], {
            stdio: 'inherit'
        })
    } else {
        const binPath = join(outDir, binName)
        if (process.platform === 'win32')
            execSync(
                `powershell -NoProfile -Command "Compress-Archive -Path '${binPath}' -DestinationPath '${assetPath}'"`,
                { stdio: 'inherit' }
            )
        else
            execFileSync('zip', ['-j', assetPath, binPath], {
                stdio: 'inherit'
            })
    }
    if (!existsSync(assetPath)) fail(`packaging failed: ${assetPath} missing`)

    const hash = await new Promise((resolveHash, rejectHash) => {
        const h = createHash('sha256')
        const stream = createReadStream(assetPath)
        stream.on('data', (chunk) => h.update(chunk))
        stream.on('end', () => resolveHash(h.digest('hex')))
        stream.on('error', rejectHash)
    })
    writeFileSync(`${assetPath}.sha256`, `${hash}  ${assetName}\n`)

    const sizeKb = Math.round(
        execFileSync('wc', ['-c', assetPath])
            .toString()
            .trim()
            .split(/\s+/)[0] / 1024
    )
    console.log(
        `build-binary: ✓ ${assetName} (${sizeKb} KB)  sha256=${hash.slice(0, 12)}…`
    )
}

await packageAsset(cfg.exe, `mf-${version}-${cfg.os}-${cfg.arch}`)

// Pre-rename binaries self-update by downloading `nca-<ver>-<os>-<arch>.tar.gz`
// and expect an inner binary named `nca`. Keep publishing that shape so
// `nca update` still lands users on the renamed CLI. Drop once the old
// installed base is gone. The staging channel has no legacy installed base.
if (cfg.ext === 'tar.gz' && channel !== 'staging') {
    copyFileSync(exePath, join(outDir, 'nca'))
    await packageAsset('nca', `nca-${version}-${cfg.os}-${cfg.arch}`)
}
