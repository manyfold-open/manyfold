import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const sourceRoot = path.resolve(import.meta.dirname, '..')
const installRoot = process.cwd()
// Seen on Node 24.20 [2026-09-17]: 24.19+ headers contain an incomplete
// ObjectWrap cleanup-hook backport (nodejs/node#65446). Keep the Unicode-safe
// 24.20 runtime, but compile test addons with 24.18 headers until that upstream
// fix lands and both the framing and allocation-driven GC probes pass.
const config = JSON.parse(
    fs.readFileSync(path.join(sourceRoot, '.node-test-headers.json'), 'utf8')
)
assert.match(config.version, /^24\.\d+\.\d+$/)
assert.match(config.sha256, /^[a-f0-9]{64}$/)
assert.equal(
    config.version.split('.')[0],
    process.versions.node.split('.')[0],
    'test runtime and native headers must use the same Node major'
)

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const download = async (url, expected, destination) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    assert.equal(response.status, 200, `download failed: ${url}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(sha256(bytes), expected, `checksum mismatch: ${url}`)
    fs.writeFileSync(destination, bytes)
}
const run = (command, args, options) => {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        ...options
    })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert.equal(
        result.status,
        0,
        `${path.basename(command)} failed: ${result.stderr ?? ''}`
    )
    return result
}

const extractionRoot = fs.mkdtempSync(
    path.join(
        process.env.RUNNER_TEMP ?? os.tmpdir(),
        'manyfold-test-native-headers-'
    )
)
try {
    const archive = path.join(
        extractionRoot,
        `node-v${config.version}-headers.tar.gz`
    )
    await download(
        `https://nodejs.org/dist/v${config.version}/node-v${config.version}-headers.tar.gz`,
        config.sha256,
        archive
    )
    run('tar', ['-xzf', archive, '-C', extractionRoot], { timeout: 60_000 })

    const headersRoot = path.join(extractionRoot, `node-v${config.version}`)
    if (process.platform === 'win32') {
        const expected = config.windowsLibraries?.[process.arch]
        assert.match(
            expected ?? '',
            /^[a-f0-9]{64}$/,
            `unsupported Windows architecture: ${process.arch}`
        )
        const library = path.join(headersRoot, 'Release', 'node.lib')
        fs.mkdirSync(path.dirname(library), { recursive: true })
        await download(
            `https://nodejs.org/dist/v${config.version}/win-${process.arch}/node.lib`,
            expected,
            library
        )
    }

    const header = fs.readFileSync(
        path.join(headersRoot, 'include', 'node', 'node_version.h'),
        'utf8'
    )
    const headerAbi = Number(
        header.match(/^#define NODE_MODULE_VERSION (\d+)$/m)?.[1]
    )
    assert.equal(headerAbi, Number(process.versions.modules))

    const npmCli = [
        path.resolve(
            path.dirname(process.execPath),
            '..',
            'lib',
            'node_modules',
            'npm',
            'bin',
            'npm-cli.js'
        ),
        path.resolve(
            path.dirname(process.execPath),
            'node_modules',
            'npm',
            'bin',
            'npm-cli.js'
        )
    ].find((candidate) => fs.existsSync(candidate))
    assert.ok(npmCli, `npm-cli.js not found beside ${process.execPath}`)
    run(
        process.execPath,
        [
            npmCli,
            'rebuild',
            'better-sqlite3',
            'node-pty',
            '--foreground-scripts'
        ],
        {
            cwd: installRoot,
            env: {
                ...process.env,
                npm_config_build_from_source: 'true',
                npm_config_nodedir: headersRoot
            },
            stdio: 'inherit',
            timeout: 300_000,
            killSignal: 'SIGKILL'
        }
    )

    const require = createRequire(path.join(installRoot, 'package.json'))
    for (const name of ['better-sqlite3', 'node-pty']) {
        const packageRoot = path.dirname(require.resolve(`${name}/package.json`))
        const buildConfig = fs.readFileSync(
            path.join(packageRoot, 'build', 'config.gypi'),
            'utf8'
        )
        const parsed = JSON.parse(buildConfig.replace(/^#[^\n]*\n/, ''))
        assert.equal(
            path.resolve(parsed.variables.nodedir),
            path.resolve(headersRoot)
        )
        assert.equal(Number(parsed.variables.node_module_version), headerAbi)
    }

    const Database = require('better-sqlite3')
    const database = new Database(':memory:')
    try {
        database.exec('CREATE TABLE witness (value TEXT NOT NULL)')
        database.prepare('INSERT INTO witness (value) VALUES (?)').run('ready')
        let allocations = []
        for (let i = 0; i < 300_000; i++) {
            database.prepare('SELECT ? AS value').get(i)
            allocations.push({ i })
            if (allocations.length > 1_000) allocations = []
        }
        assert.equal(
            database.prepare('SELECT value FROM witness').get().value,
            'ready'
        )
    } finally {
        database.close()
    }

    const pty = require('node-pty')
    const [command, args] =
        process.platform === 'win32'
            ? [
                  'powershell.exe',
                  [
                      '-NoLogo',
                      '-NoProfile',
                      '-Command',
                      "[Console]::Write('native-pty-ok')"
                  ]
              ]
            : ['/bin/sh', ['-c', 'printf native-pty-ok']]
    await new Promise((resolve, reject) => {
        const child = pty.spawn(command, args, {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: installRoot,
            env: process.env
        })
        let output = ''
        const timeout = setTimeout(() => {
            child.kill()
            reject(new Error('node-pty native probe timed out'))
        }, 10_000)
        child.onData((chunk) => {
            output += chunk
        })
        child.onExit(({ exitCode }) => {
            clearTimeout(timeout)
            try {
                assert.equal(exitCode, 0)
                assert.match(output, /native-pty-ok/)
                resolve()
            } catch (error) {
                reject(error)
            }
        })
    })

    console.log(
        `test-native: runtime ${process.version} ABI ${process.versions.modules}, headers v${config.version} SHA ${config.sha256}, SQLite GC and PTY passed on ${process.platform}/${process.arch}`
    )
} finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true })
}
