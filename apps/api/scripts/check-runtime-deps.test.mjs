import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { checkRuntimeDependencies } from './check-runtime-deps.mjs'
import { prepareRuntimeWorkspace } from './prepare-runtime-workspace.mjs'

const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
        file,
        typeof content === 'string' ? content : JSON.stringify(content)
    )
}
const command = (args, cwd) =>
    new Promise((resolve, reject) => {
        const child = spawn('pnpm', args, {
            cwd,
            env: {
                PATH: process.env.PATH,
                HOME: cwd,
                CI: 'true',
                COREPACK_ENABLE_NETWORK: '0',
                COREPACK_HOME:
                    process.env.COREPACK_HOME ??
                    path.join(
                        process.env.XDG_CACHE_HOME ??
                            path.join(os.homedir(), '.cache'),
                        'node/corepack'
                    )
            }
        })
        let output = ''
        child.stdout.on('data', (data) => {
            output += data
        })
        child.stderr.on('data', (data) => {
            output += data
        })
        child.on('error', reject)
        child.on('close', (code) =>
            code === 0 ? resolve(output) : reject(new Error(output))
        )
    })

test('offline deployment preserves the entire locked graph despite newer cached registry releases', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-deps-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const packages = new Map()
    for (const name of ['fixture-parent', 'fixture-leaf', 'fixture-platform']) {
        for (const version of ['1.0.0', '1.1.0']) {
            const manifest = {
                name,
                version,
                main: 'index.js',
                ...(name === 'fixture-parent'
                    ? {
                          optionalDependencies: {
                              'fixture-leaf': '^1.0.0',
                              'fixture-platform': '^1.0.0'
                          }
                      }
                    : {})
            }
            if (name === 'fixture-platform') manifest.cpu = [`!${process.arch}`]
            const contentDir = path.join(directory, 'tar', name, version)
            write(path.join(contentDir, 'package/package.json'), manifest)
            write(
                path.join(contentDir, 'package/index.js'),
                `module.exports = '${version}'\n`
            )
            const tar = spawnSync('tar', [
                '-czf',
                '-',
                '-C',
                contentDir,
                'package'
            ])
            assert.equal(tar.status, 0, tar.stderr.toString())
            packages.set(`${name}@${version}`, { manifest, tar: tar.stdout })
        }
    }
    let newest = '1.0.0'
    let requests = 0
    const server = http.createServer((request, response) => {
        requests++
        const name = request.url.split('/')[1]
        if (request.url.endsWith('.tgz')) {
            const version = path.basename(request.url, '.tgz')
            response.end(packages.get(`${name}@${version}`).tar)
            return
        }
        const versions = {}
        for (const version of [
            '1.0.0',
            ...(newest === '1.1.0' ? ['1.1.0'] : [])
        ]) {
            const { manifest, tar } = packages.get(`${name}@${version}`)
            versions[version] = {
                ...manifest,
                dist: {
                    tarball: `${registry}${name}/-/${version}.tgz`,
                    integrity: `sha512-${createHash('sha512').update(tar).digest('base64')}`
                }
            }
        }
        response.setHeader('content-type', 'application/json')
        response.end(
            JSON.stringify({ name, 'dist-tags': { latest: newest }, versions })
        )
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const registry = `http://127.0.0.1:${server.address().port}/`
    const workspace = path.join(directory, 'workspace')
    const packageManager = JSON.parse(
        fs.readFileSync(
            new URL('../../../package.json', import.meta.url),
            'utf8'
        )
    ).packageManager
    write(path.join(workspace, 'package.json'), {
        name: 'fixture-root',
        private: true,
        packageManager
    })
    write(
        path.join(workspace, 'pnpm-workspace.yaml'),
        "packages:\n  - 'packages/*'\n"
    )
    write(
        path.join(workspace, '.npmrc'),
        `node-linker=hoisted\nregistry=${registry}\n`
    )
    write(path.join(workspace, 'packages/api/package.json'), {
        name: '@fixture/api',
        version: '1.0.0',
        dependencies: {
            'fixture-parent': '^1.0.0',
            '@fixture/shared': 'workspace:*'
        }
    })
    write(path.join(workspace, 'packages/shared/package.json'), {
        name: '@fixture/shared',
        version: '1.0.0',
        optionalDependencies: { 'fixture-leaf': '^1.0.0' },
        scripts: { prepare: 'exit 42' }
    })
    write(
        path.join(workspace, 'packages/shared/index.js'),
        "module.exports = require('fixture-leaf')\n"
    )
    const options = [
        `--store-dir=${directory}/store`,
        `--cache-dir=${directory}/cache`,
        '--ignore-scripts'
    ]
    await command([...options, 'install'], workspace)
    const expected = JSON.parse(
        await command(
            [
                '--filter-prod',
                '@fixture/api...',
                'list',
                '--prod',
                '--depth',
                'Infinity',
                '--json',
                '--lockfile-only'
            ],
            workspace
        )
    )
    newest = '1.1.0'
    const seed = path.join(directory, 'seed')
    write(path.join(seed, 'package.json'), {
        name: 'cache-newer-release',
        packageManager,
        dependencies: { 'fixture-parent': '1.1.0', 'fixture-leaf': '1.1.0' }
    })
    await command([...options, `--registry=${registry}`, 'install'], seed)
    assert.ok(requests > 0)
    await new Promise((resolve) => server.close(resolve))

    const old = path.join(directory, 'old')
    const oldOutput = await command(
        [
            ...options,
            '--filter',
            '@fixture/api',
            '--prod',
            'deploy',
            '--legacy',
            '--offline',
            old
        ],
        workspace
    )
    assert.match(
        oldOutput,
        /configuration prohibits to read or write a lockfile/
    )
    assert.equal(
        JSON.parse(
            fs.readFileSync(
                path.join(old, 'node_modules/fixture-parent/package.json')
            )
        ).version,
        '1.1.0'
    )
    assert.throws(
        () => checkRuntimeDependencies(expected, '@fixture/api', old),
        /version drift/
    )

    const deployed = path.join(directory, 'deployed')
    prepareRuntimeWorkspace(expected, '@fixture/api', workspace, deployed)
    const result = await command(
        [
            ...options,
            '--config.node-linker=isolated',
            '--filter-prod',
            '@fixture/api...',
            'install',
            '--prod',
            '--frozen-lockfile',
            '--offline'
        ],
        deployed
    )
    assert.doesNotMatch(
        result,
        /configuration prohibits to read or write a lockfile/
    )
    const verified = checkRuntimeDependencies(
        expected,
        '@fixture/api',
        path.join(deployed, 'packages/api'),
        deployed,
        parse(fs.readFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'utf8'))
            .packages
    )
    assert.equal(verified.graph.length, 4)
    assert.ok(verified.graph.every((node) => node.version === '1.0.0'))
    assert.equal(verified.missingOptional.length, 1)
    assert.match(verified.missingOptional[0].reasons[0], /cpu=.*excluded/)
    assert.match(result, /resolution step is skipped/)
    assert.deepEqual(
        fs.readFileSync(path.join(deployed, 'pnpm-lock.yaml')),
        fs.readFileSync(path.join(workspace, 'pnpm-lock.yaml'))
    )
    const execute = spawnSync(
        process.execPath,
        ['-e', "console.log(require('@fixture/shared'))"],
        { cwd: path.join(deployed, 'packages/api'), encoding: 'utf8' }
    )
    assert.equal(execute.status, 0, execute.stderr)
    assert.equal(execute.stdout.trim(), '1.0.0')
    const deployedManifest = path.join(deployed, 'packages/api/package.json')
    const originalManifest = fs.readFileSync(deployedManifest, 'utf8')
    const changed = JSON.parse(originalManifest)
    changed.dependencies['fixture-parent'] = '^2.0.0'
    write(deployedManifest, changed)
    await assert.rejects(
        command(
            [
                ...options,
                '--config.node-linker=isolated',
                '--filter-prod',
                '@fixture/api...',
                'install',
                '--prod',
                '--frozen-lockfile',
                '--offline'
            ],
            deployed
        ),
        /ERR_PNPM_OUTDATED_LOCKFILE/
    )
    write(deployedManifest, originalManifest)

    // Verify the transitive consumer's resolution even when its own direct
    // package version still matches the lock.
    const parentPath = fs.realpathSync(
        path.join(deployed, 'packages/api/node_modules/fixture-parent')
    )
    const leafLink = path.join(path.dirname(parentPath), 'fixture-leaf')
    const leafDirectory = fs.realpathSync(leafLink)
    fs.renameSync(leafDirectory, `${leafDirectory}-missing`)
    assert.throws(
        () =>
            checkRuntimeDependencies(
                expected,
                '@fixture/api',
                path.join(deployed, 'packages/api'),
                deployed
            ),
        /missing platform-compatible optional dependency fixture-leaf/
    )
    fs.renameSync(`${leafDirectory}-missing`, leafDirectory)
    fs.renameSync(parentPath, `${parentPath}-missing`)
    assert.throws(
        () =>
            checkRuntimeDependencies(
                expected,
                '@fixture/api',
                path.join(deployed, 'packages/api'),
                deployed
            ),
        /missing production dependency fixture-parent/
    )
    fs.renameSync(`${parentPath}-missing`, parentPath)
    fs.unlinkSync(leafLink)
    const newer = path.join(deployed, 'newer-leaf')
    fs.cpSync(path.join(old, 'node_modules/fixture-leaf'), newer, {
        recursive: true,
        dereference: true
    })
    fs.symlinkSync(newer, leafLink)
    assert.throws(
        () =>
            checkRuntimeDependencies(
                expected,
                '@fixture/api',
                path.join(deployed, 'packages/api'),
                deployed
            ),
        /version drift/
    )
})

test('the API image executes the frozen install and full graph check without network', () => {
    const dockerfile = fs.readFileSync(
        new URL('../Dockerfile', import.meta.url),
        'utf8'
    )
    assert.match(
        dockerfile,
        /RUN --network=none[^\n]*\\\n\s*node scripts\/prepare-runtime-workspace\.mjs/
    )
    assert.match(
        dockerfile,
        /pnpm --dir \/pruned --config\.node-linker=isolated --filter-prod '@manyfold\/api\.\.\.' install --prod --frozen-lockfile --offline/
    )
    assert.match(
        dockerfile,
        /check-runtime-deps\.mjs \/locked-runtime-graph\.json @manyfold\/api \/pruned\/apps\/api \/pruned/
    )
})
