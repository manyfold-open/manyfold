import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    extractUpdateBinary,
    replaceExecutable,
    resolveUpdateTarget
} from '../src/self-update'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const match = /^bun-(linux|darwin|windows)-(x64|arm64)$/.exec(
    process.argv[2] ?? ''
)
assert.ok(match, 'expected a release target')
const [, os, arch] = match
const platform = os === 'windows' ? 'win32' : os
const target = resolveUpdateTarget(platform as NodeJS.Platform, arch)
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = process.env.MF_CLI_VERSION || pkg.version
const archive = join(
    root,
    'dist-bin',
    `mf-${version}-${os}-${arch}.${target.archiveFormat}`
)
const bytes = await readFile(archive)
const hash = createHash('sha256').update(bytes).digest('hex')
assert.equal((await readFile(`${archive}.sha256`, 'utf8')).split(/\s/)[0], hash)
const binary = extractUpdateBinary(bytes, target)
assert.deepEqual(
    binary,
    await readFile(join(root, 'dist-bin', target.binaryName))
)
const directory = await mkdtemp(join(tmpdir(), 'mf-artifact-verify-'))
let signing: string | undefined
try {
    const installed = join(directory, target.binaryName)
    const downloaded = join(directory, 'downloaded')
    await writeFile(installed, 'previous fixture version', { mode: 0o755 })
    await writeFile(downloaded, binary, { mode: 0o755 })
    await replaceExecutable(downloaded, installed, {
        platform: process.platform
    })
    assert.deepEqual(await readFile(installed), binary)
    if (os === 'darwin') {
        execFileSync('codesign', [
            '--verify',
            '--strict',
            '-R',
            '=identifier "ai.manyfold.mf"',
            installed
        ])
        const display = spawnSync('codesign', ['-dvv', '-r-', installed], {
            encoding: 'utf8'
        })
        assert.equal(display.status, 0)
        signing = display.stderr + display.stdout
        const tampered = join(directory, 'tampered')
        const corrupt = Buffer.from(binary)
        corrupt[Math.floor(corrupt.length / 2)] ^= 1
        await writeFile(tampered, corrupt, { mode: 0o755 })
        assert.throws(() =>
            execFileSync('codesign', ['--verify', '--strict', tampered], {
                stdio: 'pipe'
            })
        )
    }
    if (platform === process.platform && arch === process.arch) {
        const output = execFileSync(installed, ['version', '--json'], {
            encoding: 'utf8',
            timeout: 10_000,
            env: {
                PATH: process.env.PATH,
                SystemRoot: process.env.SystemRoot,
                HOME: directory,
                MF_CONFIG_DIR: directory,
                MF_PROFILE: 'artifact',
                MF_DAEMON_AUTO_UPDATE: '0'
            }
        })
        const info = JSON.parse(output)
        assert.equal(info.version, version)
        assert.equal(info.bakedChannel, process.env.MF_CLI_CHANNEL || 'stable')
    }
    console.log(
        JSON.stringify({
            verified: true,
            os,
            arch,
            version,
            channel: process.env.MF_CLI_CHANNEL || 'stable',
            archiveSha256: hash,
            binarySha256: createHash('sha256').update(binary).digest('hex'),
            signing
        })
    )
} finally {
    await rm(directory, { recursive: true, force: true })
}
